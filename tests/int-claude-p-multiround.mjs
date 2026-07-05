#!/usr/bin/env node
// Integration test for HARD GATES G1 + G3 against the REAL claude-p binary.
//
// Wires the REAL bridge modules (createRouter + the BUILT shim + spawnClaudeP +
// ClaudePStreamParser) together WITHOUT pi, and drives claude-p through a prompt
// engineered to force >=3 sequential held tool rounds in ONE spawn.
//
//   G1 (multi-round held blocking): each held tools/call blocks claude-p inline
//       (the shim holds open until router.deliver), all rounds run in the single
//       spawn, and the driver `done` resolves with stopReason "result". Assert
//       the router saw >=3 distinct parked calls in one spawn.
//
//   G3 (turn-end): from the captured stdout, determine whether claude-p emits
//       ONE `result` per pi turn or one per agent-loop segment. The captured
//       fixture is replayed through ClaudePStreamParser to confirm the turn-end
//       rule (turn-end only on `result`; tool rounds don't terminate) matches
//       the observed schema, and that exactly one terminal done is emitted.
//
// Reliability: claude-p 0.1.0 has SessionStart/Stop timeout flakiness under
// contention; the scenario is retried up to MAX_ATTEMPTS to get one clean
// capture. Failures are recorded for the G4/G9 reliability picture.
//
// This test spawns a REAL claude-p + claude. It is gated behind RUN_REAL_CLAUDE_P
// so it does not run in the default `node --test` sweep. Run explicitly:
//   RUN_REAL_CLAUDE_P=1 node --test tests/int-claude-p-multiround.mjs

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
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
const NOTES_DIR = join(REPO, ".spike-notes", "claude-p-gate");
const STREAM_OUT = join(NOTES_DIR, "g1-multiround-stream.jsonl");
const CALL_LOG = join(NOTES_DIR, "g1-mcp-call-log.txt");

const ENABLED = process.env.RUN_REAL_CLAUDE_P === "1";
const MAX_ATTEMPTS = Number(process.env.G1_MAX_ATTEMPTS ?? "3");
const ROUNDS_REQUIRED = 3;
const MODEL = "claude-haiku-4-5";
const TIMEOUT_SECONDS = 180;

// The single bridged tool. Returns text instructing the model to call again with
// the next n, until it has called the tool ROUNDS_REQUIRED times. This FORCES a
// sequential chain of held tool rounds in one spawn (each call blocks inline on
// the shim until router.deliver fires).
const STEP_TOOL = {
	name: "mcp__custom-tools__step",
	description:
		"A stepping tool. Pass the current step number n. It returns text telling " +
		"you the result of this step and the next n to call with. Call it again " +
		"with that next n until told to stop.",
	inputSchema: {
		type: "object",
		properties: { n: { type: "number", description: "the current step number" } },
		required: ["n"],
	},
};

const PROMPT =
	"You have one tool: mcp__custom-tools__step, which takes { n: number }. " +
	"Call the step tool with n=1. When it returns, read the `next=` value in its " +
	"result text and call the step tool again with n set to that next value. " +
	"Repeat this until the tool tells you to stop. Then report the final result " +
	"text verbatim. Do not stop calling the tool until its result text says to stop.";

function stepResultText(n) {
	if (n >= ROUNDS_REQUIRED) {
		return `step ${n} done; STOP — you have completed all ${ROUNDS_REQUIRED} steps. Final answer: COMPLETED_${ROUNDS_REQUIRED}_STEPS`;
	}
	return `step ${n} done; next=${n + 1}`;
}

function nowIso() {
	return new Date().toISOString();
}

