#!/usr/bin/env node
// Integration test for HARD GATE G9 — CONCURRENT-SPAWN ISOLATION — against the
// REAL claude-p binary. Representative of S14 (nested same-provider main+main):
// a claude-bridge parent parked on a tool while a claude-bridge child runs
// concurrently. Here we model that as N claude-p subprocesses spawned AT ONCE,
// each with its OWN createRouter (own unix socket), own BUILT shim (own
// --mcp-config), and own bridged tool. Each spawn's onPark holds the call open
// ~HOLD_MS so the holds OVERLAP — both/all spawns are parked concurrently.
//
//   G9 (2-way isolation, E1): two concurrent main spawns, A and B. A has a tool
//       `alpha` returning sentinel AAA; B has `beta` returning BBB. ASSERT each
//       spawn's model reports ITS OWN sentinel (A->AAA, B->BBB) with no
//       cross-wiring, the two routers/sockets are distinct and each shim
//       connected only to its own router, and both complete stopReason:result.
//
//   E2 (contention probe): repeat at 3 (and optionally 4) concurrent spawns to
//       characterize claude-p 0.1.0 SessionStart/Stop-timeout flakiness under
//       contention. Records failure rate per concurrency level and classifies
//       whether each failure is the RETRIABLE kind the D33 resilience layer
//       (bounded retry-respawn, gated on !router.everRoutedToolCall) handles.
//
// This spawns REAL claude-p + claude processes. Gated behind RUN_REAL_CLAUDE_P
// so it does not run in the default `node --test` sweep. Run explicitly:
//   RUN_REAL_CLAUDE_P=1 node --test tests/int-claude-p-concurrent.mjs
//
// Env knobs:
//   G9_E1_REPEATS   how many times to run the 2-way isolation case (default 3)
//   G9_E2_LEVELS    comma list of concurrency levels for the contention probe (default "2,3")
//   G9_E2_REPEATS   runs per contention level (default 3)
//   G9_HOLD_MS      onPark hold duration so holds overlap (default 2000)

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

import { createRouter } from "../src/mcp/router.js";
import { buildClaudePArgs } from "../src/driver/claudeP.js";
import { ClaudePStreamParser } from "../src/driver/stream.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const SHIM = join(REPO, "dist", "src", "mcp", "shim.js");
const CLAUDE_P_BIN = join(REPO, "node_modules", ".bin", "claude-p");
const NOTES_DIR = join(REPO, ".test-output", "claude-p-gate");
const RESULTS_MD = join(NOTES_DIR, "g9-concurrent-results.md");
const CALL_LOG = join(NOTES_DIR, "g9-concurrent-call-log.txt");
const E1_STREAM_A = join(NOTES_DIR, "g9-e1-spawnA-stream.jsonl");
const E1_STREAM_B = join(NOTES_DIR, "g9-e1-spawnB-stream.jsonl");

const ENABLED = process.env.RUN_REAL_CLAUDE_P === "1";
const E1_REPEATS = Number(process.env.G9_E1_REPEATS ?? "3");
const E2_LEVELS = (process.env.G9_E2_LEVELS ?? "2,3").split(",").map((s) => Number(s.trim())).filter(Boolean);
const E2_REPEATS = Number(process.env.G9_E2_REPEATS ?? "3");
const HOLD_MS = Number(process.env.G9_HOLD_MS ?? "2000");
const MODEL = "claude-haiku-4-5";
const TIMEOUT_SECONDS = 180;

