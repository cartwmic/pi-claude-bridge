#!/usr/bin/env node
// Unit tests for the claude-p resilience wrapper (T1.9a / design D33) in
// src/driver/claudeP.ts: spawnClaudePWithResilience().
//
// The wrapper owns the bounded-retry loop, backoff, abort-during-backoff
// suppression, and fresh-session-id on a cold retry. The side-effect-aware
// idempotency gate is the CALLER's `policy.shouldRetry()` (index.ts wires it to
// `!router.everRoutedToolCall`).
//
// We drive the wrapper WITHOUT a real claude-p: a `node` stand-in bin is pointed
// at via opts.binPath. Per-attempt behavior is varied through a shared counter
// file so attempt 1 can fail (premature exit, no `result`) while attempt N
// succeeds (clean `result` line). Each spawn ALSO records its --session-id /
// --resume value to a log file so we can assert fresh-vs-stable session ids.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	spawnClaudePWithResilience,
	RESILIENCE_BACKOFF_MS,
} from "../src/driver/claudeP.js";

const QUIET = { warn() {}, info() {}, error() {} };

function baseCfg(overrides = {}) {
	return {
		model: "claude-sonnet-4-6",
		systemPrompt: { kind: "text", text: "SYS" },
		prompt: { kind: "positional", text: "hello" },
		mcpConfig: '{"mcpServers":{}}',
		session: { kind: "fresh", sessionId: "session-0" },
		timeoutSeconds: 180,
		...overrides,
	};
}

// The node stand-in (written to a .cjs file, invoked by the stub shell). It:
//   - records its session id (the value after --session-id or --resume) to
//     STUB_DIR/sessions.log (one per line),
//   - increments STUB_DIR/count,
//   - succeeds (prints a `result` line, exit 0) only when count > FAIL_UNTIL,
//     else exits 2 with no `result` (premature → parser classifies "error").
// FAIL_UNTIL is injected via the FAIL_UNTIL env var.
const CHILD_CJS = [
	'const fs = require("fs");',
	'const path = require("path");',
	'const dir = process.env.STUB_DIR;',
	'const failUntil = parseInt(process.env.FAIL_UNTIL || "0", 10);',
	'const args = process.argv.slice(2);',
	'const si = args.indexOf("--session-id");',
	'const ri = args.indexOf("--resume");',
	'const sid = si !== -1 ? args[si + 1] : (ri !== -1 ? args[ri + 1] : "?");',
	'fs.appendFileSync(path.join(dir, "sessions.log"), sid + "\\n");',
	'const cp = path.join(dir, "count");',
	'let n = 0; try { n = parseInt(fs.readFileSync(cp, "utf8"), 10) || 0; } catch (e) {}',
	'n += 1; fs.writeFileSync(cp, String(n));',
	'if (n > failUntil) {',
	'  process.stdout.write(JSON.stringify({ type: "result", usage: { input_tokens: 1, output_tokens: 2 } }) + "\\n");',
	'  process.exit(0);',
	'} else {',
	'  process.stdout.write("partial\\n");',
	'  process.exit(2);',
	'}',
].join("\n");

/**
 * Write an executable stub bin + the child .cjs alongside it. The stub injects
 * STUB_DIR + FAIL_UNTIL env and runs the child .cjs, forwarding the claude-p
 * argv so the child can extract the session id.
 */
function makeStubBin(failUntil) {
	const dir = mkdtempSync(join(tmpdir(), "claudep-resil-"));
	const childPath = join(dir, "child.cjs");
	writeFileSync(childPath, CHILD_CJS, "utf8");
	const bin = join(dir, "stub.sh");
	const body =
		`#!/bin/sh\n` +
		`STUB_DIR=${JSON.stringify(dir)} FAIL_UNTIL=${failUntil} ` +
		`exec ${JSON.stringify(process.execPath)} ${JSON.stringify(childPath)} "$@"\n`;
	writeFileSync(bin, body, { mode: 0o755 });
	chmodSync(bin, 0o755);
	return { bin, dir };
}

function readSessions(dir) {
	const p = join(dir, "sessions.log");
	if (!existsSync(p)) return [];
	return readFileSync(p, "utf8").trim().split("\n").filter(Boolean);
}

