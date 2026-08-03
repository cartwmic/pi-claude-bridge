#!/usr/bin/env node
// Authenticated capture success through selected real inference driver.
//
// Drives streamClaudeAgentSdk capture with one unregistered capture tool
// (submit_digest). Selected driver spawns real `claude`, which is steered
// (sole MCP tool +
// disallow set) to call submit_digest exactly once. The shim validates + stashes
// the args; the bridge synthesizes the pi toolCall block.
//
// Gated behind RUN_REAL_CLAUDE_P=1 (spawns real claude-p + claude). Concurrency
// 1; does NOT override CLAUDE_CONFIG_DIR/HOME. Retries flaky turns up to 3x.
//
//   RUN_REAL_CLAUDE_P=1 node --import tsx --test tests/int-claude-p-capture-success.mjs

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Value } from "@sinclair/typebox/value";

const LOG_DIR = mkdtempSync(join(tmpdir(), "bridge-int-cap-success-"));
process.env.CLAUDE_BRIDGE_DEBUG_PATH = join(LOG_DIR, "bridge.log");
process.env.CLAUDE_BRIDGE_DEBUG = "1";

const {
	streamClaudeAgentSdk,
	__setPiApiRefForTests,
	__resetCachedSessionForTests,
} = await import("../index.js");
import { submitDigestTool, DigestArgs } from "./fixtures/submit-digest-schema.js";

const DRIVER = process.env.CLAUDE_BRIDGE_DRIVER ?? "claude-p";
assert.match(DRIVER, /^(claude-p|claude-print)$/);
const ENABLED = process.env.RUN_REAL_CLAUDE_DRIVER === "1" || process.env.RUN_REAL_CLAUDE_P === "1";
const TIMEOUT = 120_000;
const MODEL = {
	id: process.env.CLAUDE_BRIDGE_INTEGRATION_MODEL ?? "claude-sonnet-4-6",
	cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};
const ts = () => Date.now();

async function runCapture() {
	const stream = streamClaudeAgentSdk(MODEL, {
		systemPrompt:
			"You are a session digest builder. Call submit_digest exactly once with a " +
			"digest of the conversation. The body must be at least 50 characters. The " +
			"headline must be meaningful. Do not output any other text or call any other tool.",
		messages: [{
			role: "user",
			content:
				"Today I implemented a forced-toolcall capture path for a TypeScript bridge. " +
				"The path advertises a single MCP tool and validates the model's arguments. " +
				"Please submit a digest of this work session now.",
			timestamp: ts(),
		}],
		tools: [submitDigestTool],
	});
	return await stream.result();
}

describe(`${DRIVER} capture success`, { skip: !ENABLED ? "set RUN_REAL_CLAUDE_DRIVER=1 to run" : false }, () => {
	let restoreApi = null;

	afterEach(() => { restoreApi?.(); restoreApi = null; __resetCachedSessionForTests(); });

	it("model calls capture tool → synthesized toolCall block with valid structured content", { timeout: TIMEOUT }, async () => {
		restoreApi = __setPiApiRefForTests({ getActiveTools: () => [] }); // submit_digest → capture

		let result = null;
		let lastErr = null;
		for (let attempt = 1; attempt <= 3; attempt++) {
			try {
				const r = await runCapture();
				if (r.stopReason === "toolUse") { result = r; break; }
				lastErr = new Error(`attempt ${attempt}: stopReason=${r.stopReason} err=${r.errorMessage ?? ""}`);
			} catch (err) {
				lastErr = err;
			}
		}
		assert.ok(result, `capture never succeeded after 3 attempts: ${lastErr?.message ?? lastErr}`);

		assert.equal(result.stopReason, "toolUse");
		assert.equal(result.content.length, 1, "exactly one content block");
		assert.equal(result.content[0].type, "toolCall");
		assert.equal(result.content[0].name, "submit_digest");
		assert.ok(result.content[0].id.startsWith("toolu_"), `id should start with toolu_, got ${result.content[0].id}`);

		const args = result.content[0].arguments;
		assert.ok(typeof args === "object" && args !== null, "arguments must be an object");
		assert.ok(Value.Check(DigestArgs, args), `arguments must satisfy DigestArgs schema. Got: ${JSON.stringify(args)}`);

		// Usage / cost propagated from the terminal result line.
		assert.ok(result.usage.input >= 0, "usage.input populated");
		assert.ok(Number.isFinite(result.usage.cost.total) && result.usage.cost.total >= 0, "cost populated");

		if (result.content[0]) {
			console.log(`  driver=${DRIVER} capture OK: headline="${args.headline}" bodyLen=${args.body?.length} in=${result.usage.input} out=${result.usage.output}`);
		}
	});
});
