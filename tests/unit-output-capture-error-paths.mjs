/**
 * Deterministic error-path tests for runCaptureQuery (task 5.7).
 *
 * Uses __setQueryFactoryForTests to inject controlled fake factories and drives
 * streamClaudeAgentSdk end-to-end. No live model calls.
 *
 * Cases:
 *  (a) result.subtype === "error_max_structured_output_retries" → stopReason=error, errorMessage references subtype
 *  (b) result.subtype === "success" but structured_output === undefined → same error path
 *  (c) closeEarly (iterator closes without result) → stopReason=error, errorMessage references "closed without result"
 *  (d) throwSync → stopReason=error, errorMessage references "construction failed"
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Type } from "@sinclair/typebox";
import { streamClaudeAgentSdk, __setQueryFactoryForTests, __setPiApiRefForTests, __resetCachedSessionForTests } from "../index.js";
import { makeFakeFactory } from "./fixtures/mock-sdk-query.mjs";

// ── Helpers ──────────────────────────────────────────────────────────────────

const MOCK_MODEL = {
	id: "claude-haiku-4-5",
	cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

const CAPTURE_TOOL = {
	name: "submit_digest",
	description: "test capture tool",
	parameters: Type.Object({
		body: Type.String({ minLength: 50 }),
		headline: Type.String({ maxLength: 80 }),
	}),
};

/** Context with a single capture tool and minimal messages. */
function captureCtx(overrides = {}) {
	return {
		systemPrompt: "You are a digest builder.",
		messages: [{ role: "user", content: "summarize this session please", timestamp: Date.now() }],
		tools: [CAPTURE_TOOL],
		...overrides,
	};
}

/** Collect all events from a stream. */
async function collectEvents(stream) {
	const events = [];
	for await (const evt of stream) events.push(evt);
	return events;
}

/** Drive one test: inject factory, run streamClaudeAgentSdk, collect events, restore. */
async function runWithFactory(factory, contextOverrides = {}) {
	const restoreFactory = __setQueryFactoryForTests(factory);
	const restoreApi = __setPiApiRefForTests({ getActiveTools: () => [] }); // all tools → capture
	try {
		const stream = streamClaudeAgentSdk(MOCK_MODEL, captureCtx(contextOverrides));
		const events = await collectEvents(stream);
		return events;
	} finally {
		restoreFactory();
		restoreApi();
		__resetCachedSessionForTests();
	}
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe("runCaptureQuery — error paths (5.7)", () => {
	afterEach(() => {
		__resetCachedSessionForTests();
	});

	// (a) Retries-exhausted error from SDK
	it("(a) result subtype=error_max_structured_output_retries → stopReason=error, errorMessage references subtype", async () => {
		const factory = makeFakeFactory({
			messages: [
				{
					type: "result",
					subtype: "error_max_structured_output_retries",
					structured_output: undefined,
					is_error: true,
					usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
				},
			],
		});

		const events = await runWithFactory(factory);

		assert.equal(events.length, 2, `Expected 2 events, got ${events.length}`);
		assert.equal(events[0].type, "start");
		assert.equal(events[1].type, "error");
		const msg = events[1].error.errorMessage;
		assert.match(msg, /error_max_structured_output_retries/, "errorMessage must reference the SDK subtype");
		assert.equal(events[1].error.stopReason, "error");
	});

	// (b) Success subtype but no structured_output
	it("(b) result subtype=success but structured_output=undefined → stopReason=error", async () => {
		const factory = makeFakeFactory({
			messages: [
				{
					type: "result",
					subtype: "success",
					structured_output: undefined,
					usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
				},
			],
		});

		const events = await runWithFactory(factory);

		assert.equal(events.length, 2);
		assert.equal(events[0].type, "start");
		assert.equal(events[1].type, "error");
		// errorMessage should mention "subtype=success" or similar
		const msg = events[1].error.errorMessage;
		assert.match(msg, /subtype=success|structured.output/i);
		assert.equal(events[1].error.stopReason, "error");
	});

	// (c) Iterator closes without yielding a result message
	it("(c) iterator closes without result → stopReason=error, errorMessage references 'closed without result'", async () => {
		const factory = makeFakeFactory({
			messages: [], // yields nothing → iterator closes immediately
		});

		const events = await runWithFactory(factory);

		assert.equal(events.length, 2);
		assert.equal(events[0].type, "start");
		assert.equal(events[1].type, "error");
		const msg = events[1].error.errorMessage;
		assert.match(
			msg,
			/closed without result/i,
			`errorMessage should mention 'closed without result', got: ${msg}`,
		);
		assert.equal(events[1].error.stopReason, "error");
	});

	// (d) Factory throws synchronously (SDK construction failure)
	it("(d) throwSync → stopReason=error, errorMessage references thrown message and 'construction failed'", async () => {
		const syncError = new Error("spawn EACCES /usr/bin/claude-code");
		const factory = makeFakeFactory({ throwSync: syncError });

		const events = await runWithFactory(factory);

		// On sync throw: start + error emitted
		assert.equal(events.length, 2);
		assert.equal(events[0].type, "start");
		assert.equal(events[1].type, "error");
		const msg = events[1].error.errorMessage;
		assert.match(msg, /construction failed/i, `errorMessage should mention 'construction failed', got: ${msg}`);
		assert.match(msg, /EACCES/, `errorMessage should include the thrown error message`);
		assert.equal(events[1].error.stopReason, "error");
	});

	// Bonus: usage is propagated even on error result
	it("usage fields propagated on error_max_structured_output_retries result", async () => {
		const factory = makeFakeFactory({
			messages: [
				{
					type: "result",
					subtype: "error_max_structured_output_retries",
					structured_output: undefined,
					usage: {
						input_tokens: 100,
						output_tokens: 50,
						cache_read_input_tokens: 10,
						cache_creation_input_tokens: 5,
					},
				},
			],
		});

		const events = await runWithFactory(factory);

		const errorEvt = events.find((e) => e.type === "error");
		assert.ok(errorEvt, "Should have error event");
		const out = errorEvt.error;
		assert.equal(out.usage.input, 100);
		assert.equal(out.usage.output, 50);
		assert.equal(out.usage.cacheRead, 10);
		assert.equal(out.usage.cacheWrite, 5);
		assert.ok(Number.isFinite(out.usage.cost.total), "cost.total should be a finite number");
	});

	// Pre-flight abort: if signal is already aborted, stream emits start+error(aborted)
	it("pre-flight abort (signal already aborted) → stopReason=aborted", async () => {
		const factory = makeFakeFactory({
			messages: [
				{
					type: "result",
					subtype: "success",
					structured_output: { body: "x".repeat(50), headline: "h", topics: [] },
					usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
				},
			],
		});

		const ac = new AbortController();
		ac.abort(); // abort BEFORE calling streamClaudeAgentSdk

		const restoreFactory = __setQueryFactoryForTests(factory);
		const restoreApi = __setPiApiRefForTests({ getActiveTools: () => [] });
		try {
			const stream = streamClaudeAgentSdk(MOCK_MODEL, captureCtx(), { signal: ac.signal });
			const events = await collectEvents(stream);
			assert.equal(events.length, 2);
			assert.equal(events[0].type, "start");
			assert.equal(events[1].type, "error");
			assert.equal(events[1].reason, "aborted");
			assert.equal(events[1].error.stopReason, "aborted");
		} finally {
			restoreFactory();
			restoreApi();
			__resetCachedSessionForTests();
		}
	});
});