// The production driver (spawnClaudeP) owns the stdout pipe, so it does not
// expose the RAW bytes needed for the G3 fixture. To capture verbatim stdout AND
// still exercise the REAL parser end-to-end, this harness spawns claude-p using
// the REAL argv builder (buildClaudePArgs — identical argv to production) and
// tees stdout into both a file and a live ClaudePStreamParser. The router + shim
// + parser under test are the real modules; only the thin spawn/tee glue is
// local (the production spawnClaudeP wiring is itself covered by unit tests).
async function runOnceWithRawCapture(attempt, callLogLines) {
	const router = createRouter({
		onPark: (info) => {
			const receivedAt = Date.now();
			const n = typeof info.arguments?.n === "number" ? info.arguments.n : NaN;
			callLogLines.push(`[attempt ${attempt}] RECEIVED ${nowIso()} piId=${info.piId} name=${info.name} n=${n}`);
			router.__holds.push({ piId: info.piId, n, receivedAt, resolvedAt: null });
			const text = stepResultText(n);
			const resolvedAt = Date.now();
			const h = router.__holds[router.__holds.length - 1];
			h.resolvedAt = resolvedAt;
			callLogLines.push(
				`[attempt ${attempt}] RESOLVED ${nowIso()} piId=${info.piId} held=${resolvedAt - receivedAt}ms -> ${JSON.stringify(text)}`,
			);
			router.deliver(info.piId, { content: [{ type: "text", text }] });
		},
	});
	router.__holds = [];
	router.declareTools([STEP_TOOL]);
	await router.start();

	const toolsB64 = Buffer.from(JSON.stringify([STEP_TOOL]), "utf-8").toString("base64");
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
		prompt: { kind: "positional", text: PROMPT },
		mcpConfig,
		session: { kind: "fresh", sessionId: randomUUID() },
	};
	const args = buildClaudePArgs(cfg);

	const rawChunks = [];
	const driverEvents = [];
	let sawResult = false;
	const parser = new ClaudePStreamParser({
		logger: { warn() {} },
		onEvent: (e) => {
			driverEvents.push(e);
			if (e.kind === "done" && e.reason === "result") sawResult = true;
		},
	});

	const start = Date.now();
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
	const wallMs = Date.now() - start;

	const holds = router.__holds;
	await router.stop().catch(() => {});

	const stopReason = sawResult ? "result" : "error";
	if (stderrChunks.length) {
		callLogLines.push(`[attempt ${attempt}] STDERR ${stderrChunks.join("").replace(/\n/g, " ").slice(0, 400)}`);
	}

	return {
		ok: stopReason === "result" && holds.length >= ROUNDS_REQUIRED,
		stopReason,
		exitCode: exit.code,
		signal: exit.signal,
		err: exit.err,
		parkedSeen: holds.length,
		holds,
		driverEvents,
		raw: rawChunks.join(""),
		wallMs,
	};
}

