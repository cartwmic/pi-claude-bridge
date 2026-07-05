#!/usr/bin/env node
// tests/int-claude-p-latency-bench.mjs  (task T4.6 — cold-boot + per-turn latency)
//
// A BENCHMARK / AUDIT, not a strict pass/fail gate. It measures, against the REAL
// claude-p driver (src/driver/claudeP.ts spawnClaudeP), two wall-clock numbers per
// turn —
//
//   * spawn→first-stream-event : ms from spawnClaudeP() to the first observable
//                                model event (text/thinking delta, tool-use, or
//                                usage). This is the user-perceived "time to first
//                                token" and is dominated by the claude-p
//                                interactive-PTY boot + child `claude` startup.
//   * full-turn wall-clock      : ms from spawnClaudeP() until `done` resolves
//                                (terminal `result`).
//
// across two regimes:
//   * COLD : a brand-new --session-id each run (full interactive boot every time).
//   * WARM : a --resume of a previously-booted session (re-echo suppressed, the
//            way the bridge drives warm turns) — measures the steady-state per-turn
//            cost once the session exists.
//
// Reports median + p99 for each (regime × metric). Retries flaky turns (claude-p
// 0.1.0 intermittently emits a premature StopTimeout / empty turn) up to RETRIES
// times per run and REPORTS how many retries were consumed. The numbers are
// printed to the test log + summarized; the only hard assertion is that we managed
// to collect at least one good sample per regime (so a totally-broken driver still
// fails loudly), NOT a latency threshold.
//
// GATING: skipped entirely unless RUN_REAL_CLAUDE_P=1. Concurrency 1. Does NOT
// override CLAUDE_CONFIG_DIR / HOME. Uses model claude-haiku-4-5 (cheapest/fastest)
// and an EMPTY --mcp-config (no shim/router) so the measurement isolates the
// claude-p boot + claude turn cost; the MCP-server-startup increment the real
// bridge adds on top is a separate, fixed cost (see note in the summary).

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import { spawnClaudeP } from "../src/driver/claudeP.js";

const RUN_REAL = process.env.RUN_REAL_CLAUDE_P === "1";
const N = Number(process.env.BENCH_N || 6); // runs per regime (5–8 recommended)
const RETRIES = 3; // per-run flaky-turn retries (claude-p 0.1.0 is intermittently flaky)
const MODEL = process.env.BENCH_MODEL || "claude-haiku-4-5";
const TURN_TIMEOUT_MS = 120_000;
const QUIET = { warn() {}, info() {}, error() {} };

const req = createRequire(import.meta.url);
function resolveBin() {
	try {
		return req.resolve("claude-p/bin/claude-p.js");
	} catch {
		return "claude-p";
	}
}

// Run ONE claude-p turn at the driver level. Returns
// { ok, stopReason, firstEventMs, totalMs }. `ok` is true only on a clean
// `result` with a first event observed. Never throws (a turn timeout resolves ok:false).
function runTurn(bin, session, prompt, suppressResumeReplay) {
	return new Promise((resolve) => {
		const t0 = Date.now();
		let firstAt = null;
		let settled = false;
		const finish = (r) => {
			if (settled) return;
			settled = true;
			resolve(r);
		};
		const handle = spawnClaudeP(
			{
				model: MODEL,
				systemPrompt: { kind: "text", text: "You are a terse assistant. Answer in one word." },
				prompt: { kind: "positional", text: prompt },
				mcpConfig: JSON.stringify({ mcpServers: {} }),
				session,
			},
			{
				binPath: bin,
				suppressResumeReplay,
				logger: QUIET,
				onEvent: (ev) => {
					if (
						firstAt === null &&
						(ev.kind === "text-delta" ||
							ev.kind === "thinking-delta" ||
							ev.kind === "tool-use" ||
							ev.kind === "usage")
					) {
						firstAt = Date.now();
					}
				},
			},
		);
		// Hard guard against a wedged turn (claude-p can hang mid-boot).
		const guard = setTimeout(() => {
			handle.abort();
			finish({ ok: false, stopReason: "timeout", firstEventMs: null, totalMs: Date.now() - t0 });
		}, TURN_TIMEOUT_MS);
		guard.unref?.();
		void handle.done.then((res) => {
			clearTimeout(guard);
			finish({
				ok: res.stopReason === "result" && firstAt !== null,
				stopReason: res.stopReason,
				firstEventMs: firstAt !== null ? firstAt - t0 : null,
				totalMs: Date.now() - t0,
			});
		});
	});
}

// Run a turn with bounded retries; returns the first OK sample (+ retry count) or
// the last failure with retriesUsed exhausted.
async function runTurnWithRetry(bin, session, prompt, suppress) {
	let retriesUsed = 0;
	let last = null;
	for (let attempt = 0; attempt <= RETRIES; attempt++) {
		const r = await runTurn(bin, session, prompt, suppress);
		last = r;
		if (r.ok) return { ...r, retriesUsed };
		retriesUsed = attempt + 1;
	}
	return { ...last, ok: false, retriesUsed };
}