const log = [];
function note(line) {
	log.push(line);
}
function nowIso() {
	return new Date().toISOString();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Build a single bridged tool that returns a unique sentinel. Each spawn gets
// its OWN tool name + sentinel so cross-talk would be detectable.
function makeTool(toolName) {
	return {
		name: `mcp__custom-tools__${toolName}`,
		description: `The ${toolName} tool. Call it with no arguments; it returns a secret code string.`,
		inputSchema: { type: "object", properties: {}, required: [] },
	};
}

function makePrompt(toolName) {
	return (
		`You have exactly one tool: mcp__custom-tools__${toolName}. ` +
		`Call it once with no arguments. It will return a secret code string. ` +
		`Then report EXACTLY what it returned, verbatim, and stop. ` +
		`Do not call any other tool.`
	);
}

// Run ONE fully-isolated held spawn. Owns its router (unique socket), shim
// config, tool + sentinel. onPark holds the call open `holdMs` (so concurrent
// spawns overlap) then delivers THIS spawn's sentinel. Returns rich diagnostics.
async function runIsolatedSpawn({ label, toolName, sentinel, holdMs, attemptTag }) {
	const tool = makeTool(toolName);
	const expectedRouterCalls = []; // names this router actually saw
	const router = createRouter({
		onPark: (info) => {
			expectedRouterCalls.push(info.name);
			note(
				`[${attemptTag}][${label}] PARK ${nowIso()} socket=${router.socketPath.split("/").pop()} ` +
					`piId=${info.piId} name=${info.name}`,
			);
			// Hold the call open so concurrent spawns are parked at the same time,
			// THEN deliver this spawn's own sentinel. Async hold keeps claude-p
			// blocked inline on the shim the whole time.
			setTimeout(() => {
				note(`[${attemptTag}][${label}] DELIVER ${nowIso()} piId=${info.piId} -> ${JSON.stringify(sentinel)}`);
				router.deliver(info.piId, { content: [{ type: "text", text: sentinel }] });
			}, holdMs);
		},
	});
	router.declareTools([tool]);
	await router.start();

	const toolsB64 = Buffer.from(JSON.stringify([tool]), "utf-8").toString("base64");
	const mcpConfig = JSON.stringify({
		mcpServers: {
			"custom-tools": {
				command: process.execPath,
				args: [SHIM, "--socket", router.socketPath, "--mode", "main", "--tools", toolsB64],
			},
		},
	});

	const cfg = {
		model: MODEL,
		systemPrompt: { kind: "text", text: "You are a tool-calling test agent. Follow the user's instructions precisely." },
		prompt: { kind: "positional", text: makePrompt(toolName) },
		mcpConfig,
		session: { kind: "fresh", sessionId: randomUUID() },
	};
	const args = buildClaudePArgs(cfg);

	const rawChunks = [];
	const driverEvents = [];
	let sawResult = false;
	let firstEventAt = null;
	const parser = new ClaudePStreamParser({
		logger: { warn() {} },
		onEvent: (e) => {
			if (firstEventAt === null) firstEventAt = Date.now();
			driverEvents.push(e);
			if (e.kind === "done" && e.reason === "result") sawResult = true;
		},
	});

	const spawnedAt = Date.now();
	const child = spawn(CLAUDE_P_BIN, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		rawChunks.push(chunk);
		parser.write(chunk);
	});
	const stderrChunks = [];
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (c) => stderrChunks.push(c));

	const exit = await new Promise((res) => {
		child.on("close", (code, signal) => res({ code, signal }));
		child.on("error", (err) => res({ code: null, signal: null, err }));
	});
	parser.endOfStream({ aborted: false, exitInfo: { code: exit.code, signal: exit.signal } });
	const wallMs = Date.now() - spawnedAt;
	const firstEventMs = firstEventAt ? firstEventAt - spawnedAt : null;

	const parked = router.listParkedCalls();
	const everRouted = router.everRoutedToolCall;
	await router.stop().catch(() => {});

	// What sentinel(s) did the model report? Scan assistant text deltas.
	const reportedText = driverEvents
		.filter((e) => e.kind === "text-delta" && typeof e.text === "string")
		.map((e) => e.text)
		.join("\n");

	const stderr = stderrChunks.join("");
	const stopReason = sawResult ? "result" : exit.err ? "spawn-error" : "error";

	return {
		label,
		toolName,
		sentinel,
		socketPath: router.socketPath,
		stopReason,
		ok: stopReason === "result",
		exitCode: exit.code,
		signal: exit.signal,
		err: exit.err?.message,
		routerCallNames: expectedRouterCalls, // names THIS router saw
		everRouted,
		parkedLeftover: parked.length,
		reportedText,
		raw: rawChunks.join(""),
		stderr,
		wallMs,
		firstEventMs,
		driverEvents,
	};
}

// Classify a failed spawn's retriability per D33: a failure is RETRIABLE iff it
// is a premature error/timeout where NO tools/call was routed to pi yet
// (router.everRoutedToolCall === false) — i.e. no side effect could have run, so
// a cold respawn is safe. exit != 0 / no result with everRouted=false qualifies.
function classifyRetriable(r) {
	if (r.ok) return "n/a (clean)";
	if (r.everRouted) return "NOT retriable (a tools/call was routed — side-effect risk; D33 forbids respawn)";
	// No tool routed: premature error before any tool round → the retriable kind.
	const reason = r.err ? `spawn-error(${r.err})` : `exit=${r.exitCode} signal=${r.signal} no-result`;
	return `RETRIABLE (no tools/call routed; ${reason})`;
}

