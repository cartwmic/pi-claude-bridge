#!/usr/bin/env node
// Authenticated end-to-end main-provider and warm-resume contract. Select driver
// with CLAUDE_BRIDGE_DRIVER=claude-p|claude-print; defaults to claude-p.
//
// Concurrency 1. Does NOT override CLAUDE_CONFIG_DIR/HOME. A semantically
// wrong model response is retried only after a full harness restart so a failed
// attempt cannot pollute the warm-resume contract under test.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const TEST_TIMEOUT = 120_000;
const DRIVER = process.env.CLAUDE_BRIDGE_DRIVER ?? "claude-p";
const MODEL = process.env.CLAUDE_BRIDGE_INTEGRATION_MODEL ?? "claude-sonnet-4-6";
assert.match(DRIVER, /^(claude-p|claude-print)$/);

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
	name: `${DRIVER}-main-turn`,
	args: ["--model", `claude-bridge/${MODEL}`],
	env: { CLAUDE_BRIDGE_DRIVER: DRIVER, PATH: PATH_WITH_CLAUDE_P },
	defaultTimeout: TEST_TIMEOUT,
});

// Run a single text turn, collecting assistant text, usage, and normalized
// text-delta count. Throws on timeout / agent_end without text.
async function runTextTurn(prompt) {
	const { send, waitForMatch, collectText, addListener } = harness;
	const collector = collectText();
	let usage = null;
	let textDeltaCount = 0;
	const removeUsage = addListener((msg) => {
		if (msg.type === "message_update" && msg.assistantMessageEvent?.type === "text_delta") textDeltaCount++;
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
	return { text, usage, textDeltaCount };
}

describe(`${DRIVER} main-provider text and resume contract`, () => {
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

	it("returns coherent text, usage, then resumes the same conversation", { timeout: TEST_TIMEOUT * 3 }, async () => {
		let result = null;
		let lastText = "";
		for (let attempt = 1; attempt <= 3; attempt++) {
			try {
				const candidate = await runTextTurn("Compute 17 + 24. Reply with only the decimal result.");
				lastText = candidate.text;
				if (/\b41\b/.test(candidate.text)) {
					result = candidate;
					break;
				}
			} catch (err) {
				lastText = String(err?.message ?? err);
			}
			if (attempt < 3) await harness.restart();
		}
		assert.ok(result, `expected arithmetic result 41 after 3 clean attempts, got: ${JSON.stringify(lastText)}`);
		// Usage must be present (proves the usage driver event threaded through).
		assert.ok(result.usage, "expected usage to be present on the turn");
		const totalIn = result.usage.input ?? 0;
		const totalOut = result.usage.output ?? 0;
		const total = result.usage.totalTokens ?? totalIn + totalOut;
		assert.ok(total > 0, `expected nonzero token usage, got ${JSON.stringify(result.usage)}`);
		const resumed = await runTextTurn("What arithmetic result did you give in your immediately preceding response? Reply with digits only.");
		assert.match(resumed.text, /\b41\b/, `warm turn lost conversation state: ${JSON.stringify(resumed.text)}`);

		if (DRIVER === "claude-print") {
			const phrase = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu";
			const streamed = await runTextTurn(`Repeat exactly this phrase and nothing else: ${phrase}`);
			assert.match(streamed.text.toLowerCase(), /alpha bravo charlie.*xray yankee zulu/s, "direct streaming probe lost expected text");
			assert.ok(streamed.textDeltaCount > 1, `direct turn did not expose multiple live text deltas: ${streamed.textDeltaCount}`);
		}

		const debug = readFileSync(DEBUG_LOG, "utf8");
		assert.match(debug, new RegExp(`streamSimple\\[${DRIVER}\\]: fresh spawn`), "selected driver did not own turn");
		assert.match(debug, /resume=[a-f0-9]/, "second turn did not use warm resume hint");
		if (DRIVER === "claude-print") {
			assert.match(debug, /user frame submitted after MCP readiness/, "direct prompt submission was not readiness-gated");
		}

		console.log(`  driver=${DRIVER}`);
		console.log(`  text=${JSON.stringify(result.text.trim().slice(0, 80))}`);
		console.log(`  resumed=${JSON.stringify(resumed.text.trim().slice(0, 80))}`);
		console.log(`  usage=${JSON.stringify(result.usage)}`);
	});
});
