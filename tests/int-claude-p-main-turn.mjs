#!/usr/bin/env node
// T1.10 — FIRST end-to-end main-provider turn (text only) through the claude-p
// driver path. Drives real pi (RPC mode) with CLAUDE_BRIDGE_DRIVER=claude-p and
// model claude-bridge/claude-haiku-4-5, a trivial text prompt. Proves the full
// stream path: spawn → stdout → ClaudePStreamParser → processDriverEvent →
// pi text events (text_start/delta/end) → finalizeClaudePFrame → done.
//
// Concurrency 1. Does NOT override CLAUDE_CONFIG_DIR/HOME. Retries flaky
// claude-p turns up to 3x.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const TEST_TIMEOUT = 120_000;

// The `claude-p` driver binary lives in this repo's node_modules/.bin (it's an
// npm dependency), and the driver spawns it by bare name via PATH. The harness
// deliberately strips node_modules from PATH (to use the global `pi`), so we
// must re-add this repo's .bin so the claude-p binary resolves. The harness
// spreads `env` last over its computed PATH, so a PATH here wins.
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = `${REPO}/node_modules/.bin`;
const cleanPath = process.env.PATH.split(":").filter((p) => !p.includes("node_modules")).join(":");
const PATH_WITH_CLAUDE_P = `${BIN}:${cleanPath}`;

const harness = createRpcHarness({
	name: "claude-p-main-turn",
	args: ["--model", "claude-bridge/claude-haiku-4-5"],
	env: { CLAUDE_BRIDGE_DRIVER: "claude-p", PATH: PATH_WITH_CLAUDE_P },
	defaultTimeout: TEST_TIMEOUT,
});

// Run a single text turn, collecting assistant text + usage. Returns
// { text, usage }. Throws on timeout / agent_end without text.
async function runTextTurn(prompt) {
	const { send, waitForMatch, collectText, addListener } = harness;
	const collector = collectText();
	let usage = null;
	const removeUsage = addListener((msg) => {
		// pi surfaces usage on message_end / turn_end / agent_end envelopes.
		const u =
			msg?.message?.usage ??
			msg?.usage ??
			msg?.partial?.usage ??
			msg?.assistantMessageEvent?.message?.usage ??
			msg?.assistantMessageEvent?.partial?.usage;
		if (u && (u.input || u.output || u.totalTokens)) usage = u;
	});
	try {
		await send({ type: "prompt", message: prompt });
		await waitForMatch((m) => m.type === "agent_end", "agent_end");
	} finally {
		removeUsage();
	}
	const text = collector.stop();
	return { text, usage };
}

describe("claude-p main-provider text turn (T1.10)", () => {
	const { RPC_LOG, DEBUG_LOG } = harness;

	before(async () => {
		harness.start();
		await new Promise((r) => setTimeout(r, 2000));
	});

	after(async () => {
		await harness.stop();
		console.log(`  RPC log: ${RPC_LOG}`);
		console.log(`  Debug log: ${DEBUG_LOG}`);
	});

	it("returns coherent assistant text, completes the turn, reports usage", { timeout: TEST_TIMEOUT }, async () => {
		const prompt = "Reply with exactly the word READY and nothing else.";
		let result = null;
		let lastErr = null;
		for (let attempt = 1; attempt <= 3; attempt++) {
			try {
				const r = await runTextTurn(prompt);
				if (r.text && r.text.trim().length > 0) {
					result = r;
					break;
				}
				lastErr = new Error(`empty assistant text (attempt ${attempt})`);
			} catch (err) {
				lastErr = err;
			}
			// Restart pi between attempts if it died.
			if (harness.pi()?.exitCode !== null) {
				harness.start();
				await new Promise((r) => setTimeout(r, 2000));
			}
		}
		assert.ok(result, `no coherent text after 3 attempts: ${lastErr?.message}`);
		// Coherent assistant text: the model was asked for READY.
		assert.match(result.text, /READY/i, `expected READY, got: ${JSON.stringify(result.text)}`);
		// Usage must be present (proves the usage driver event threaded through).
		assert.ok(result.usage, "expected usage to be present on the turn");
		const totalIn = result.usage.input ?? 0;
		const totalOut = result.usage.output ?? 0;
		const total = result.usage.totalTokens ?? totalIn + totalOut;
		assert.ok(total > 0, `expected nonzero token usage, got ${JSON.stringify(result.usage)}`);
		console.log(`  text=${JSON.stringify(result.text.trim().slice(0, 80))}`);
		console.log(`  usage=${JSON.stringify(result.usage)}`);
	});
});
