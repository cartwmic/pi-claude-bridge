#!/usr/bin/env node
// tests/int-capture-termination-bench.mjs  (task T4.8 — capture-termination latency)
//
// A BENCHMARK / AUDIT, not a strict pass/fail gate. It measures, on the REAL
// claude-p forced-toolcall CAPTURE path (src/capture.ts shape, driven here at the
// driver+router level), the latency and token cost of the window between —
//
//   * the FIRST valid capture tool-call : the `tool-use` stream event whose name
//     is the bridged `mcp__<server>__<captureTool>` (the model emitting the forced
//     capture call), AND
//   * end_turn                          : when the spawn's `done` resolves with a
//     capture stash present in the router (the authoritative capture-success
//     signal — src/capture.ts treats a present stash as success).
//
// Reported per run:
//   * capture→end_turn wall-clock (ms)  — how long claude-p takes to wind the turn
//                                          down AFTER the capture tool returned
//                                          "End your turn now."
//   * output tokens at end_turn         — the terminal `result` usage.output (the
//                                          tokens the model spent on the capture
//                                          call + termination), when a clean
//                                          `result` was seen.
// Median + p99 across N runs for each.
//
// FLAKINESS (claude-p 0.1.0 — IMPORTANT, observed dominant): the capture almost
// always SUCCEEDS (stash present + the capture tool-use event fires) yet claude-p
// then HANGS post-tool and exits via StopTimeout (exit 2, stopReason "error", NO
// terminal `result` → no usage). The capture→end_turn TIMING is still fully
// observable on those runs (both the capture tool-use event and `done` are seen),
// so the PRIMARY metric is collected on stash-present runs REGARDLESS of clean vs
// error exit. The token number, however, only exists on a clean `result`, so it
// is collected as a SEPARATE, best-effort sample set — frequently empty under this
// version's flakiness. We RETRY (≤RETRIES) trying to also land a clean result for
// tokens, but we do NOT discard a perfectly good timing sample just because the
// post-capture termination flaked. The hard assertion is only that the capture
// path produced at least one stash (else it is genuinely broken).
//
// GATING: skipped unless RUN_REAL_CLAUDE_P=1. Concurrency 1. Does NOT override
// CLAUDE_CONFIG_DIR / HOME. Model claude-haiku-4-5.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { spawnClaudeP } from "../src/driver/claudeP.js";
import { createRouter } from "../src/mcp/router.js";

const RUN_REAL = process.env.RUN_REAL_CLAUDE_P === "1";
const N = Number(process.env.BENCH_N || 6);
const RETRIES = 3;
const MODEL = process.env.BENCH_MODEL || "claude-haiku-4-5";
const TURN_TIMEOUT_MS = 120_000;
const SERVER = "custom-tools";
const CAPTURE_TOOL = "record_answer";
const QUIET = { warn() {}, info() {}, error() {} };
const QUIET_ROUTER = { debug() {}, info() {}, warn() {}, error() {}, child() { return QUIET_ROUTER; } };

const req = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");

function resolveBin() {
	try {
		return req.resolve("claude-p/bin/claude-p.js");
	} catch {
		return "claude-p";
	}
}
function resolveShim() {
	const dist = join(REPO, "dist/src/mcp/shim.js");
	return existsSync(dist) ? dist : join(REPO, "src/mcp/shim.ts");
}

// Operational MCP-startup-race preamble (same intent as index.ts
// withClaudePMcpWaitPreamble): make the model wait for the async-connecting shim
// before declaring the capture tool unavailable.
const WAIT_PREAMBLE =
	"If your tools are provided by an MCP server that may still be connecting, " +
	"FIRST call WaitForMcpServers and wait for it to finish, THEN proceed.\n\n";

const CAPTURE_SCHEMA = {
	type: "object",
	properties: { answer: { type: "string", description: "the final answer" } },
	required: ["answer"],
};

