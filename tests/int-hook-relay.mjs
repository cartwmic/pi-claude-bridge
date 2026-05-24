#!/usr/bin/env node
// T1.14 — hook-relay end-to-end. Spawn driver, observe SessionStart and Stop
// hook events delivered via the shim over IPC; verify payload shapes.

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawnDriver } from "../src/driver/pty.js";

const req = createRequire(import.meta.url);
const shimPath = req.resolve("../dist/mcp/shim.js");
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "int-hook-")));

const h = await spawnDriver({
	shimPath, model: "claude-sonnet-4-6",
	prompt: "Reply OK.",
	systemPrompt: "Reply OK.",
	cwd, mode: "main", tools: [],
});

const hookEvents = [];
h.on("hook", (e) => hookEvents.push(e));

const done = await h.done;
console.log("hook events:", hookEvents.map((e) => e.event));
assert.equal(done.reason, "stop-settled");
assert.ok(hookEvents.find((e) => e.event === "SessionStart"), "expected SessionStart");
assert.ok(hookEvents.find((e) => e.event === "Stop"), "expected Stop");
const ss = hookEvents.find((e) => e.event === "SessionStart");
assert.ok(ss.payload.session_id, "expected session_id in SessionStart payload");
assert.ok(ss.payload.transcript_path, "expected transcript_path in SessionStart payload");
console.log("PASS T1.14");
