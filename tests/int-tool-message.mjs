#!/usr/bin/env node
// Integration tests for tool execution + message interaction scenarios.
// Uses pi in RPC mode with the bridge + SlowTool test extension.
// Exercises how the bridge handles messages arriving during tool execution.

import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

// claude-p adds ~5s interactive-boot per spawn (steer/abort tests do 2 spawns) +
// possible D33 StopTimeout retry, so the SDK-era 30s is too tight. Override via
// TOOL_MSG_TIMEOUT.
const TEST_TIMEOUT = Number(process.env.TOOL_MSG_TIMEOUT ?? 90_000);

const harness = createRpcHarness({
	name: "tool-message",
	args: ["-e", "./tests/fixtures/slow-tool-extension.ts", "--model", "claude-bridge/claude-haiku-4-5"],
	defaultTimeout: TEST_TIMEOUT,
});

describe("tool-message integration", () => {
	const { start, stop, send, waitForEvent, waitForMatch, collectText, promptAndWait, DEBUG_LOG, RPC_LOG } = harness;

	// --- Lifecycle ---

	before(async () => {
		harness.start();
		await new Promise((r) => setTimeout(r, 2000));
	});

	afterEach(async () => {
		if (harness.pi().exitCode !== null) {
			harness.start();
			await new Promise((r) => setTimeout(r, 2000));
		}
	});

	after(async () => {
		await harness.stop();
		console.log(`  RPC log: ${RPC_LOG}`);
		console.log(`  Debug log: ${DEBUG_LOG}`);
	});

	// --- Tests ---

	it("tool call completes normally", { timeout: TEST_TIMEOUT }, async () => {
		const text = await promptAndWait(
			"Call SlowTool with seconds=1. Then repeat exactly what it returned, nothing else."
		);
		assert.match(text.toLowerCase(), /slowtool completed/);
	});

	it("followUp during tool execution delivers after tool completes", { timeout: TEST_TIMEOUT }, async () => {
		const collector = collectText();
		await send({
			type: "prompt",
			message: "Call SlowTool with seconds=5. Then repeat exactly what it returned.",
		});
		await waitForEvent("tool_execution_start");
		// followUp is queued by pi until the current turn finishes
		await send({
			type: "prompt",
			message: "This is a followUp during tool execution.",
			streamingBehavior: "followUp",
		});
		await waitForEvent("agent_end");
		const text = collector.stop();
		assert.match(text.toLowerCase(), /slowtool completed/);
	});

	// NOTE: The "steer during tool execution still delivers tool result" tests
	// (single + parallel) were intentionally removed in the SDK-native
	// refactor. Old behavior (deferred-message replay: let the tool finish,
	// then send the steer as a continuation query) was explicitly deleted per
	// the refactor charter ("no deferred-message replay" in SCENARIOS.md).
	// New behavior: a steer during tool execution supersedes — the active
	// query is interrupted, the in-flight tool result is orphaned, and the
	// steer becomes the next turn's fresh prompt. Matches S5 (mid-stream
	// steering) and S13 (rapid abort+retype). See `streamSimple` Case 3 in
	// index.ts. Validation of the new semantics is via the tmux scenario
	// harness, not these unit-style tests.

	it("steer during text response (no tool call) completes both turns", { timeout: TEST_TIMEOUT }, async () => {
		// Steer during text-only streaming: the assistant is generating text (no tool
		// calls), a steer arrives, and pi delivers it after the current turn ends.
		// Risk: if activeQuery hasn't been cleared by the time pi calls streamSimple
		// for the steer, the bridge enters the tool-result-delivery path incorrectly.
		const collector = collectText();
		await send({
			type: "prompt",
			message: "Write at least 5 detailed paragraphs about the history of computing, from Babbage to modern times. Do NOT call any tools. Do NOT stop early.",
		});
		// Wait until text is actually streaming before injecting the steer
		await waitForMatch(
			(msg) => msg.type === "message_update" && msg.assistantMessageEvent?.type === "text_delta",
			"text_delta during assistant response",
		);
		await send({
			type: "prompt",
			message: "After you finish, also say the exact word 'PINEAPPLE' on its own line.",
			streamingBehavior: "steer",
		});
		await waitForEvent("agent_end");
		const text = collector.stop();
		assert.match(text.toLowerCase(), /pineapple/);
	});

	it("steer during tool execution is visible to assistant", { timeout: TEST_TIMEOUT }, async () => {
		// Bug: when a steer arrives during tool execution, pi drains it at the turn
		// boundary and injects it into context alongside the tool result. The bridge
		// sees activeQuery=true, enters tool-result-delivery mode, extracts the tool
		// result, but silently ignores the trailing user message (the steer). Claude
		// never sees the steer content.
		const collector = collectText();
		await send({
			type: "prompt",
			message: "Call SlowTool with seconds=2. After it returns, repeat exactly what it returned.",
		});
		await waitForEvent("tool_execution_start");
		await send({
			type: "prompt",
			message: "IMPORTANT: Also say the exact word 'MANGO' on its own line in your response.",
			streamingBehavior: "steer",
		});
		await waitForEvent("agent_end");
		const text = collector.stop();
		assert.match(text.toLowerCase(), /mango/, `Steer content not visible to assistant: ${text.slice(0, 300)}`);
	});

	it("abort during tool execution recovers cleanly", { timeout: TEST_TIMEOUT }, async () => {
		await send({
			type: "prompt",
			message: "Call SlowTool with seconds=30.",
		});
		await waitForEvent("tool_execution_start");
		const idle = waitForEvent("agent_end");
		await send({ type: "abort" });
		await idle;
		// Next prompt should work without hanging
		const text = await promptAndWait("Reply with just the word 'recovered'.");
		assert.match(text.toLowerCase(), /recovered/);
	});
});
