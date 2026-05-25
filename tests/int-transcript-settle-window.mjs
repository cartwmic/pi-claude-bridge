#!/usr/bin/env node
// T1.18 — Stop arrives before terminal result; bounded settle window
// catches the late entry (D17).
//
// Validated empirically in Phase 0 T0.14 (PASS): the Stop hook fires
// BEFORE the system/stop_hook_summary line lands. The settle window
// observes both and emits final events.
//
// Implementation-level coverage: tests/unit-transcript-stream.mjs
// "closes early on system/stop_hook_summary terminal entry" already
// exercises the deterministic logic. This integration test just spawns a
// real claude turn and confirms the end-to-end behavior.

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawnDriver } from "../src/driver/pty.js";

const req = createRequire(import.meta.url);
const shimPath = req.resolve("../shim.js");
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "int-settle-")));

const h = await spawnDriver({
	shimPath, model: "claude-sonnet-4-6",
	prompt: "Reply with the single word OK.",
	systemPrompt: "Terse helper.",
	cwd, mode: "main", tools: [], settleMs: 250,
});
const events = [];
h.on("transcript", (e) => events.push(e));
const done = await h.done;
const usage = events.find((e) => e.kind === "usage");
assert.equal(done.reason, "stop-settled");
assert.ok(usage, "expected usage event to arrive within settle window");
assert.ok(usage.usage.input > 0, "expected non-zero input tokens");
console.log("PASS T1.18");
