/**
 * Prompt / systemPrompt wiring test for the capture path (task 5.9).
 *
 * Uses __setQueryFactoryForTests with a recording factory that captures the
 * options passed to the SDK query constructor.
 *
 * Asserts (deterministic, no live model):
 *  (a) options.systemPrompt === ctx.systemPrompt verbatim (no append blocks)
 *  (b) options.prompt is the buildColdStartPrompt output containing all message text
 *  (c) options.cwd === os.tmpdir() (per Decision 12)
 *  (d) options.outputFormat is set (capture path marker)
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { Type } from "@sinclair/typebox";
import {
	streamClaudeAgentSdk,
	__setQueryFactoryForTests,
	__setPiApiRefForTests,
	__resetCachedSessionForTests,
} from "../index.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const MOCK_MODEL = {
	id: "claude-haiku-4-5",
	cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

const CAPTURE_TOOL = {
	name: "submit_digest",
	description: "capture tool for wiring test",
	parameters: Type.Object({
		body: Type.String({ minLength: 50 }),
		headline: Type.String({ maxLength: 80 }),
	}),
};

/** Timestamp helper for messages */
const ts = () => Date.now();

/**
 * Build a recording factory: every call records its params.
 * Returns a trivial success result so the stream can complete.
 */
function makeRecordingFactory() {
	const calls = [];
	function factory(params) {
		calls.push(params);
		async function* gen() {
			yield {
				type: "result",
				subtype: "success",
				structured_output: { body: "body content for testing wiring " + "x".repeat(30), headline: "Wiring test headline", topics: [] },
				usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			};
		}
		return {
			[Symbol.asyncIterator]: gen,
			async interrupt() {},
			close() {},
		};
	}
	factory.calls = calls;
	return factory;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("runCaptureQuery — prompt/systemPrompt wiring (5.9)", () => {
	let restoreFactory = null;
	let restoreApi = null;

	afterEach(() => {
		restoreFactory?.();
		restoreFactory = null;
		restoreApi?.();
		restoreApi = null;
		__resetCachedSessionForTests();
	});

	it("(a) systemPrompt forwarded verbatim — no append blocks blended in", async () => {
		const SENTINEL_SYSTEM = "sentinel-system-prompt-XYZ-42";
		const factory = makeRecordingFactory();
		restoreFactory = __setQueryFactoryForTests(factory);
		restoreApi = __setPiApiRefForTests({ getActiveTools: () => [] });

		await streamClaudeAgentSdk(
			MOCK_MODEL,
			{
				systemPrompt: SENTINEL_SYSTEM,
				messages: [{ role: "user", content: "hello", timestamp: ts() }],
				tools: [CAPTURE_TOOL],
			},
		).result();

		assert.equal(factory.calls.length, 1, "Factory should be called exactly once");
		const opts = factory.calls[0].options;
		assert.equal(
			opts.systemPrompt,
			SENTINEL_SYSTEM,
			`systemPrompt must be forwarded verbatim. Got: ${opts.systemPrompt}`,
		);
	});

	it("(b) prompt contains all three messages' text (multi-turn buildColdStartPrompt)", async () => {
		const factory = makeRecordingFactory();
		restoreFactory = __setQueryFactoryForTests(factory);
		restoreApi = __setPiApiRefForTests({ getActiveTools: () => [] });

		await streamClaudeAgentSdk(
			MOCK_MODEL,
			{
				systemPrompt: "You are a summarizer.",
				messages: [
					{ role: "user", content: "Q1 the first question", timestamp: ts() },
					{
						role: "assistant",
						content: [{ type: "text", text: "A1 the first answer" }],
						stopReason: "stop",
						timestamp: ts(),
					},
					{ role: "user", content: "Q2 referring to A1 the prior answer", timestamp: ts() },
				],
				tools: [CAPTURE_TOOL],
			},
		).result();

		assert.equal(factory.calls.length, 1);
		const prompt = factory.calls[0].prompt;
		assert.equal(typeof prompt, "string", "prompt must be a string for capture path");

		// All three messages must appear in the cold-start prompt
		assert.ok(prompt.includes("Q1"), `prompt must contain Q1 text. Got: ${prompt.slice(0, 200)}`);
		assert.ok(prompt.includes("A1"), `prompt must contain A1 text. Got: ${prompt.slice(0, 200)}`);
		assert.ok(prompt.includes("Q2"), `prompt must contain Q2 text. Got: ${prompt.slice(0, 200)}`);
	});

	it("(c) options.cwd === os.tmpdir() (hermetic cwd, Decision 12)", async () => {
		const factory = makeRecordingFactory();
		restoreFactory = __setQueryFactoryForTests(factory);
		restoreApi = __setPiApiRefForTests({ getActiveTools: () => [] });

		await streamClaudeAgentSdk(
			MOCK_MODEL,
			{
				systemPrompt: "test",
				messages: [{ role: "user", content: "hello", timestamp: ts() }],
				tools: [CAPTURE_TOOL],
			},
		).result();

		const opts = factory.calls[0].options;
		assert.equal(
			opts.cwd,
			tmpdir(),
			`options.cwd must be os.tmpdir() for capture path. Got: ${opts.cwd}`,
		);
	});

	it("(d) options.outputFormat is set with type=json_schema and the capture tool's schema", async () => {
		const factory = makeRecordingFactory();
		restoreFactory = __setQueryFactoryForTests(factory);
		restoreApi = __setPiApiRefForTests({ getActiveTools: () => [] });

		await streamClaudeAgentSdk(
			MOCK_MODEL,
			{
				systemPrompt: "test",
				messages: [{ role: "user", content: "hello", timestamp: ts() }],
				tools: [CAPTURE_TOOL],
			},
		).result();

		const opts = factory.calls[0].options;
		assert.ok(opts.outputFormat, "options.outputFormat must be set");
		assert.equal(opts.outputFormat.type, "json_schema");
		assert.equal(opts.outputFormat.schema.type, "object");
		// Schema must have no symbol keys (cleanSchemaForSdk applied)
		const syms = Object.getOwnPropertySymbols(opts.outputFormat.schema);
		assert.equal(syms.length, 0, "outputFormat.schema must have no symbol keys");
	});

	it("empty systemPrompt + non-empty messages → prompt is built from messages, call proceeds", async () => {
		const factory = makeRecordingFactory();
		restoreFactory = __setQueryFactoryForTests(factory);
		restoreApi = __setPiApiRefForTests({ getActiveTools: () => [] });

		const result = await streamClaudeAgentSdk(
			MOCK_MODEL,
			{
				systemPrompt: "", // empty systemPrompt
				messages: [{ role: "user", content: "non-empty message text", timestamp: ts() }],
				tools: [CAPTURE_TOOL],
			},
		).result();

		// Should NOT fail (systemPrompt empty but messages non-empty → prompt is built)
		assert.equal(result.stopReason, "toolUse", "Call should succeed when messages are non-empty");
		const prompt = factory.calls[0].prompt;
		assert.ok(prompt.includes("non-empty message text"), "Prompt should contain the user message text");
	});

	it("non-empty systemPrompt + empty messages → call proceeds with empty prompt", async () => {
		const factory = makeRecordingFactory();
		restoreFactory = __setQueryFactoryForTests(factory);
		restoreApi = __setPiApiRefForTests({ getActiveTools: () => [] });

		const result = await streamClaudeAgentSdk(
			MOCK_MODEL,
			{
				systemPrompt: "A rich system prompt that provides context",
				messages: [],
				tools: [CAPTURE_TOOL],
			},
		).result();

		// systemPrompt non-empty → not rejected even with empty messages
		assert.equal(result.stopReason, "toolUse");
		const opts = factory.calls[0].options;
		assert.equal(opts.systemPrompt, "A rich system prompt that provides context");
	});

	it("both empty → stopReason=error (empty-prompt guard)", async () => {
		const factory = makeRecordingFactory();
		restoreFactory = __setQueryFactoryForTests(factory);
		restoreApi = __setPiApiRefForTests({ getActiveTools: () => [] });

		const result = await streamClaudeAgentSdk(
			MOCK_MODEL,
			{
				systemPrompt: "",
				messages: [],
				tools: [CAPTURE_TOOL],
			},
		).result();

		assert.equal(result.stopReason, "error", "Both empty → should reject with error");
		assert.ok(factory.calls.length === 0, "Factory should NOT be called when both prompt and systemPrompt are empty");
	});
});
