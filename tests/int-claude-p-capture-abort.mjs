#!/usr/bin/env node
// T2.6 — capture ABORT mid-flight, against the REAL claude-p driver.
//
// Fires an AbortSignal shortly after a capture-shape complete() is dispatched.
// The capture path must abort its claude-p subprocess (SIGINT → grace →
// SIGKILL of the process group), tear down its router/socket, resolve with
// stopReason "aborted", and leave NO orphan claude-p/claude process behind
// (capture-path-honors-abortsignal + the driver's orphan-reap invariant).
//
// Gated behind RUN_REAL_CLAUDE_P=1. Concurrency 1; does NOT override
// CLAUDE_CONFIG_DIR/HOME.
//
//   RUN_REAL_CLAUDE_P=1 node --import tsx --test tests/int-claude-p-capture-abort.mjs

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

const LOG_DIR = mkdtempSync(join(tmpdir(), "bridge-int-cap-abort-"));
process.env.CLAUDE_BRIDGE_DEBUG_PATH = join(LOG_DIR, "bridge.log");
process.env.CLAUDE_BRIDGE_DEBUG = "1";

const {
	streamClaudeAgentSdk,
	__setPiApiRefForTests,
	__setDriverForTests,
	__resetCachedSessionForTests,
} = await import("../index.js");
import { submitDigestTool } from "./fixtures/submit-digest-schema.js";

const ENABLED = process.env.RUN_REAL_CLAUDE_P === "1";
const TIMEOUT = 120_000;
const MODEL = { id: "claude-haiku-4-5", cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } };
const ts = () => Date.now();

/** Count live claude-p processes (best-effort orphan probe). */
function countClaudeP() {
	try {
		const out = execSync("ps -A -o pid,command", { encoding: "utf8" });
		return out.split("\n").filter((l) => /claude-p(\.js)?\b/.test(l) && !/ps -A/.test(l)).length;
	} catch { return -1; }
}

describe("claude-p capture abort (T2.6)", { skip: !ENABLED ? "set RUN_REAL_CLAUDE_P=1 to run" : false }, () => {
	let restoreDriver = null;
	let restoreApi = null;

	before(() => {
		restoreDriver = __setDriverForTests("claude-p");
		restoreApi = __setPiApiRefForTests({ getActiveTools: () => [] });
	});
	after(() => { restoreApi?.(); restoreDriver?.(); __resetCachedSessionForTests(); });

	it("AbortSignal mid-capture → stopReason aborted, no orphan subprocess", { timeout: TIMEOUT }, async () => {
		const before = countClaudeP();

		const ac = new AbortController();
		const stream = streamClaudeAgentSdk(MODEL, {
			systemPrompt:
				"You are a slow, deliberate digest builder. Think step by step at length about the " +
				"conversation before calling submit_digest. Write a very long, detailed digest.",
			messages: [{
				role: "user",
				content: "Summarize a long, intricate engineering session in exhaustive detail, then submit the digest.",
				timestamp: ts(),
			}],
			tools: [submitDigestTool],
		}, { signal: ac.signal });

		// Abort while the model is (almost certainly still) generating.
		setTimeout(() => ac.abort(), 400);

		const result = await stream.result();
		assert.equal(result.stopReason, "aborted", `expected aborted, got ${result.stopReason} (${result.errorMessage ?? ""})`);
		assert.match(result.errorMessage ?? "", /abort/i);

		// Give the process group time to fully tear down (SIGINT grace + reap).
		await new Promise((r) => setTimeout(r, 3000));

		const after = countClaudeP();
		if (before >= 0 && after >= 0) {
			assert.ok(
				after <= before,
				`capture abort must not leave an orphan claude-p (before=${before} after=${after})`,
			);
		}
		console.log(`  capture abort clean: stopReason=${result.stopReason}, claude-p procs before=${before} after=${after}`);
	});
});
