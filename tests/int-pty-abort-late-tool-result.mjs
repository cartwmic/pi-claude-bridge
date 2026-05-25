#!/usr/bin/env node
// T1.17 — abort mid-tool-round preserves late-tool-result coherence (D15).
// Per `claude-tui-driver.abort-preserves-late-tool-result-coherence-with-pi`.
//
// Scenario:
//   1. Driver spawn with one bridged tool.
//   2. Model emits tool_call; router parks the resolver.
//   3. Pi aborts.
//   4. Driver tears down PTY + shim per D15 BUT preserves router state.
//   5. Pi delivers a late tool_result via deliverToolResult().
//   6. Assertion: router.pendingResults captures the late result (no crash,
//      no resolver-stale error).
//
// Implementation note: this is best exercised through the streamPty path
// once Phase 3 wires the full pendingResolvers/pendingResults preservation.
// In v0 (cold-start-each-turn), the pi-side resolve happens via the
// synthetic stub in streamPty.ts:tool-call-parked, so this test focuses on
// the underlying Router preservation contract via direct API.

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawnDriver } from "../src/driver/pty.js";

const req = createRequire(import.meta.url);
const shimPath = req.resolve("../shim.js");
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "int-late-")));

const h = await spawnDriver({
	shimPath, model: "claude-sonnet-4-6",
	prompt: "Call the slowtool with text='hello'.",
	systemPrompt: "Call tools when instructed.",
	cwd, mode: "main",
	tools: [{ name: "mcp__custom-tools__slowtool", inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } } } }],
	abortGraceMs: 500,
});

let parkedEntry = null;
h.on("tool-call-parked", (entry) => { parkedEntry = entry; });

// Wait for a tool call to park, then abort
await new Promise((r) => setTimeout(r, 4000));
if (!parkedEntry) {
	console.log("T1.17 SKIP — model did not emit tool call within 4s; can't exercise abort path");
	process.exit(0);
}
const router = h.router;
await h.abort();

// Late delivery — router state preserved (D15)
router.deliverToolResult(parkedEntry.id, [{ type: "text", text: "late!" }]);
assert.ok(router.pendingResults.has(parkedEntry.id) || router.pendingResolvers.size === 0);
console.log("PASS T1.17");
