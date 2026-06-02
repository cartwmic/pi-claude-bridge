#!/usr/bin/env node
// T1.11 — FIRST end-to-end held-open tool round-trip through pi + claude-p.
// Drives real pi (RPC mode, CLAUDE_BRIDGE_DRIVER=claude-p,
// model claude-bridge/claude-haiku-4-5) with a test extension that registers a
// bridged pi tool (SlowTool, returns a known string). Asserts the FULL round-trip:
//
//   model emits tool_use (mcp__custom-tools__SlowTool)
//     → shim parks the tools/call (holds open)
//     → onRouterPark pushes a pi toolCall block keyed by the router-minted piId
//       and ends the pi stream
//     → pi executes the tool
//     → pi delivers the result via the NEXT streamSimple() (toolResult.id === piId)
//     → Case 1 resolves the parked resolver (router.deliver), unblocking the shim
//     → model continues and the final text contains the tool's returned string.
//
// Load-bearing assertion: the piId↔toolResult.id resolution. Also confirms
// EXACTLY ONE real tool execution (the observational stdout tool-use is
// display-only and must NOT cause a second execution).
//
// Concurrency 1. Does NOT override CLAUDE_CONFIG_DIR/HOME. Retries flaky turns.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const TEST_TIMEOUT = 120_000;

// See int-claude-p-main-turn.mjs: re-add this repo's node_modules/.bin so the
// `claude-p` driver binary resolves on the pi subprocess PATH.
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = `${REPO}/node_modules/.bin`;
const cleanPath = process.env.PATH.split(":").filter((p) => !p.includes("node_modules")).join(":");
const PATH_WITH_CLAUDE_P = `${BIN}:${cleanPath}`;

const harness = createRpcHarness({
	name: "claude-p-tool-round",
	args: ["-e", "./tests/fixtures/slow-tool-extension.ts", "--model", "claude-bridge/claude-haiku-4-5"],
	env: { CLAUDE_BRIDGE_DRIVER: "claude-p", PATH: PATH_WITH_CLAUDE_P },
	defaultTimeout: TEST_TIMEOUT,
});

// Run one prompt; collect text + count how many times pi actually executed a
// bridged tool (tool_execution_start envelopes). Returns { text, toolExecutions }.
async function runToolTurn(prompt) {
	const { send, waitForMatch, collectText, addListener } = harness;
	const collector = collectText();
	let toolExecutions = 0;
	const removeExec = addListener((msg) => {
		if (msg.type === "tool_execution_start") toolExecutions++;
	});
	try {
		await send({ type: "prompt", message: prompt });
		await waitForMatch((m) => m.type === "agent_end", "agent_end");
	} finally {
		removeExec();
	}
	const text = collector.stop();
	return { text, toolExecutions };
}

describe("claude-p held-open tool round-trip (T1.11)", () => {
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

	it("model→shim-park→pi-exec→deliver→resolve→continue, exactly one execution", { timeout: TEST_TIMEOUT }, async () => {
		// SlowTool returns "SlowTool completed after 1000ms". Ask the model to call
		// it and then echo the result verbatim — the final text must contain that
		// string, which can ONLY appear if the tool result threaded back through
		// the held-open park/resolve cycle.
		const prompt =
			"Call SlowTool with seconds=1. Then repeat back exactly what it returned, nothing else.";
		let result = null;
		let lastErr = null;
		for (let attempt = 1; attempt <= 3; attempt++) {
			try {
				const r = await runToolTurn(prompt);
				if (r.text && /slowtool completed/i.test(r.text)) {
					result = r;
					break;
				}
				lastErr = new Error(`no tool result in text (attempt ${attempt}): ${JSON.stringify(r.text?.slice(0, 200))}`);
			} catch (err) {
				lastErr = err;
			}
			if (harness.pi()?.exitCode !== null) {
				harness.start();
				await new Promise((r) => setTimeout(r, 2000));
			}
		}
		assert.ok(result, `tool round-trip did not complete after 3 attempts: ${lastErr?.message}`);

		// Final text contains the tool's returned string — proves the full
		// park → pi-exec → deliver → resolve → continue cycle.
		assert.match(
			result.text.toLowerCase(),
			/slowtool completed after \d+ms/,
			`final text missing tool result: ${JSON.stringify(result.text.slice(0, 300))}`,
		);

		// EXACTLY ONE real tool execution. The observational stdout tool-use is
		// display-only (processDriverEvent "tool-use" case) and must NOT trigger a
		// second pi execution. The successful attempt fired exactly one.
		assert.equal(
			result.toolExecutions,
			1,
			`expected exactly 1 tool execution on the successful turn, got ${result.toolExecutions}`,
		);

		console.log(`  text=${JSON.stringify(result.text.trim().slice(0, 120))}`);
		console.log(`  toolExecutions=${result.toolExecutions}`);
	});
});
