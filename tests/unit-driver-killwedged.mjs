#!/usr/bin/env node
// Unit tests for ClaudePHandle.killWedged() (Layer 2 of the hung-turn fix) in
// src/driver/claudeP.ts.
//
// killWedged() SIGKILLs the process group WITHOUT marking the spawn aborted, so
// exit classification is "error" (not "aborted"). That routes a wedge through
// the resilience wrapper's retry gate exactly as claude-p's own --timeout would:
//   - boot-wedge (shouldRetry() true) → retry;
//   - post-tool wedge (shouldRetry() false) → surface "error" to the bridge.
//
// We drive REAL spawns via a `node` stand-in bin (like unit-driver-resilience):
// the child either HANGS forever (a wedged claude-p we then kill) or prints a
// `result` and exits, selected per-attempt via a counter file + HANG_UNTIL.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnClaudeP, spawnClaudePWithResilience } from "../src/driver/claudeP.js";

const QUIET = { warn() {}, info() {}, error() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// Child: record session id + bump counter. If count <= HANG_UNTIL → hang forever
// (a wedged claude-p). Else print a `result` line and exit 0 (clean turn).
const CHILD_CJS = [
	'const fs = require("fs");',
	'const path = require("path");',
	'const dir = process.env.STUB_DIR;',
	'const hangUntil = parseInt(process.env.HANG_UNTIL || "0", 10);',
	'const args = process.argv.slice(2);',
	'const si = args.indexOf("--session-id");',
	'const ri = args.indexOf("--resume");',
	'const sid = si !== -1 ? args[si + 1] : (ri !== -1 ? args[ri + 1] : "?");',
	'fs.appendFileSync(path.join(dir, "sessions.log"), sid + "\\n");',
	'const cp = path.join(dir, "count");',
	'let n = 0; try { n = parseInt(fs.readFileSync(cp, "utf8"), 10) || 0; } catch (e) {}',
	'n += 1; fs.writeFileSync(cp, String(n));',
	'if (n > hangUntil) {',
	'  process.stdout.write(JSON.stringify({ type: "result", usage: { input_tokens: 1, output_tokens: 2 } }) + "\\n");',
	'  process.exit(0);',
	'}',
	'setInterval(() => {}, 1000); // hang forever (wedged) until SIGKILLed',
].join("\n");

function makeStubBin(hangUntil) {
	const dir = mkdtempSync(join(tmpdir(), "claudep-wedge-"));
	const childPath = join(dir, "child.cjs");
	writeFileSync(childPath, CHILD_CJS, "utf8");
	const bin = join(dir, "stub.sh");
	const body =
		`#!/bin/sh\n` +
		`STUB_DIR=${JSON.stringify(dir)} HANG_UNTIL=${hangUntil} ` +
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

async function waitForSpawns(dir, n, timeoutMs = 3000) {
	const start = Date.now();
	while (readSessions(dir).length < n) {
		if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${n} spawn(s)`);
		await sleep(10);
	}
}

describe("spawnClaudeP — killWedged classifies as error, not aborted", () => {
	it("killWedged() on a hung child → done stopReason 'error'", async () => {
		const { bin, dir } = makeStubBin(999); // always hangs
		const h = spawnClaudeP(baseCfg(), { binPath: bin, onEvent: () => {}, logger: QUIET });
		await waitForSpawns(dir, 1);
		h.killWedged();
		const r = await h.done;
		assert.equal(r.stopReason, "error", "killWedged must classify as error (retry-eligible), not aborted");
	});

	it("CONTRAST: abort() on the same hung child → done stopReason 'aborted'", async () => {
		const { bin, dir } = makeStubBin(999);
		const h = spawnClaudeP(baseCfg(), { binPath: bin, onEvent: () => {}, logger: QUIET });
		await waitForSpawns(dir, 1);
		h.abort();
		const r = await h.done;
		assert.equal(r.stopReason, "aborted", "abort stays 'aborted' (the asymmetry killWedged exists to bridge)");
	});
});

describe("spawnClaudePWithResilience — killWedged routes through the retry gate", () => {
	it("boot-wedge (shouldRetry true): killWedged → retry → next attempt succeeds", async () => {
		// Attempt 1 hangs (count 1 <= HANG_UNTIL 1); attempt 2 succeeds (2 > 1).
		const { bin, dir } = makeStubBin(1);
		const h = spawnClaudePWithResilience(
			baseCfg(),
			{ binPath: bin, onEvent: () => {}, logger: QUIET },
			{ maxRetries: 2, shouldRetry: () => true, freshSessionId: () => "fresh-" + Math.random().toString(16).slice(2, 8) },
		);
		await waitForSpawns(dir, 1); // attempt 1 is up and hanging
		h.killWedged();
		const r = await h.done;
		assert.equal(r.stopReason, "result", "wedge → killWedged → retry → success");
		assert.equal(readSessions(dir).length, 2, "exactly 2 spawns (wedged attempt 1 + healthy retry)");
	});

	it("post-tool wedge (shouldRetry false): killWedged → NO retry, surfaces 'error'", async () => {
		const { bin, dir } = makeStubBin(999); // always hangs
		const h = spawnClaudePWithResilience(
			baseCfg(),
			{ binPath: bin, onEvent: () => {}, logger: QUIET },
			{ maxRetries: 2, shouldRetry: () => false, freshSessionId: () => "f" },
		);
		await waitForSpawns(dir, 1);
		h.killWedged();
		const r = await h.done;
		assert.equal(r.stopReason, "error", "gate closed (a tool was routed) → surface error, no re-run");
		assert.equal(readSessions(dir).length, 1, "exactly 1 spawn — no retry");
	});
});
