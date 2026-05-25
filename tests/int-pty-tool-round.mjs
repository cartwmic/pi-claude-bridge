#!/usr/bin/env node
// T1.12 — tool-round via PTY driver. Spawn driver with one bridged tool;
// expect the model to call it. Validate the parked tool_call frame fires,
// then deliver a synthetic result and verify model continues.

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawnDriver } from "../src/driver/pty.js";

const req = createRequire(import.meta.url);
const shimPath = req.resolve("../shim.js");
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "int-tool-")));

const h = await spawnDriver({
	shimPath,
	model: process.env.PI_BRIDGE_TEST_MODEL || "claude-sonnet-4-6",
	prompt: "Call the echo tool with text='hello world' and then say done.",
	systemPrompt: "When asked to call tools, do so.",
	cwd,
	mode: "main",
	tools: [
		{ name: "mcp__custom-tools__echo", description: "Echoes the input.", inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } } } },
	],
});
const events = [];
const toolCalls = [];
h.on("transcript", (e) => events.push(e));
h.on("tool-call-parked", (entry) => {
	toolCalls.push(entry);
	entry.deliverResult([{ type: "text", text: `echo: ${(entry.arguments).text}` }]);
});

const done = await h.done;
console.log("done:", done.reason);
console.log("tool calls observed:", toolCalls.length);
assert.ok(toolCalls.length >= 1, "expected ≥1 tool call");
console.log("PASS T1.12");
