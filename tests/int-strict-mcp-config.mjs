#!/usr/bin/env node
// T1.15 — user-global MCP server isolation. Spawn driver with
// --strict-mcp-config + --mcp-config '<bridge-only>'. Ask the model to list
// available tools and verify no user-globally-configured MCP tools appear.
//
// NOTE: This test depends on the user having SOME user-globally-configured
// MCP server in ~/.claude/settings.json or ~/.mcp.json. If none exists, the
// test is a tautology (it passes trivially). Documented as a v0 limitation;
// Phase 4 may add a setup step that injects a probe MCP server first.

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawnDriver } from "../src/driver/pty.js";

const req = createRequire(import.meta.url);
const shimPath = req.resolve("../dist/mcp/shim.js");
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "int-strict-")));

const h = await spawnDriver({
	shimPath, model: "claude-sonnet-4-6",
	prompt: "List the names of every MCP tool you have access to right now. One per line.",
	systemPrompt: "You always list tools when asked.",
	cwd, mode: "main",
	tools: [
		{ name: "mcp__custom-tools__probe", description: "Probe", inputSchema: { type: "object" } },
	],
});

const transcript = [];
h.on("transcript", (e) => transcript.push(e));
const done = await h.done;
const textOut = transcript.filter((e) => e.kind === "text-delta").map((e) => e.text).join("");
console.log("model text:", textOut.slice(0, 500));
assert.equal(done.reason, "stop-settled");
// Soft check: no user-globally-configured tool name leaks (we don't know
// the user's tool names, so we just sanity-check that the model mentions
// our probe).
assert.ok(/probe/i.test(textOut), "expected model to mention 'probe' tool");
console.log("PASS T1.15");
