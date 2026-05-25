#!/usr/bin/env node
// T1.19 — warm-resume with immediate assistant output; baseline offset
// captured BEFORE spawn (D24 / Round-5 B.P1#4).
//
// Test flow:
//   1. First turn: spawn fresh, get session id and transcript path.
//   2. Compute the transcript's byte size BEFORE spawning the resume.
//   3. Second turn: spawn with resumeSessionId; tailer opens from baseline,
//      not EOF.
//   4. Assert: at least one new assistant text-delta arrives in turn 2
//      (proving the immediate post-resume output wasn't lost).

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawnDriver } from "../src/driver/pty.js";

const req = createRequire(import.meta.url);
const shimPath = req.resolve("../shim.js");
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "int-warm-")));

console.log("Turn 1 — fresh");
const h1 = await spawnDriver({
	shimPath, model: "claude-sonnet-4-6",
	prompt: "Remember the number 42. Reply OK.",
	systemPrompt: "You memorize numbers.",
	cwd, mode: "main", tools: [],
});
await h1.done;
const sessionId = h1.sessionId;
const transcriptPath = h1.transcriptPath;
const sizeBeforeResume = statSync(transcriptPath).size;
console.log(`turn 1 done; transcript size = ${sizeBeforeResume} bytes`);

console.log("Turn 2 — warm-resume");
const h2 = await spawnDriver({
	shimPath, model: "claude-sonnet-4-6",
	prompt: "What number did I tell you to remember?",
	systemPrompt: "You memorize numbers.",
	cwd, mode: "main", tools: [],
	resumeSessionId: sessionId,
});
const events2 = [];
h2.on("transcript", (e) => events2.push(e));
await h2.done;

const turn2Texts = events2.filter((e) => e.kind === "text-delta");
console.log("turn 2 texts:", turn2Texts.length, turn2Texts.map((t) => t.text).join(""));
assert.ok(turn2Texts.length >= 1, "expected ≥1 text-delta in turn 2");
const joined = turn2Texts.map((t) => t.text).join("");
assert.ok(/42/.test(joined), `expected '42' in turn 2 reply; got: ${joined}`);
console.log("PASS T1.19");
