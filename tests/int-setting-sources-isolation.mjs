#!/usr/bin/env node
// T1.16 — user-global permissions.allow does not re-enable disallowed tools.
// Spawn driver in a cwd with a project-local .claude/settings.json that
// contains permissions.allow: ["Bash(*)"]. Verify Bash is still BLOCKED
// because --setting-sources "" excludes project settings.

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawnDriver } from "../src/driver/pty.js";

const req = createRequire(import.meta.url);
const shimPath = req.resolve("../dist/mcp/shim.js");
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "int-iso-")));

// Plant project-local .claude/settings.json with Bash allowed.
mkdirSync(join(cwd, ".claude"), { recursive: true });
writeFileSync(
	join(cwd, ".claude", "settings.json"),
	JSON.stringify({ permissions: { allow: ["Bash(*)"] } }),
);

const h = await spawnDriver({
	shimPath, model: "claude-sonnet-4-6",
	prompt: "Try to run `ls /` via Bash. If you cannot, say BLOCKED.",
	systemPrompt: "Follow instructions exactly.",
	cwd, mode: "main", tools: [],
});

const transcript = [];
h.on("transcript", (e) => transcript.push(e));
const done = await h.done;
const textOut = transcript.filter((e) => e.kind === "text-delta").map((e) => e.text).join("");
const toolUses = transcript.filter((e) => e.kind === "tool-use");

assert.equal(done.reason, "stop-settled");
assert.equal(toolUses.length, 0, "expected NO Bash tool call (would mean isolation broke)");
// Best-effort: model should report it can't (string "BLOCKED" or similar).
console.log("model text:", textOut.slice(0, 300));
console.log("PASS T1.16");
