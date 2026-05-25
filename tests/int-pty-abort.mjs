#!/usr/bin/env node
// T1.13 — abort mid-turn: SIGINT propagates, done(aborted) fires.

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawnDriver } from "../src/driver/pty.js";

const req = createRequire(import.meta.url);
const shimPath = req.resolve("../shim.js");
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "int-abort-")));

const h = await spawnDriver({
	shimPath,
	model: process.env.PI_BRIDGE_TEST_MODEL || "claude-sonnet-4-6",
	prompt: "Count slowly from 1 to 100, one number per line.",
	systemPrompt: "Follow user instructions exactly.",
	cwd,
	mode: "main",
	tools: [],
	abortGraceMs: 1000,
});
setTimeout(() => { h.abort().catch(() => {}); }, 1500);
const done = await h.done;
assert.equal(done.reason, "aborted");
console.log("PASS T1.13");