describe("spawnClaudePWithResilience — retry then success", () => {
	it("error → error → result: succeeds after 2 retries (3 spawns, 2 warns)", async () => {
		// Fail attempts 1 and 2 (count<=2), succeed on attempt 3.
		const { bin, dir } = makeStubBin(2);
		const warns = [];
		const retries = [];
		const h = spawnClaudePWithResilience(
			baseCfg(),
			{ binPath: bin, onEvent: () => {}, logger: { ...QUIET, warn: (...a) => warns.push(a) } },
			{ maxRetries: 2, shouldRetry: () => true, freshSessionId: () => "fresh-" + Math.random().toString(16).slice(2, 8), onRetry: (a) => retries.push(a) },
		);
		const r = await h.done;
		assert.equal(r.stopReason, "result", "final stopReason should be result");
		const sessions = readSessions(dir);
		assert.equal(sessions.length, 3, "exactly 3 spawns (1 + 2 retries)");
		assert.equal(retries.length, 2, "onRetry fired twice");
		assert.ok(warns.length >= 2, "at least 2 warn logs (one per retry)");
	});
});

describe("spawnClaudePWithResilience — exhaustion", () => {
	it("always-error exhausts: 1 + maxRetries spawns → error", async () => {
		const { bin, dir } = makeStubBin(999); // never succeeds
		const h = spawnClaudePWithResilience(
			baseCfg(),
			{ binPath: bin, onEvent: () => {}, logger: QUIET },
			{ maxRetries: 2, shouldRetry: () => true, freshSessionId: () => "f-" + Math.random().toString(16).slice(2, 8) },
		);
		const r = await h.done;
		assert.equal(r.stopReason, "error", "exhausted retries → error");
		const sessions = readSessions(dir);
		assert.equal(sessions.length, 3, "1 initial + 2 retries = 3 spawns");
	});
});

describe("spawnClaudePWithResilience — idempotency gate", () => {
	it("shouldRetry() false (routed tools/call) → NO retry, exactly 1 spawn", async () => {
		const { bin, dir } = makeStubBin(999); // attempt 1 errors
		const h = spawnClaudePWithResilience(
			baseCfg(),
			{ binPath: bin, onEvent: () => {}, logger: QUIET },
			{ maxRetries: 2, shouldRetry: () => false, freshSessionId: () => "f" },
		);
		const r = await h.done;
		assert.equal(r.stopReason, "error");
		assert.equal(readSessions(dir).length, 1, "gate closed → exactly 1 spawn, no retry");
	});
});

describe("spawnClaudePWithResilience — fresh vs stable session id", () => {
	it("cold retry mints a FRESH session id each attempt", async () => {
		const { bin, dir } = makeStubBin(1); // fail attempt 1, succeed attempt 2
		let counter = 0;
		const h = spawnClaudePWithResilience(
			baseCfg({ session: { kind: "fresh", sessionId: "cold-initial" } }),
			{ binPath: bin, onEvent: () => {}, logger: QUIET },
			{ maxRetries: 2, shouldRetry: () => true, freshSessionId: () => `fresh-${++counter}` },
		);
		await h.done;
		const sessions = readSessions(dir);
		assert.equal(sessions[0], "cold-initial", "first attempt uses the initial id");
		assert.equal(sessions[1], "fresh-1", "cold retry mints a fresh id");
		assert.notEqual(sessions[0], sessions[1]);
	});

	it("warm retry keeps the --resume id STABLE across attempts", async () => {
		const { bin, dir } = makeStubBin(1); // fail attempt 1, succeed attempt 2
		const h = spawnClaudePWithResilience(
			baseCfg({ session: { kind: "resume", sessionId: "warm-stable" } }),
			{ binPath: bin, onEvent: () => {}, logger: QUIET },
			{ maxRetries: 2, shouldRetry: () => true, freshSessionId: () => "should-not-be-used" },
		);
		await h.done;
		const sessions = readSessions(dir);
		assert.equal(sessions[0], "warm-stable");
		assert.equal(sessions[1], "warm-stable", "warm resume id is stable across retries");
	});
});

describe("spawnClaudePWithResilience — abort during backoff", () => {
	it("abort() during the backoff window suppresses the replacement spawn", async () => {
		const { bin, dir } = makeStubBin(999); // attempt 1 errors immediately
		const h = spawnClaudePWithResilience(
			baseCfg(),
			{ binPath: bin, onEvent: () => {}, logger: QUIET },
			{ maxRetries: 2, shouldRetry: () => true, freshSessionId: () => "f" },
		);
		// Wait for attempt 1 to fail and the backoff timer to be scheduled, then
		// abort within the backoff window (backoff is RESILIENCE_BACKOFF_MS*1).
		await new Promise((res) => setTimeout(res, Math.max(40, RESILIENCE_BACKOFF_MS / 4)));
		h.abort();
		const r = await h.done;
		assert.equal(r.stopReason, "aborted", "abort during backoff → aborted");
		// Give any (erroneously) scheduled retry time to NOT fire.
		await new Promise((res) => setTimeout(res, RESILIENCE_BACKOFF_MS * 3));
		assert.equal(readSessions(dir).length, 1, "no replacement spawn after abort-during-backoff");
	});
});