// Run ONE capture turn. Returns
//   { hadStash, captureSeen, cleanResult, stopReason, captureToEndMs, outputTokens }.
//   * captureToEndMs is valid whenever the capture tool-use event was seen (TIMING).
//   * cleanResult (stash + result + usage) is when the token number is trustworthy.
async function runCaptureTurn(bin, shimPath) {
	const router = createRouter({ logger: QUIET_ROUTER });
	const toolDefs = [
		{ name: CAPTURE_TOOL, description: "Record the final answer to the user's question.", inputSchema: CAPTURE_SCHEMA },
	];
	router.declareTools(toolDefs);
	await router.start();

	const toolsB64 = Buffer.from(JSON.stringify(toolDefs)).toString("base64");
	const mcpConfig = JSON.stringify({
		mcpServers: {
			[SERVER]: {
				command: process.execPath,
				args: [shimPath, "--socket", router.socketPath, "--mode", "capture", "--capture-tool", CAPTURE_TOOL, "--tools", toolsB64],
			},
		},
	});

	const cfg = {
		model: MODEL,
		systemPrompt: {
			kind: "text",
			text:
				WAIT_PREAMBLE +
				`You must call the ${CAPTURE_TOOL} tool exactly once with the answer to the ` +
				`user's question, then end your turn. Do not output any other text.`,
		},
		prompt: { kind: "positional", text: "What is two plus two? Record the answer." },
		mcpConfig,
		session: { kind: "fresh", sessionId: randomUUID() },
		timeoutSeconds: 120,
	};

	const t0 = Date.now();
	const prefixedName = `mcp__${SERVER}__${CAPTURE_TOOL}`;
	let captureAt = null;
	let usage = null;

	const handle = spawnClaudeP(cfg, {
		binPath: bin,
		logger: QUIET,
		onEvent: (ev) => {
			if (ev.kind === "tool-use" && ev.name === prefixedName && captureAt === null) {
				captureAt = Date.now();
			}
			if (ev.kind === "usage") usage = ev.usage;
		},
	});

	let timedOut = false;
	const guard = setTimeout(() => {
		timedOut = true;
		handle.abort();
	}, TURN_TIMEOUT_MS);
	guard.unref?.();

	const res = await handle.done;
	clearTimeout(guard);
	const endAt = Date.now();
	const hadStash = router.getCaptureStash() !== undefined;
	await router.stop().catch(() => {});

	const captureSeen = captureAt !== null;
	const cleanResult = hadStash && res.stopReason === "result" && captureSeen && usage !== null && !timedOut;
	return {
		hadStash,
		captureSeen,
		cleanResult,
		stopReason: timedOut ? "timeout" : res.stopReason,
		captureToEndMs: captureSeen ? endAt - captureAt : null,
		outputTokens: usage ? usage.output : null,
	};
}

// Retry to TRY to land a clean result (for the token number), but accept a
// timing-only sample. Returns the best run seen: a cleanResult if any was hit,
// else the last run that at least had a stash+capture (timing-valid), else last.
async function runCaptureWithRetry(bin, shimPath) {
	let retriesUsed = 0;
	let best = null;
	for (let attempt = 0; attempt <= RETRIES; attempt++) {
		const r = await runCaptureTurn(bin, shimPath);
		if (r.cleanResult) return { ...r, retriesUsed };
		// Prefer a timing-valid (stash + capture) run over a totally-failed one.
		if (best === null || (r.hadStash && r.captureSeen && !(best.hadStash && best.captureSeen))) {
			best = r;
		}
		retriesUsed = attempt + 1;
	}
	return { ...best, retriesUsed };
}

function median(xs) {
	if (xs.length === 0) return null;
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}
function p99(xs) {
	if (xs.length === 0) return null;
	const s = [...xs].sort((a, b) => a - b);
	const idx = Math.min(s.length - 1, Math.ceil(0.99 * s.length) - 1);
	return s[Math.max(0, idx)];
}

