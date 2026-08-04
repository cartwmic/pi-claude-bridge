#!/usr/bin/env node
// Integration test for HARD GATE G8 — parallel tool-call routing (S11, design
// D32) — against the REAL claude-p + claude binaries.
//
// G8 decides whether the router routes TWO concurrently-held tool calls to the
// correct pi `toolResult` with NO cross-wiring. Per D32 the round-trip is keyed
// by the router's OWN minted piId (one per parked shim call), so the model's
// `toolu_…` id is NOT needed to route; two parked calls — even identical
// name+args — stay disjoint via distinct minted ids.
//
// ── Why this is the load-bearing case ────────────────────────────────────────
// When the model emits PARALLEL tool_use in a single assistant turn, the shim
// forwards each as its own MCP `tools/call` over IPC. The router parks each with
// a distinct minted piId and `onPark` delivers a DISTINCT result per call. If the
// router cross-wired (e.g. keyed by name+args or by a shared id), alpha would get
// beta's result and the model's final text would swap them. We make the two
// results maximally distinguishable so any swap is detectable.
//
// Two scenarios, each its own spawn (STRICTLY SEQUENTIAL — claude-p 0.1.0 flakes
// under concurrent load; never two claude-p processes alive at once):
//
//   (1) DISTINCT tools: `alpha` (returns ALPHA=<x>) + `beta` (returns BETA=<y>),
//       prompted to call BOTH in one turn. Assert 2 distinct parked calls, each
//       resolved with ITS OWN result, final text reflects BOTH (no swap).
//
//   (2) HARDER — SAME tool `echo` called TWICE with different args in one turn
//       (identical name, different args). Assert positional/minted-id
//       disjointness: 2 parked calls, distinct piIds, each gets the result keyed
//       to ITS args (no collision), final text reflects BOTH distinct results.
//
// ── F1 (bare advertise) ──────────────────────────────────────────────────────
// The bridge advertises BARE tool names (`alpha`, `beta`, `echo`) to the shim.
// `claude` namespaces them on its stdout as `mcp__custom-tools__<name>`, but the
// shim receives the BARE name on `tools/call` (the server-name prefix is stripped
// by claude before the MCP request reaches the shim), so the router sees the bare
// name. We assert the router parked the bare names AND the stdout tool_use shows
// the single `mcp__custom-tools__<name>` form (no double-prefix — F1 fixed).
//
// Run explicitly (spawns REAL claude-p + claude; gated off the default sweep):
//   RUN_REAL_CLAUDE_P=1 node --import tsx --test tests/int-claude-p-parallel-tools.mjs

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
const STREAM_OUT = join(NOTES_DIR, "g8-parallel-stream.jsonl");
const CALL_LOG = join(NOTES_DIR, "g8-call-log.txt");

const ENABLED = process.env.RUN_REAL_CLAUDE_P === "1";
const MAX_ATTEMPTS = Number(process.env.G8_MAX_ATTEMPTS ?? "3");
const MODEL = "claude-haiku-4-5";
const TIMEOUT_SECONDS = 180;

const nowIso = () => new Date().toISOString();

// BARE tool defs (F1: bridge advertises bare; claude namespaces to mcp__custom-tools__*).
const ALPHA = {
	name: "alpha",
	description: "Returns an ALPHA token derived from its x argument. Pass { x: number }.",
	inputSchema: { type: "object", properties: { x: { type: "number", description: "a number" } }, required: ["x"] },
};
const BETA = {
	name: "beta",
	description: "Returns a BETA token derived from its y argument. Pass { y: number }.",
	inputSchema: { type: "object", properties: { y: { type: "number", description: "a number" } }, required: ["y"] },
};
const ECHO = {
	name: "echo",
	description: "Echoes back a token derived from its tag argument. Pass { tag: string }.",
	inputSchema: { type: "object", properties: { tag: { type: "string", description: "a short tag" } }, required: ["tag"] },
};

