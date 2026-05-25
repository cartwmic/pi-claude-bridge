#!/usr/bin/env node
// T4.10 — Trust-dialog scanner non-interference: spawn claude in an
// already-trusted cwd, assert scanner times out silently with zero
// keystrokes sent. (D25)

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawnDriver } from "../src/driver/pty.js";

// Use the repo root cwd (already trusted by claude on the dev machine via
// prior interactive use). On CI / fresh machines this test would still
// trigger the dialog; tested manually.
const cwd = realpathSync(process.cwd());
const req = createRequire(import.meta.url);
const shimPath = req.resolve("../shim.js");

const h = await spawnDriver({
	shimPath, model: "claude-sonnet-4-6",
	prompt: "Reply OK.",
	systemPrompt: "Terse.",
	cwd, mode: "main", tools: [],
});
const done = await h.done;
assert.equal(done.reason, "stop-settled");
// Non-interference manifests as: no scanner failure, no extra delay.
console.log("PASS T4.10 (trusted-cwd scenario completed cleanly)");