function median(xs) {
	if (xs.length === 0) return null;
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}
// p99 over a small N degenerates to ~max; report the max-ish high percentile.
function p99(xs) {
	if (xs.length === 0) return null;
	const s = [...xs].sort((a, b) => a - b);
	const idx = Math.min(s.length - 1, Math.ceil(0.99 * s.length) - 1);
	return s[Math.max(0, idx)];
}

describe("claude-p latency benchmark (T4.6)", () => {
	before(function () {
		if (!RUN_REAL) {
			console.log("  SKIP: set RUN_REAL_CLAUDE_P=1 to run the real-claude-p latency benchmark");
			this.skip?.();
		}
	});

	it(
		"measures cold-boot + warm-resume first-event & full-turn latency (median/p99)",
		{ timeout: (N * 2 + 2) * TURN_TIMEOUT_MS, skip: !RUN_REAL },
		async () => {
			const bin = resolveBin();

			const cold = { first: [], total: [], retries: 0, fails: 0 };
			const warm = { first: [], total: [], retries: 0, fails: 0 };

			// COLD: a fresh session per run — full interactive boot each time.
			for (let i = 0; i < N; i++) {
				const r = await runTurnWithRetry(
					bin,
					{ kind: "fresh", sessionId: randomUUID() },
					`Reply with exactly the word READY${i} and nothing else.`,
					false,
				);
				cold.retries += r.retriesUsed;
				if (r.ok) {
					cold.first.push(r.firstEventMs);
					cold.total.push(r.totalMs);
				} else {
					cold.fails++;
					console.log(`  cold run ${i}: FLAKY/failed (stopReason=${r.stopReason}, retries=${r.retriesUsed})`);
				}
			}

			// WARM: boot one session, then --resume it N times (suppressResumeReplay,
			// the way the bridge drives warm turns). Steady-state per-turn cost.
			const warmSid = randomUUID();
			const seed = await runTurnWithRetry(
				bin,
				{ kind: "fresh", sessionId: warmSid },
				"Remember the number 42. Reply with the word OK only.",
				false,
			);
			warm.retries += seed.retriesUsed;
			if (!seed.ok) {
				console.log(`  warm SEED failed (stopReason=${seed.stopReason}) — warm regime degraded`);
			}
			for (let i = 0; i < N; i++) {
				const r = await runTurnWithRetry(
					bin,
					{ kind: "resume", sessionId: warmSid },
					`Reply with exactly the word WARM${i} and nothing else.`,
					true,
				);
				warm.retries += r.retriesUsed;
				if (r.ok) {
					warm.first.push(r.firstEventMs);
					warm.total.push(r.totalMs);
				} else {
					warm.fails++;
					console.log(`  warm run ${i}: FLAKY/failed (stopReason=${r.stopReason}, retries=${r.retriesUsed})`);
				}
			}

			// ── report ──────────────────────────────────────────────────────────────
			const fmt = (n) => (n === null ? "n/a" : `${n}ms`);
			console.log("");
			console.log("=== claude-p latency benchmark (model=" + MODEL + ", N=" + N + " per regime) ===");
			console.log("  regime  metric            median     p99      samples  retries  fails");
			console.log(
				`  COLD    first-event       ${fmt(median(cold.first)).padEnd(9)} ${fmt(p99(cold.first)).padEnd(8)} ${String(cold.first.length).padEnd(8)} ${String(cold.retries).padEnd(8)} ${cold.fails}`,
			);
			console.log(
				`  COLD    full-turn         ${fmt(median(cold.total)).padEnd(9)} ${fmt(p99(cold.total)).padEnd(8)} ${String(cold.total.length).padEnd(8)} -        -`,
			);
			console.log(
				`  WARM    first-event       ${fmt(median(warm.first)).padEnd(9)} ${fmt(p99(warm.first)).padEnd(8)} ${String(warm.first.length).padEnd(8)} ${String(warm.retries).padEnd(8)} ${warm.fails}`,
			);
			console.log(
				`  WARM    full-turn         ${fmt(median(warm.total)).padEnd(9)} ${fmt(p99(warm.total)).padEnd(8)} ${String(warm.total.length).padEnd(8)} -        -`,
			);
			console.log("");
			console.log("  NOTE: the COLD first-event number IS the interactive-boot cost (claude-p");
			console.log("  drives the full TUI in a PTY and boots a child `claude` per spawn); it is");
			console.log("  the floor for time-to-first-token on a fresh pi turn. WARM (--resume) pays");
			console.log("  the same PTY-boot tax (claude-p re-boots per spawn) but skips fresh-session");
			console.log("  setup. This bench uses an EMPTY --mcp-config; the real bridge adds a fixed");
			console.log("  MCP-shim startup increment on top (the shim must connect to the router");
			console.log("  before the first tool round). claude-p 0.1.0 flakiness observed as retries/");
			console.log("  fails above (intermittent StopTimeout / empty turn).");

			// ── ASSERT (benchmark, not a latency gate): we must have collected at least
			//    one good sample per regime, else the driver is broken (not merely slow).
			assert.ok(
				cold.first.length > 0,
				`no successful COLD sample after retries — driver appears broken (fails=${cold.fails}, retries=${cold.retries})`,
			);
			assert.ok(
				warm.first.length > 0,
				`no successful WARM sample after retries — driver/resume appears broken (fails=${warm.fails}, retries=${warm.retries})`,
			);
		},
	);
});