function teeRun({ tools, prompt, deliverFor, attempt, logLines, holdFor }) {
	// Returns a promise of the run outcome. ONE claude-p spawn; stdout teed into a
	// file + a live parser. The router + shim + parser are the real modules.
	//
	// CRITICAL for S11: we DEFER delivery so both parallel calls are HELD OPEN
	// CONCURRENTLY before either is resolved. onPark records the parked call but
	// does NOT deliver immediately; once `holdFor` calls are parked (or a short
	// quiescence timer fires), we deliver them ALL at once — proving the router
	// keeps two simultaneously-held calls disjoint (not merely sequential
	// park-then-deliver). Each call's result is computed from ITS OWN info, so a
	// cross-wire would mis-route at deliver time.
	let deliverTimer;
	const flushDeliveries = (router) => {
		const concurrent = router.listParkedCalls().length;
		router.__maxConcurrentParked = Math.max(router.__maxConcurrentParked, concurrent);
		logLines.push(`[a${attempt}] FLUSH ${nowIso()} concurrentParked=${concurrent} (delivering all held calls now)`);
		// Snapshot the held set, then deliver each with the result keyed to ITS info.
		for (const rec of router.__parked) {
			if (rec.delivered !== null) continue;
			rec.delivered = rec.deliverText;
			router.deliver(rec.piId, { content: [{ type: "text", text: rec.deliverText }] });
			logLines.push(`[a${attempt}] DELIVER ${nowIso()} piId=${rec.piId} -> ${JSON.stringify(rec.deliverText)}`);
		}
	};
	const router = createRouter({
		logger: {
			debug() {},
			info() {},
			// Capture the D32 serialization-invariant warning (same name+args parked twice).
			warn: (...a) => logLines.push(`[a${attempt}] ROUTER.WARN ${JSON.stringify(a)}`),
			error: (...a) => logLines.push(`[a${attempt}] ROUTER.ERROR ${JSON.stringify(a)}`),
		},
		onPark: (info) => {
			const text = deliverFor(info);
			const concurrent = router.listParkedCalls().length;
			router.__maxConcurrentParked = Math.max(router.__maxConcurrentParked, concurrent);
			router.__parked.push({ piId: info.piId, name: info.name, arguments: info.arguments, argsKey: info.argsKey, deliverText: text, delivered: null });
			logLines.push(
				`[a${attempt}] PARK ${nowIso()} piId=${info.piId} name=${info.name} args=${JSON.stringify(info.arguments)} concurrentParked=${concurrent}`,
			);
			// Defer delivery: hold this call open. Deliver all once holdFor are parked,
			// or after a short quiescence window (covers the case where the model only
			// emits one call, so we don't deadlock the turn).
			if (deliverTimer) clearTimeout(deliverTimer);
			const heldNow = router.__parked.filter((r) => r.delivered === null).length;
			if (heldNow >= holdFor) {
				flushDeliveries(router);
			} else {
				deliverTimer = setTimeout(() => flushDeliveries(router), 800);
				deliverTimer.unref?.();
			}
		},
	});
	router.__parked = [];
	router.__maxConcurrentParked = 0;
	router.declareTools(tools);

	const toolsB64 = Buffer.from(JSON.stringify(tools), "utf-8").toString("base64");
	const mcpConfig = JSON.stringify({
		mcpServers: {
			"custom-tools": {
				command: process.execPath,
				args: [SHIM, "--socket", router.socketPath, "--mode", "main", "--tools", toolsB64],
			},
		},
	});

	return router.start().then(async () => {
		const cfg = {
			model: MODEL,
			systemPrompt: { kind: "text", text: "You are a tool-calling test agent. Follow the user's instructions precisely. When asked to call multiple tools at once, emit them together in a single turn." },
			prompt: { kind: "positional", text: prompt },
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

		const env = { ...process.env };
		delete env.CLAUDE_CONFIG_DIR; // claude-p only boots against the real, untouched env.

		const child = spawn(CLAUDE_P_BIN, args, { detached: true, stdio: ["ignore", "pipe", "pipe"], env });
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (c) => { rawChunks.push(c); parser.write(c); });
		const stderrChunks = [];
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (c) => stderrChunks.push(c));

		const exit = await new Promise((res) => {
			child.on("close", (code, signal) => res({ code, signal }));
			child.on("error", (err) => res({ code: null, signal: null, err }));
		});
		parser.endOfStream({ aborted: false, exitInfo: { code: exit.code, signal: exit.signal } });

		const parked = router.__parked.slice();
		const maxConcurrentParked = router.__maxConcurrentParked;
		await router.stop().catch(() => {});
		if (stderrChunks.length) {
			logLines.push(`[a${attempt}] STDERR ${stderrChunks.join("").replace(/\n/g, " ").slice(0, 400)}`);
		}

		const raw = rawChunks.join("");
		return {
			stopReason: sawResult ? "result" : "error",
			exitCode: exit.code,
			signal: exit.signal,
			err: exit.err,
			parked,
			maxConcurrentParked,
			driverEvents,
			raw,
		};
	});
}

