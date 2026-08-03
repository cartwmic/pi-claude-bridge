#!/usr/bin/env node
// T2.5 — capture ABSENT-call → error, against the REAL claude-p driver.
//
// Steers the real model to answer in TEXT ONLY and explicitly NOT call the
// capture tool. The shim therefore never stashes; at turn-end the capture path
// finds no IPC stash and surfaces an error ("model did not call capture tool")
// with stopReason "error" (surface-absent-capture-tool-call-as-error).
//
// Gated behind RUN_REAL_CLAUDE_P=1. Concurrency 1; does NOT override
// CLAUDE_CONFIG_DIR/HOME. Retries flaky turns up to 3x.
//
//   RUN_REAL_CLAUDE_P=1 node --import tsx --test tests/int-claude-p-capture-error.mjs

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

const LOG_DIR = mkdtempSync(join(tmpdir(), "bridge-int-cap-error-"));
process.env.CLAUDE_BRIDGE_DEBUG_PATH = join(LOG_DIR, "bridge.log");
process.env.CLAUDE_BRIDGE_DEBUG = "1";

const {
	streamClaudeAgentSdk,
	__setPiApiRefForTests,
	__resetCachedSessionForTests,
} = await import("../index.js");
import { submitDigestTool } from "./fixtures/submit-digest-schema.js";

const DRIVER = process.env.CLAUDE_BRIDGE_DRIVER ?? "claude-p";
assert.match(DRIVER, /^(claude-p|claude-print)$/);
const ENABLED = process.env.RUN_REAL_CLAUDE_DRIVER === "1" || process.env.RUN_REAL_CLAUDE_P === "1";
const TIMEOUT = 120_000;
const MODEL = {
	id: process.env.CLAUDE_BRIDGE_INTEGRATION_MODEL ?? "claude-sonnet-4-6",
	cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};
const ts = () => Date.now();

async function runNoCall() {
	// Strongly steer the model to NOT call any tool — answer in plain text only.
	const stream = streamClaudeAgentSdk(MODEL, {
		systemPrompt:
			"You are a plain chat assistant. Under NO circumstances call any tool or function. " +
			"Do not call submit_digest. Simply reply in a single short sentence of plain text.",
		messages: [{ role: "user", content: "Say hello in one short sentence. Do not use any tools.", timestamp: ts() }],
		tools: [submitDigestTool],
	});
	return await stream.result();
}

describe(`${DRIVER} capture absent-call error`, { skip: !ENABLED ? "set RUN_REAL_CLAUDE_DRIVER=1 to run" : false }, () => {
	let restoreApi = null;

	afterEach(() => { restoreApi?.(); restoreApi = null; __resetCachedSessionForTests(); });

	it("model never calls the capture tool → stopReason error", { timeout: TIMEOUT }, async () => {
		restoreApi = __setPiApiRefForTests({ getActiveTools: () => [] });

		let result = null;
		let lastErr = null;
		for (let attempt = 1; attempt <= 3; attempt++) {
			try {
				const r = await runNoCall();
				if (r.stopReason === "error") { result = r; break; }
				// If the model called the tool anyway (non-determinism), retry with
				// the same strong steer; only fail after exhausting attempts.
				lastErr = new Error(`attempt ${attempt}: stopReason=${r.stopReason} (model called the tool despite steer)`);
			} catch (err) {
				lastErr = err;
			}
		}
		assert.ok(result, `expected stopReason error after 3 attempts: ${lastErr?.message ?? lastErr}`);

		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage ?? "", /did not call capture tool|abnormally/i);
		console.log(`  driver=${DRIVER} absent-call error surfaced: "${result.errorMessage}"`);
	});
});