describe("G9: real claude-p CONCURRENT-spawn isolation", { skip: !ENABLED ? "set RUN_REAL_CLAUDE_P=1 to run" : false }, () => {
	it("E1: two concurrent main spawns stay fully isolated (own router/socket/shim/tool; correct sentinels)", async () => {
		mkdirSync(NOTES_DIR, { recursive: true });
		assert.ok(existsSync(SHIM), `built shim missing at ${SHIM} — run npm run build`);
		assert.ok(existsSync(CLAUDE_P_BIN), `claude-p binary missing at ${CLAUDE_P_BIN}`);

		const SENT_A = "AAA-7f3c1d";
		const SENT_B = "BBB-9a2e84";

		let pass = null;
		const e1Attempts = [];
		for (let attempt = 1; attempt <= E1_REPEATS; attempt++) {
			const tag = `E1#${attempt}`;
			note(`===== ${tag} START ${nowIso()} (HOLD_MS=${HOLD_MS}) =====`);
			// Spawn BOTH at once; holds overlap so both are parked concurrently.
			const [a, b] = await Promise.all([
				runIsolatedSpawn({ label: "A", toolName: "alpha", sentinel: SENT_A, holdMs: HOLD_MS, attemptTag: tag }),
				runIsolatedSpawn({ label: "B", toolName: "beta", sentinel: SENT_B, holdMs: HOLD_MS, attemptTag: tag }),
			]);
			const rec = {
				attempt,
				A: { ok: a.ok, stopReason: a.stopReason, exit: a.exitCode, wallMs: a.wallMs, firstEventMs: a.firstEventMs, socket: a.socketPath.split("/").pop() },
				B: { ok: b.ok, stopReason: b.stopReason, exit: b.exitCode, wallMs: b.wallMs, firstEventMs: b.firstEventMs, socket: b.socketPath.split("/").pop() },
			};
			e1Attempts.push(rec);
			note(`===== ${tag} END ${JSON.stringify(rec)} =====`);

			if (a.ok && b.ok) {
				// ── ISOLATION ASSERTIONS (the G9 point) ──────────────────────────
				// 1. Distinct sockets.
				assert.notEqual(a.socketPath, b.socketPath, "the two routers listen on DISTINCT sockets");
				// 2. Each router saw ONLY its own tool — no cross-talk on the wire.
				assert.ok(a.routerCallNames.every((n) => n.endsWith("__alpha")), `router A saw only alpha; saw ${JSON.stringify(a.routerCallNames)}`);
				assert.ok(b.routerCallNames.every((n) => n.endsWith("__beta")), `router B saw only beta; saw ${JSON.stringify(b.routerCallNames)}`);
				assert.ok(!a.routerCallNames.some((n) => n.endsWith("__beta")), "router A NEVER saw spawn B's beta call");
				assert.ok(!b.routerCallNames.some((n) => n.endsWith("__alpha")), "router B NEVER saw spawn A's alpha call");
				// 3. Each model reported ITS OWN sentinel and NOT the other's.
				assert.ok(a.reportedText.includes(SENT_A), `spawn A model reports its own sentinel ${SENT_A}; got: ${a.reportedText.slice(0, 200)}`);
				assert.ok(b.reportedText.includes(SENT_B), `spawn B model reports its own sentinel ${SENT_B}; got: ${b.reportedText.slice(0, 200)}`);
				assert.ok(!a.reportedText.includes(SENT_B), `spawn A must NOT report B's sentinel ${SENT_B} (cross-wiring)`);
				assert.ok(!b.reportedText.includes(SENT_A), `spawn B must NOT report A's sentinel ${SENT_A} (cross-wiring)`);
				// 4. Both completed with stopReason result.
				assert.equal(a.stopReason, "result");
				assert.equal(b.stopReason, "result");
				// 5. Each router routed exactly one tool call.
				assert.equal(a.routerCallNames.length, 1, "router A routed exactly one tool call");
				assert.equal(b.routerCallNames.length, 1, "router B routed exactly one tool call");

				writeFileSync(E1_STREAM_A, a.raw, "utf8");
				writeFileSync(E1_STREAM_B, b.raw, "utf8");
				pass = { a, b };
				break;
			}
		}

		note("");
		note("==== E1 ATTEMPT SUMMARY ====");
		for (const a of e1Attempts) note(JSON.stringify(a));
		writeFileSync(CALL_LOG, log.join("\n") + "\n", "utf8");

		assert.ok(pass, `E1: no clean 2-way concurrent capture in ${E1_REPEATS} attempts; see ${CALL_LOG}`);
	});

	it("E2: contention probe at multiple concurrency levels (reliability/failure-mode characterization)", async () => {
		mkdirSync(NOTES_DIR, { recursive: true });
		const sentinelFor = (i) => `S${i}-${randomUUID().slice(0, 6)}`;
		const toolFor = (i) => `tool${i}`;

		const table = []; // { level, runs, passes, fails, failureModes:[] }
		for (const level of E2_LEVELS) {
			let passes = 0;
			const failures = [];
			for (let run = 1; run <= E2_REPEATS; run++) {
				const tag = `E2-L${level}#${run}`;
				note(`===== ${tag} START ${nowIso()} =====`);
				const specs = Array.from({ length: level }, (_, i) => ({
					label: `${i}`,
					toolName: toolFor(i),
					sentinel: sentinelFor(i),
					holdMs: HOLD_MS,
					attemptTag: tag,
				}));
				const results = await Promise.all(specs.map((s) => runIsolatedSpawn(s)));
				const allOk = results.every((r) => r.ok);
				// Also require per-result isolation correctness (own sentinel reported).
				const isolationOk = results.every((r) => r.reportedText.includes(r.sentinel));
				if (allOk && isolationOk) {
					passes++;
				} else {
					for (const r of results.filter((x) => !x.ok || !x.reportedText.includes(x.sentinel))) {
						failures.push({
							run,
							label: r.label,
							stopReason: r.stopReason,
							exit: r.exitCode,
							signal: r.signal,
							everRouted: r.everRouted,
							isolationOk: r.reportedText.includes(r.sentinel),
							retriable: classifyRetriable(r),
							stderrHead: r.stderr.replace(/\n/g, " ").slice(0, 240),
						});
					}
				}
				note(`===== ${tag} END allOk=${allOk} isolationOk=${isolationOk} =====`);
			}
			table.push({ level, runs: E2_REPEATS, passes, fails: E2_REPEATS - passes, failureRate: `${E2_REPEATS - passes}/${E2_REPEATS}`, failures });
		}

		note("");
		note("==== E2 CONTENTION TABLE ====");
		for (const row of table) note(JSON.stringify(row, null, 2));
		writeFileSync(CALL_LOG, log.join("\n") + "\n", "utf8");

		// Build the results markdown handoff.
		const md = [];
		md.push("# G9 contention probe — concurrency failure-rate table");
		md.push("");
		md.push(`Date: ${nowIso()} · HOLD_MS=${HOLD_MS} · repeats/level=${E2_REPEATS} · model=${MODEL}`);
		md.push("");
		md.push("| concurrency | runs | passes | fails | failure rate |");
		md.push("|------------:|-----:|-------:|------:|:------------|");
		for (const row of table) md.push(`| ${row.level} | ${row.runs} | ${row.passes} | ${row.fails} | ${row.failureRate} |`);
		md.push("");
		md.push("## Failure modes");
		for (const row of table) {
			if (row.failures.length === 0) {
				md.push(`- level ${row.level}: no failures`);
				continue;
			}
			md.push(`- level ${row.level}:`);
			for (const f of row.failures) {
				md.push(`  - run ${f.run} spawn ${f.label}: stopReason=${f.stopReason} exit=${f.exit} signal=${f.signal} everRouted=${f.everRouted} isolationOk=${f.isolationOk}`);
				md.push(`    - D33: ${f.retriable}`);
				if (f.stderrHead) md.push(`    - stderr: ${f.stderrHead}`);
			}
		}
		writeFileSync(RESULTS_MD, md.join("\n") + "\n", "utf8");

		// This test CHARACTERIZES contention; it does not hard-fail on contention
		// failures (that IS the finding). It only fails if NO level produced any
		// clean run at all (would mean the harness itself is broken).
		const anyClean = table.some((r) => r.passes > 0);
		assert.ok(anyClean, `E2: no concurrency level produced a single clean run — harness/env broken? see ${CALL_LOG}`);
	});
});
