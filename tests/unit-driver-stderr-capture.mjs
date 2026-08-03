#!/usr/bin/env node
// Unit tests for child-stderr capture + premature-error surfacing in
// src/driver/claudeP.ts (driver-diagnostics capability).
//
// ACs:
//   driver-diagnostics.child-stderr-is-captured-to-a-per-spawn-debug-file
//   driver-diagnostics.premature-exit-error-surfaces-the-last-stderr-lines
//
// A `node` stand-in bin writes known marker lines to STDERR, then exits non-zero
// WITHOUT printing a terminal `result` line on stdout. The driver must (a) write
// the stderr to a per-spawn file under diagnosticsDir, and (b) include the last
// stderr lines in the surfaced `error` event's errorMessage.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnClaudeP } from "../src/driver/claudeP.js";

const QUIET = { warn() {}, info() {}, error() {} };

function baseCfg(overrides = {}) {
	return {
		model: "claude-sonnet-4-6",
		systemPrompt: { kind: "text", text: "SYS" },
		prompt: { kind: "positional", text: "hello" },
		mcpConfig: '{"mcpServers":{}}',
		session: { kind: "fresh", sessionId: "stderr-session-0" },
		...overrides,
	};
}

// Child: write 3 marker lines to stderr, NOTHING parseable to stdout, exit 2.
const CHILD_CJS = [
	'process.stderr.write("PromptNotAccepted: line one\\n");',
	'process.stderr.write("StopTimeout: line two\\n");',
	'process.stderr.write("UPSTREAM_MARKER_LAST: line three\\n");',
	'process.stderr.write(`MCP_IDLE:${process.env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT}\\n`);',
	'setTimeout(() => process.exit(2), 50);',
].join("\n");

function makeStubBin() {
	const dir = mkdtempSync(join(tmpdir(), "claudep-stderr-"));
	const childPath = join(dir, "child.cjs");
	writeFileSync(childPath, CHILD_CJS, "utf8");
	const bin = join(dir, "stub.sh");
	const body = `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(childPath)} "$@"\n`;
	writeFileSync(bin, body, { mode: 0o755 });
	chmodSync(bin, 0o755);
	return { bin, dir };
}

// On a premature exit the driver also emits the in-flight state dump
// (driver-diagnostics.in-flight-state-dump-on-abnormal-termination) — exercised
// here via the same premature-exit path (asserted live in tests/int-claude-p-abort).
describe("spawnClaudeP — child stderr surfaces in the premature error event", () => {
	it("error event errorMessage includes the last stderr lines", async () => {
		const { bin, dir } = makeStubBin();
		const events = [];
		const h = spawnClaudeP(baseCfg(), {
			binPath: bin,
			onEvent: (ev) => events.push(ev),
			logger: QUIET,
			diagnosticsDir: dir,
		});
		const r = await h.done;
		assert.equal(r.stopReason, "error", "premature exit with no result classifies as error");

		const err = events.find((e) => e.kind === "error");
		assert.ok(err, "an error event must be emitted on premature exit");
		assert.match(err.errorMessage, /premature termination/, "keeps the premature-termination summary");
		assert.match(err.errorMessage, /last stderr:/, "appends a last-stderr section");
		assert.match(err.errorMessage, /UPSTREAM_MARKER_LAST: line three/, "includes the captured upstream stderr");
		assert.match(err.errorMessage, /MCP_IDLE:0/, "interactive driver disables upstream MCP idle cutoff");
	});

	// driver-diagnostics.child-stderr-is-captured-to-a-per-spawn-debug-file
	it("writes the child stderr to a per-spawn debug file under diagnosticsDir", async () => {
		const { bin, dir } = makeStubBin();
		const h = spawnClaudeP(baseCfg(), {
			binPath: bin,
			onEvent: () => {},
			logger: QUIET,
			diagnosticsDir: dir,
		});
		await h.done;
		const stderrFiles = readdirSync(dir).filter((f) => f.startsWith("driver-claude-p-stderr-"));
		assert.equal(stderrFiles.length, 1, "exactly one per-spawn stderr file is written");
		const contents = readFileSync(join(dir, stderrFiles[0]), "utf8");
		assert.match(contents, /PromptNotAccepted: line one/, "the full stderr is persisted to the file");
		assert.match(contents, /UPSTREAM_MARKER_LAST: line three/);
	});

	it("no stderr file is written when diagnosticsDir is unset, but the error still carries the tail", async () => {
		const { bin } = makeStubBin();
		const events = [];
		const h = spawnClaudeP(baseCfg(), {
			binPath: bin,
			onEvent: (ev) => events.push(ev),
			logger: QUIET,
			// no diagnosticsDir
		});
		const r = await h.done;
		assert.equal(r.stopReason, "error");
		const err = events.find((e) => e.kind === "error");
		assert.match(err.errorMessage, /UPSTREAM_MARKER_LAST/, "tail still surfaces from the in-memory ring");
	});
});
