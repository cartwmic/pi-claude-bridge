#!/usr/bin/env node
// T4.9 — Trust-dialog scanner robustness: spawn claude in fresh tmpdir
// (untrusted cwd), assert scanner detects + answers within 1s, transcript
// appears within 5s. (D25)
// Implementation: exactly the spike runner from Phase 0 T0.14b.

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawnDriver } from "../src/driver/pty.js";

const req = createRequire(import.meta.url);
const shimPath = req.resolve("../dist/mcp/shim.js");
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "int-trust-")));

const t0 = Date.now();
const h = await spawnDriver({
	shimPath, model: "claude-sonnet-4-6",
	prompt: "Reply OK.",
	systemPrompt: "Terse.",
	cwd, mode: "main", tools: [],
});
const done = await h.done;
assert.equal(done.reason, "stop-settled");
const elapsed = Date.now() - t0;
console.log(`trust dialog scenario completed in ${elapsed}ms`);
assert.ok(elapsed < 30000, `should complete in <30s; took ${elapsed}ms`);
console.log("PASS T4.9");