describe("claude-p capture-termination benchmark (T4.8)", () => {
	before(function () {
		if (!RUN_REAL) {
			console.log("  SKIP: set RUN_REAL_CLAUDE_P=1 to run the real-claude-p capture-termination benchmark");
			this.skip?.();
		}
	});

	it(
		"measures capture-tool-call → end_turn latency + token cost (median/p99)",
		{ timeout: (N + 2) * (RETRIES + 1) * TURN_TIMEOUT_MS, skip: !RUN_REAL },
		async () => {
			const bin = resolveBin();
			const shimPath = resolveShim();

			const ms = []; // capture->end_turn timing (stash+capture seen; clean OR error exit)
			const tokens = []; // output tokens (clean result only)
			let retries = 0;
			let noStash = 0; // capture genuinely failed (no stash) — the only real failure
			let stashButNoResult = 0; // capture succeeded but claude-p StopTimeout'd post-tool
			let clean = 0;

			for (let i = 0; i < N; i++) {
				const r = await runCaptureWithRetry(bin, shimPath);
				retries += r.retriesUsed;
				if (r.captureSeen && r.hadStash && r.captureToEndMs !== null) {
					ms.push(r.captureToEndMs); // TIMING valid even on a post-capture error-exit
				}
				if (r.cleanResult) {
					tokens.push(r.outputTokens);
					clean++;
				} else if (r.hadStash) {
					stashButNoResult++;
				} else {
					noStash++;
				}
				console.log(
					`  run ${i}: stopReason=${r.stopReason} hadStash=${r.hadStash} captureSeen=${r.captureSeen} ` +
						`cap->end=${r.captureToEndMs ?? "n/a"}ms outTok=${r.outputTokens ?? "n/a"} retries=${r.retriesUsed}`,
				);
			}

			const fmt = (n) => (n === null ? "n/a" : `${n}`);
			console.log("");
			console.log("=== claude-p capture-termination benchmark (model=" + MODEL + ", N=" + N + ") ===");
			console.log("  metric                       median     p99       samples");
			console.log(`  capture->end_turn (ms)       ${fmt(median(ms)).padEnd(9)} ${fmt(p99(ms)).padEnd(9)} ${ms.length}`);
			console.log(`  output tokens at end_turn    ${fmt(median(tokens)).padEnd(9)} ${fmt(p99(tokens)).padEnd(9)} ${tokens.length}`);
			console.log("");
			console.log(`  retries consumed: ${retries}   clean-result runs: ${clean}   ` +
				`stash-but-no-result (flaky): ${stashButNoResult}   no-stash (real fail): ${noStash}`);
			console.log("  NOTE: 'capture->end_turn' is the wall-clock from the model's forced capture");
			console.log("  tool-call (the mcp__custom-tools__ tool-use stream event) to the spawn's done.");
			console.log("  claude-p 0.1.0 ALMOST ALWAYS stashes the capture successfully but then HANGS");
			console.log("  post-tool and exits via StopTimeout (exit 2, no terminal result → no usage),");
			console.log("  which is the dominant outcome here (see stash-but-no-result above). The TIMING");
			console.log("  is still observable on those runs, so it is collected regardless; the token");
			console.log("  number requires a clean result and is therefore a sparse, best-effort sample.");
			console.log("  The real capture path (src/capture.ts) treats a present stash as SUCCESS even");
			console.log("  on the error-exit, so the user-visible capture IS delivered in all stash runs.");

			// ASSERT (benchmark, not a latency/flakiness gate): the capture path must
			// produce at least one TIMING sample (stash + capture-tool-use seen). If it
			// never even stashed, the capture path is genuinely broken — that fails.
			// A high stash-but-no-result count is EXPECTED flakiness, not a failure.
			assert.ok(
				ms.length > 0,
				`no capture sample with a stash+capture-tool-use after retries — capture path appears broken ` +
					`(noStash=${noStash}, stashButNoResult=${stashButNoResult}, retries=${retries})`,
			);
			if (tokens.length === 0) {
				console.log("  (token median/p99 unavailable this run — every capture flaked post-stash; timing still reported.)");
			}
		},
	);
});