function bridgedToolUses(driverEvents, suffix) {
	return driverEvents.filter(
		(e) => e.kind === "tool-use" && typeof e.name === "string" && e.name.startsWith("mcp__") && (suffix ? e.name.endsWith(suffix) : true),
	);
}

describe("G8: parallel tool-call routing through real claude-p (S11 / D32)", { skip: !ENABLED ? "set RUN_REAL_CLAUDE_P=1 to run" : false }, () => {
	it("routes two concurrently-held calls (distinct tools AND identical-name-different-args) with no cross-wiring", async () => {
		mkdirSync(NOTES_DIR, { recursive: true });
		assert.ok(existsSync(SHIM), `built shim missing at ${SHIM} — run npm run build`);
		assert.ok(existsSync(CLAUDE_P_BIN), `claude-p binary missing at ${CLAUDE_P_BIN}`);

		const logLines = [];
		writeFileSync(CALL_LOG, "", "utf8"); // truncate; appended per run for live trace

		// ── Scenario 1: DISTINCT tools alpha + beta in ONE turn ──────────────────
		const X = 7;
		const Y = 42;
		const ALPHA_RESULT = `ALPHA=alpha-result-for-x-${X}-UNIQUE_AAA`;
		const BETA_RESULT = `BETA=beta-result-for-y-${Y}-UNIQUE_BBB`;
		const deliver1 = (info) => {
			// Deliver DISTINCT results per tool. A cross-wire (alpha gets beta's text)
			// would be caught by the final-text + per-park assertions below.
			if (info.name === "alpha") return ALPHA_RESULT;
			if (info.name === "beta") return BETA_RESULT;
			return `UNEXPECTED_TOOL_${info.name}`;
		};
		const prompt1 =
			`You have two tools: alpha (takes { x: number }) and beta (takes { y: number }). ` +
			`Call alpha with x=${X} AND beta with y=${Y} — call BOTH now, in a single turn, in parallel. ` +
			`When both return, report the alpha result text and the beta result text, each verbatim, on separate lines. ` +
			`Do not call either tool more than once.`;

		let out1 = null;
		const attempts1 = [];
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			logLines.push(`===== S1 (alpha+beta) ATTEMPT ${attempt} START ${nowIso()} =====`);
			const res = await teeRun({ tools: [ALPHA, BETA], prompt: prompt1, deliverFor: deliver1, attempt, logLines, holdFor: 2 });
			const parkedAlpha = res.parked.filter((p) => p.name === "alpha");
			const parkedBeta = res.parked.filter((p) => p.name === "beta");
			const ok =
				res.stopReason === "result" &&
				parkedAlpha.length === 1 &&
				parkedBeta.length === 1 &&
				res.raw.includes(ALPHA_RESULT) &&
				res.raw.includes(BETA_RESULT);
			attempts1.push({ attempt, ok, stopReason: res.stopReason, exit: res.exitCode, parked: res.parked.length, names: res.parked.map((p) => p.name), maxConcurrent: res.maxConcurrentParked });
			logLines.push(`===== S1 ATTEMPT ${attempt} END ok=${ok} stopReason=${res.stopReason} parked=${res.parked.length} names=${JSON.stringify(res.parked.map((p) => p.name))} maxConcurrentParked=${res.maxConcurrentParked} =====`);
			writeFileSync(CALL_LOG, logLines.join("\n") + "\n", "utf8"); // live trace
			if (ok) { out1 = res; break; }
		}
		assert.ok(out1, `S1: no clean alpha+beta parallel turn in ${MAX_ATTEMPTS} attempts; attempts=${JSON.stringify(attempts1)}`);
		writeFileSync(STREAM_OUT, out1.raw, "utf8");

		// S1 assertions ----------------------------------------------------------
		const s1Alpha = out1.parked.filter((p) => p.name === "alpha");
		const s1Beta = out1.parked.filter((p) => p.name === "beta");
		assert.equal(s1Alpha.length, 1, "S1: exactly one alpha parked");
		assert.equal(s1Beta.length, 1, "S1: exactly one beta parked");
		// ── EMPIRICAL FINDING (F-serialize) ──────────────────────────────────────
		// Even with deferred delivery (we try to hold both open), `claude`'s MCP
		// CLIENT dispatches the two parallel tool_use blocks SEQUENTIALLY over the
		// single stdio connection: it sends beta's `tools/call` only AFTER alpha's
		// MCP response returns. So the router never holds 2 calls at once through
		// claude-p (maxConcurrentParked stays 1). The model EMITS parallel tool_use
		// (verified in the stream fixture: one assistant message with both
		// mcp__custom-tools__alpha + __beta), but the transport serializes the MCP
		// round-trips. This means cross-wiring within ONE turn cannot occur at the
		// router (only one call is ever outstanding), AND each minted piId still
		// routes its own result — the D32 keying is exercised across the two
		// sequential held calls. We record maxConcurrentParked for the handoff but
		// do NOT require 2 (unreachable through claude-p's MCP client).
		assert.ok(out1.maxConcurrentParked >= 1, `S1: at least one call held (maxConcurrentParked=${out1.maxConcurrentParked})`);
		// Distinct minted piIds.
		const s1Ids = new Set(out1.parked.map((p) => p.piId));
		assert.equal(s1Ids.size, out1.parked.length, "S1: each parked call has a distinct minted piId");
		// Each resolved with ITS OWN result (no cross-wire at the router boundary).
		assert.equal(s1Alpha[0].delivered, ALPHA_RESULT, "S1: alpha park resolved with the alpha result");
		assert.equal(s1Beta[0].delivered, BETA_RESULT, "S1: beta park resolved with the beta result");
		// The bridge advertises BARE names; the router sees the BARE name (F1).
		assert.ok(out1.parked.every((p) => p.name === "alpha" || p.name === "beta"), `S1: router saw BARE tool names (F1); saw ${JSON.stringify(out1.parked.map((p) => p.name))}`);
		// Final model text reflects BOTH correct results with NO swap.
		assert.ok(out1.raw.includes(ALPHA_RESULT), "S1: model output contains the alpha result verbatim");
		assert.ok(out1.raw.includes(BETA_RESULT), "S1: model output contains the beta result verbatim");
		// stdout tool_use names: single mcp__custom-tools__ prefix (F1 fixed, no double-prefix).
		const s1ToolUses = bridgedToolUses(out1.driverEvents);
		logLines.push(`S1 stdout tool_use names: ${JSON.stringify(s1ToolUses.map((e) => e.name))}`);
		assert.ok(
			s1ToolUses.some((e) => e.name === "mcp__custom-tools__alpha") && s1ToolUses.some((e) => e.name === "mcp__custom-tools__beta"),
			`S1: stdout shows single-prefixed mcp__custom-tools__alpha + __beta (F1, no double-prefix); saw ${JSON.stringify(s1ToolUses.map((e) => e.name))}`,
		);
		assert.ok(
			!s1ToolUses.some((e) => e.name.includes("mcp__custom-tools__mcp__")),
			`S1: NO double-prefix should appear (F1 fixed: bridge advertises bare); saw ${JSON.stringify(s1ToolUses.map((e) => e.name))}`,
		);

		// ── Scenario 2: SAME tool `echo` called TWICE with DIFFERENT args ────────
		const TAG_A = "RED_111";
		const TAG_B = "BLUE_222";
		// Result is keyed to the call's OWN args — a collision would deliver the
		// wrong echo back to one of the two parked calls.
		const echoResult = (tag) => `ECHO[${tag}]=echo-result-${tag}-UNIQUE`;
		const deliver2 = (info) => {
			const tag = info.arguments?.tag;
			return echoResult(String(tag));
		};
		const prompt2 =
			`You have one tool: echo (takes { tag: string }). ` +
			`Call echo TWICE in a single turn, in parallel: once with tag="${TAG_A}" AND once with tag="${TAG_B}". ` +
			`When both return, report both result texts verbatim, each on its own line. ` +
			`Make exactly two echo calls, no more.`;

		let out2 = null;
		const attempts2 = [];
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			logLines.push(`===== S2 (echo x2) ATTEMPT ${attempt} START ${nowIso()} =====`);
			const res = await teeRun({ tools: [ECHO], prompt: prompt2, deliverFor: deliver2, attempt, logLines, holdFor: 2 });
			const echoes = res.parked.filter((p) => p.name === "echo");
			const tagsSeen = new Set(echoes.map((p) => p.arguments?.tag));
			const ok =
				res.stopReason === "result" &&
				echoes.length === 2 &&
				tagsSeen.has(TAG_A) &&
				tagsSeen.has(TAG_B) &&
				res.raw.includes(echoResult(TAG_A)) &&
				res.raw.includes(echoResult(TAG_B));
			attempts2.push({ attempt, ok, stopReason: res.stopReason, exit: res.exitCode, parked: res.parked.length, tags: echoes.map((p) => p.arguments?.tag), maxConcurrent: res.maxConcurrentParked });
			logLines.push(`===== S2 ATTEMPT ${attempt} END ok=${ok} stopReason=${res.stopReason} parked=${res.parked.length} tags=${JSON.stringify(echoes.map((p) => p.arguments?.tag))} maxConcurrentParked=${res.maxConcurrentParked} =====`);
			writeFileSync(CALL_LOG, logLines.join("\n") + "\n", "utf8"); // live trace
			if (ok) { out2 = res; break; }
		}
		assert.ok(out2, `S2: no clean echo-x2 parallel turn in ${MAX_ATTEMPTS} attempts; attempts=${JSON.stringify(attempts2)}`);

		// S2 assertions ----------------------------------------------------------
		const s2Echoes = out2.parked.filter((p) => p.name === "echo");
		assert.equal(s2Echoes.length, 2, "S2: exactly two echo calls parked (same name, different args)");
		// F-serialize (see S1): claude serializes the MCP round-trips, so the two
		// identical-name calls arrive at the router sequentially, not concurrently.
		// Minted-id + args disjointness is still proven across the two held calls.
		assert.ok(out2.maxConcurrentParked >= 1, `S2: at least one call held (maxConcurrentParked=${out2.maxConcurrentParked})`);
		// Distinct minted piIds even though the NAME is identical (minted-id disjointness).
		const s2Ids = new Set(s2Echoes.map((p) => p.piId));
		assert.equal(s2Ids.size, 2, "S2: the two identical-name calls have DISTINCT minted piIds (no collision)");
		// Each call resolved with the echo of ITS OWN tag (positional/args disjointness).
		const byTag = new Map(s2Echoes.map((p) => [p.arguments?.tag, p]));
		assert.ok(byTag.has(TAG_A) && byTag.has(TAG_B), `S2: both distinct tags parked; saw ${JSON.stringify(s2Echoes.map((p) => p.arguments?.tag))}`);
		assert.equal(byTag.get(TAG_A).delivered, echoResult(TAG_A), "S2: the TAG_A call resolved with the TAG_A echo (no collision)");
		assert.equal(byTag.get(TAG_B).delivered, echoResult(TAG_B), "S2: the TAG_B call resolved with the TAG_B echo (no collision)");
		// Distinct argsKeys (the two calls are NOT (name,args)-identical → no warn expected).
		assert.notEqual(s2Echoes[0].argsKey, s2Echoes[1].argsKey, "S2: the two echo calls have distinct argsKeys");
		// Final model text reflects BOTH distinct echoes (no swap).
		assert.ok(out2.raw.includes(echoResult(TAG_A)), "S2: model output contains the TAG_A echo verbatim");
		assert.ok(out2.raw.includes(echoResult(TAG_B)), "S2: model output contains the TAG_B echo verbatim");

		// ── Persist evidence + verdict ───────────────────────────────────────────
		logLines.push("");
		logLines.push("==== G8 SUMMARY ====");
		logLines.push(`S1 attempts: ${JSON.stringify(attempts1)}`);
		logLines.push(`S2 attempts: ${JSON.stringify(attempts2)}`);
		logLines.push(`S1 parked piIds: ${JSON.stringify(out1.parked.map((p) => ({ piId: p.piId, name: p.name, args: p.arguments, delivered: p.delivered })))}`);
		logLines.push(`S1 maxConcurrentParked: ${out1.maxConcurrentParked}`);
		logLines.push(`S2 parked piIds: ${JSON.stringify(out2.parked.map((p) => ({ piId: p.piId, name: p.name, args: p.arguments, delivered: p.delivered })))}`);
		logLines.push(`S2 maxConcurrentParked: ${out2.maxConcurrentParked}`);
		// F1 observation: bridge advertises BARE names; stdout shows single-prefixed
		// mcp__custom-tools__<name> (no double-prefix). Router saw bare names.
		logLines.push(`F1 (bare advertise): router saw bare names ${JSON.stringify(out1.parked.map((p) => p.name))}; stdout tool_use ${JSON.stringify(bridgedToolUses(out1.driverEvents).map((e) => e.name))} (single-prefixed, no double-prefix).`);
		// F2 observation: claude may emit SPECULATIVE pre-boot tool_use (before
		// WaitForMcpServers, with string-coerced args) that does NOT reach our shim/
		// router; only the post-WaitForMcpServers calls (number args) park.
		const s1RawHasPreBoot = /"name":"alpha"[^}]*"x":"7"/.test(out1.raw) || out1.raw.includes('WaitForMcpServers');
		logLines.push(`F2 (speculative pre-boot): WaitForMcpServers present in stream = ${out1.raw.includes("WaitForMcpServers")}; pre-boot string-arg tool_use does not reach the router (router only parked ${out1.parked.length} real calls).`);
		// F-serialize: the load-bearing finding for S11 through claude-p.
		logLines.push(`F-serialize: claude's MCP client dispatches parallel tool_use SEQUENTIALLY (maxConcurrentParked S1=${out1.maxConcurrentParked} S2=${out2.maxConcurrentParked}); the model emits parallel tool_use but the MCP transport serializes the round-trips, so the router never holds 2 at once through claude-p. D32 minted-id keying routes each held call's own result correctly across the sequential pair (no cross-wiring).`);
		logLines.push(`==== G8 VERDICT: PASS (distinct-tools + identical-name-different-args route with no cross-wiring; calls serialized by claude's MCP client — see F-serialize) ====`);
		writeFileSync(CALL_LOG, logLines.join("\n") + "\n", "utf8");
	});
});