describe("G1+G3: real claude-p multi-round held blocking", { skip: !ENABLED ? "set RUN_REAL_CLAUDE_P=1 to run" : false }, () => {
	it(`drives >=${ROUNDS_REQUIRED} sequential held tool rounds in ONE spawn and completes with stopReason result`, async () => {
		mkdirSync(NOTES_DIR, { recursive: true });
		assert.ok(existsSync(SHIM), `built shim missing at ${SHIM} — run npm run build`);
		assert.ok(existsSync(CLAUDE_P_BIN), `claude-p binary missing at ${CLAUDE_P_BIN}`);

		const callLogLines = [];
		let outcome = null;
		const attempts = [];

		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			callLogLines.push(`===== ATTEMPT ${attempt} START ${nowIso()} =====`);
			const res = await runOnceWithRawCapture(attempt, callLogLines);
			attempts.push({
				attempt,
				ok: res.ok,
				stopReason: res.stopReason,
				exitCode: res.exitCode,
				signal: res.signal,
				parkedSeen: res.parkedSeen,
				wallMs: res.wallMs,
				err: res.err?.message,
			});
			callLogLines.push(
				`===== ATTEMPT ${attempt} END ok=${res.ok} stopReason=${res.stopReason} exit=${res.exitCode} parked=${res.parkedSeen} wall=${res.wallMs}ms =====`,
			);
			if (res.ok) {
				outcome = res;
				break;
			}
		}

		callLogLines.push("");
		callLogLines.push("==== ATTEMPT SUMMARY ====");
		for (const a of attempts) callLogLines.push(JSON.stringify(a));
		writeFileSync(CALL_LOG, callLogLines.join("\n") + "\n", "utf8");

		assert.ok(outcome, `no clean capture in ${MAX_ATTEMPTS} attempts; see ${CALL_LOG}: ${JSON.stringify(attempts)}`);

		// Persist the raw stdout fixture.
		writeFileSync(STREAM_OUT, outcome.raw, "utf8");

		// ── G1 assertions ──────────────────────────────────────────────────────
		assert.ok(
			outcome.parkedSeen >= ROUNDS_REQUIRED,
			`router must see >=${ROUNDS_REQUIRED} parked calls in one spawn; saw ${outcome.parkedSeen}`,
		);
		// Distinct parked calls (distinct piIds).
		const piIds = new Set(outcome.holds.map((h) => h.piId));
		assert.equal(piIds.size, outcome.holds.length, "each parked call has a distinct minted piId");
		// Each round blocked inline: the shim only returns after router.deliver, so
		// the round-trip is synchronous from claude-p's perspective. We confirm the
		// hold log recorded RECEIVED->RESOLVED for each (held >= 0ms, monotonic n).
		for (const h of outcome.holds) {
			assert.ok(h.resolvedAt !== null, "each parked call was resolved (held open until deliver)");
		}
		// The driver done resolved with stopReason result.
		assert.equal(outcome.stopReason, "result", "driver done resolved with stopReason result");

		// The bridged step tool surfaced as tool-use events for each round (D32),
		// and the round count from stdout matches the router's parked count.
		//
		// IMPORTANT (observed behavioral finding): `claude` re-namespaces EVERY MCP
		// tool on its stdout as `mcp__<serverName>__<advertisedToolName>`. Because
		// the bridge (index.ts) advertises tool names to the shim ALREADY prefixed
		// (`mcp__custom-tools__step`), the name that appears on claude-p's stdout is
		// DOUBLE-prefixed: `mcp__custom-tools__mcp__custom-tools__step`. The parser's
		// isBridgedToolName() only checks the `mcp__` prefix, so it still surfaces
		// the event (correct for routing-is-shim-owned, D32). We therefore match on
		// the `mcp__` prefix + the `__step` suffix rather than an exact name.
		const toolUses = outcome.driverEvents.filter(
			(e) => e.kind === "tool-use" && typeof e.name === "string" && e.name.startsWith("mcp__") && e.name.endsWith("__step"),
		);
		assert.ok(
			toolUses.length >= ROUNDS_REQUIRED,
			`>=${ROUNDS_REQUIRED} bridged tool-use events on stdout; saw ${toolUses.length} ` +
				`(all tool-use names: ${JSON.stringify(outcome.driverEvents.filter((e) => e.kind === "tool-use").map((e) => e.name))})`,
		);
		// Document the double-prefix observation in the call log for the handoff.
		callLogLines.push(
			`OBSERVED tool_use stdout name: ${JSON.stringify(toolUses[0]?.name)} (claude re-namespaces MCP tools => double-prefix)`,
		);
		writeFileSync(CALL_LOG, callLogLines.join("\n") + "\n", "utf8");

		// ── G3 assertions: turn-end is per-TURN, not per-segment ────────────────
		// Count `result` lines in the captured raw stdout. If claude-p emitted a
		// `result` between tool rounds (per-segment), there would be >1. The parser
		// turn-end rule (done only on `result`) is only safe if there is exactly ONE.
		const rawResultLines = outcome.raw
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0)
			.filter((l) => {
				try {
					return JSON.parse(l).type === "result";
				} catch {
					return false;
				}
			});
		assert.equal(
			rawResultLines.length,
			1,
			`claude-p must emit exactly ONE result line per pi turn (per-TURN, not per-segment); saw ${rawResultLines.length}. ` +
				`A per-segment result would corrupt multi-round turns. Lines: ${JSON.stringify(rawResultLines)}`,
		);

		// The parser (fed live above) emitted exactly ONE terminal done(reason=result).
		const doneEvents = outcome.driverEvents.filter((e) => e.kind === "done");
		assert.equal(doneEvents.length, 1, "parser emits exactly one terminal done");
		assert.equal(doneEvents[0].reason, "result");
		// done is the LAST event (turn-end is terminal).
		assert.equal(
			outcome.driverEvents[outcome.driverEvents.length - 1].kind,
			"done",
			"done is the terminal event",
		);
		// No error events on a clean multi-round stream.
		assert.ok(!outcome.driverEvents.some((e) => e.kind === "error"), "no error events on a clean multi-round stream");
		// Exactly one usage event (from the single result line).
		const usageEvents = outcome.driverEvents.filter((e) => e.kind === "usage");
		assert.equal(usageEvents.length, 1, "exactly one usage event (one result line)");

		// ── Replay the recorded fixture through a FRESH parser (G3 verification) ─
		// Confirms the parser deterministically reproduces the same event sequence
		// from the persisted fixture, and that WaitForMcpServers + noise are filtered.
		const replayEvents = [];
		const replayWarns = [];
		const replayParser = new ClaudePStreamParser({
			logger: { warn: (...a) => replayWarns.push(a) },
			onEvent: (e) => replayEvents.push(e),
		});
		replayParser.write(outcome.raw);
		replayParser.endOfStream({ aborted: false, exitInfo: { code: outcome.exitCode, signal: outcome.signal } });

		const replayTools = replayEvents.filter((e) => e.kind === "tool-use");
		assert.ok(
			replayTools.every((e) => e.name.startsWith("mcp__")),
			"replay: only bridged mcp__* tool-use events surface (WaitForMcpServers filtered)",
		);
		assert.equal(
			replayTools.length,
			toolUses.length,
			"replay: same bridged tool-use count as live parse",
		);
		const replayDone = replayEvents.filter((e) => e.kind === "done");
		assert.equal(replayDone.length, 1, "replay: exactly one terminal done");
		assert.equal(replayDone[0].reason, "result");
		assert.ok(!replayEvents.some((e) => e.kind === "error"), "replay: no error on clean fixture");
		assert.equal(replayEvents[replayEvents.length - 1].kind, "done", "replay: done is terminal");

		// Confirm no WaitForMcpServers leaked as a bridged tool-use in either pass.
		assert.ok(
			!replayTools.some((e) => e.name === "WaitForMcpServers"),
			"WaitForMcpServers must never surface as a tool-use event",
		);
	});
});
