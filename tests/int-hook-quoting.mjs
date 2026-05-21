#!/usr/bin/env node
// T1.20 — hook command with shim path containing a space (D19 / Round-5 A.P2).
// Verify buildSettingsJson's shell-quoting correctly wraps the shim path
// so claude's sh-exec of the hook command works.

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, copyFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawnDriver } from "../src/driver/pty.js";

const req = createRequire(import.meta.url);
const realShim = req.resolve("../dist/mcp/shim.js");
const dir = realpathSync(mkdtempSync(join(tmpdir(), "int-quote-")));
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "int-quote-cwd-")));

const dirWithSpace = join(dir, "has space");
mkdirSync(dirWithSpace, { recursive: true });
const quotedShim = join(dirWithSpace, "shim.js");
copyFileSync(realShim, quotedShim);
chmodSync(quotedShim, 0o755);

const h = await spawnDriver({
	shimPath: quotedShim,
	model: "claude-sonnet-4-6",
	prompt: "Reply OK.",
	systemPrompt: "Terse.",
	cwd, mode: "main", tools: [],
});
const hooks = [];
h.on("hook", (e) => hooks.push(e));
const done = await h.done;
assert.equal(done.reason, "stop-settled");
assert.ok(hooks.find((e) => e.event === "SessionStart"), "SessionStart hook must fire even with quoted shim path");
console.log("PASS T1.20");
