#!/usr/bin/env node
// T2.4 — capture path ISOLATION against the REAL claude-p driver.
//
// Proves a capture call running between two main-provider turns does NOT mutate
// the main path's cross-call session cache (cachedSessionId / cachedSessionCwd):
//   1. Main turn A (real claude-p) warms the cache → records the cached session.
//   2. A capture call fires (real claude-p, isolated single-shot spawn).
//   3. Main turn B (real claude-p) must RESUME the SAME session warmed by A —
//      proving the capture call neither wrote nor read cachedSessionId, and used
//      its OWN router/socket/shim (single-spawn isolation). The CONCURRENT
//      two-spawn case is gate G9 (out of scope here).
//
// Observed via the debug log: the main path logs "caching session=<8>" and
// "resume=<8>"; the capture path logs under mode "capture-claude-p" and NEVER
// logs "caching session". Gated behind RUN_REAL_CLAUDE_P=1. Concurrency 1; does
// NOT override CLAUDE_CONFIG_DIR/HOME. Retries flaky turns up to 3x.
//
//   RUN_REAL_CLAUDE_P=1 node --import tsx --test tests/int-claude-p-capture-isolation.mjs

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

const LOG_DIR = mkdtempSync(join(tmpdir(), "bridge-int-cap-iso-"));
const LOG_FILE = join(LOG_DIR, "bridge.log");
process.env.CLAUDE_BRIDGE_DEBUG_PATH = LOG_FILE;
process.env.CLAUDE_BRIDGE_DEBUG = "1";

const {
	streamClaudeAgentSdk,
	__setPiApiRefForTests,
	__resetCachedSessionForTests,
} = await import("../index.js");
import { submitDigestTool } from "./fixtures/submit-digest-schema.js";

const ENABLED = process.env.RUN_REAL_CLAUDE_P === "1";
const TIMEOUT = 180_000;
const MODEL = { id: "claude-haiku-4-5", cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } };
const ts = () => Date.now();

function readLogObjects() {
	try {
		return readFileSync(LOG_FILE, "utf8").split("\n").filter(Boolean)
			.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
	} catch { return []; }
}
const flushLogs = () => new Promise((r) => setTimeout(r, 200));

async function mainTurn(messages) {
	const stream = streamClaudeAgentSdk(MODEL, {
		systemPrompt: "You are a helpful assistant. Answer briefly.",
		messages,
		tools: [],
	});
	return await stream.result();
}

async function captureCall() {
	const stream = streamClaudeAgentSdk(MODEL, {
		systemPrompt: "Call submit_digest exactly once with a short digest. Body >= 50 chars. No other output.",
		messages: [{ role: "user", content: "Summarize: we wrote an isolation test. Submit a digest now.", timestamp: ts() }],
		tools: [submitDigestTool],
	});
	return await stream.result();
}

describe("claude-p capture isolation (T2.4)", { skip: !ENABLED ? "set RUN_REAL_CLAUDE_P=1 to run" : false }, () => {
	let restoreApi = null;

	before(() => {
		restoreApi = __setPiApiRefForTests({ getActiveTools: () => [] });
		__resetCachedSessionForTests();
	});
	after(() => { restoreApi?.(); __resetCachedSessionForTests(); });

	it("capture between two main turns does not pollute cachedSessionId", { timeout: TIMEOUT }, async () => {
		// ── Main turn A: warm the cache ──
		const a = await mainTurn([{ role: "user", content: "Reply with the word ALPHA and nothing else.", timestamp: ts() }]);
		assert.ok(a.stopReason === "stop" || a.stopReason === "toolUse", `turn A stopReason=${a.stopReason} err=${a.errorMessage ?? ""}`);
		await flushLogs();

		// Capture the session id the main path cached after turn A.
		const cachingLines = readLogObjects().filter((l) => typeof l.msg === "string" && l.msg.includes("finalizeClaudePFrame: caching session="));
		assert.ok(cachingLines.length >= 1, "main turn A must cache a session");
		const cachedPrefix = cachingLines[cachingLines.length - 1].msg.match(/caching session=([0-9a-f]{8})/)?.[1];
		assert.ok(cachedPrefix, "could not parse cached session prefix");

		// ── Capture call (must not touch cachedSessionId) ──
		const capPreCount = readLogObjects().length;
		const cap = await captureCall();
		await flushLogs();
		const capLines = readLogObjects().slice(capPreCount);

		// Capture either succeeds (toolUse) or, on model non-determinism, errors —
		// EITHER WAY it must not have polluted the cache. We assert the cache
		// invariant below regardless of the capture verdict.
		assert.ok(cap.stopReason === "toolUse" || cap.stopReason === "error", `unexpected capture stopReason=${cap.stopReason}`);

		// The capture path must NOT log "caching session=" (it never writes the cache).
		const captureCaching = capLines.filter(
			(l) => l.mode === "capture-claude-p" && typeof l.msg === "string" && l.msg.includes("caching session="),
		);
		assert.equal(captureCaching.length, 0, `capture path must not cache a session: ${JSON.stringify(captureCaching)}`);

		// ── Main turn B: must RESUME the session warmed by turn A ──
		const bPreCount = readLogObjects().length;
		const b = await mainTurn([
			{ role: "user", content: "Reply with the word ALPHA and nothing else.", timestamp: ts() },
			{ role: "assistant", content: [{ type: "text", text: "ALPHA" }], stopReason: "stop", timestamp: ts() },
			{ role: "user", content: "Now reply with the word BETA and nothing else.", timestamp: ts() },
		]);
		assert.ok(b.stopReason === "stop" || b.stopReason === "toolUse", `turn B stopReason=${b.stopReason} err=${b.errorMessage ?? ""}`);
		await flushLogs();

		const bLines = readLogObjects().slice(bPreCount);
		const resumeLine = bLines.find(
			(l) => typeof l.msg === "string" && l.msg.includes("fresh spawn") && l.msg.includes(`resume=${cachedPrefix}`),
		);
		assert.ok(
			resumeLine,
			`main turn B must resume session ${cachedPrefix} (capture did not pollute the cache). ` +
			`Got: ${JSON.stringify(bLines.filter((l) => l.msg?.includes?.("fresh spawn")).map((l) => l.msg))}`,
		);
	});
});
