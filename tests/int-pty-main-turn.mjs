#!/usr/bin/env node
// T1.11 — end-to-end main-provider turn via PTY driver, text-only.
// Bootstrap: spawn driver in main mode, no tools, simple prompt, await done.
// Validates: scenario "Fresh turn spawns one PTY with bridged tool surface"
// from claude-tui-driver.pty-spawn-with-model-selection.

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawnDriver } from "../src/driver/pty.js";

const req = createRequire(import.meta.url);
const shimPath = req.resolve("../dist/mcp/shim.js");
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "int-pty-main-")));

const h = await spawnDriver({
	shimPath,
	model: process.env.PI_BRIDGE_TEST_MODEL || "claude-sonnet-4-6",
	prompt: "Reply with the single word OK.",
	systemPrompt: "You are a terse helper.",
	cwd,
	mode: "main",
	tools: [],
});

const events = [];
h.on("transcript", (e) => events.push(e));
const done = await h.done;
console.log("done reason:", done.reason);
const texts = events.filter((e) => e.kind === "text-delta");
console.log("text events:", texts.length, "joined:", texts.map((t) => t.text).join(""));
assert.equal(done.reason, "stop-settled", `expected stop-settled; got ${done.reason}`);
assert.ok(texts.length >= 1, "expected ≥1 text-delta event");
console.log("PASS T1.11");
