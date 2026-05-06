/**
 * Stream-protocol unit test for runCaptureQuery (task 5.8).
 *
 * Drives the capture path with a mock factory that yields multiple intermediate
 * stream_event, assistant, and system messages, followed by a result.
 *
 * Asserts that the pi-ai stream emits EXACTLY:
 *   1. one "start" event
 *   2. one terminal "done" (or "error") event
 * — with NO intermediate events (*_start, *_delta, *_end, toolcall_*, thinking_*)
 * at any contentIndex.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Type } from "@sinclair/typebox";
import { streamClaudeAgentSdk, __setQueryFactoryForTests, __setPiApiRefForTests, __resetCachedSessionForTests } from "../index.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const MOCK_MODEL = {
	id: "claude-haiku-4-5",
	cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

const CAPTURE_TOOL = {
	name: "submit_digest",
	description: "test capture",
	parameters: Type.Object({ body: Type.String(), headline: Type.String() }),
};

async function collectEvents(stream) {
	const events = [];
	for await (const evt of stream) events.push(evt);
	return events;
}

// A rich set of intermediate messages the SDK would normally yield on the
// agent-loop path. The capture path MUST suppress all of them.
const INTERMEDIATE_SDK_MESSAGES = [
	// system init
	{ type: "system", subtype: "init", session_id: "fake-session-abc123" },
	// stream events that would produce text_start / text_delta / text_end on agent loop
	{
		type: "stream_event",
		event: { type: "message_start", message: { usage: { input_tokens: 80 } } },
	},
	{
		type: "stream_event",
		event: {
			type: "content_block_start",
			index: 0,
			content_block: { type: "text" },
		},
	},
	{
		type: "stream_event",
		event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Thinking..." } },
	},
	{
		type: "stream_event",
		event: { type: "content_block_stop", index: 0 },
	},
	// thinking block
	{
		type: "stream_event",
		event: {
			type: "content_block_start",
			index: 1,
			content_block: { type: "thinking" },
		},
	},
	{
		type: "stream_event",
		event: {
			type: "content_block_delta",
			index: 1,
			delta: { type: "thinking_delta", thinking: "reasoning..." },
		},
	},
	{
		type: "stream_event",
		event: { type: "content_block_stop", index: 1 },
	},
	// message_delta / message_stop
	{
		type: "stream_event",
		event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } },
	},
	{
		type: "stream_event",
		event: { type: "message_stop" },
	},
	// assistant message (reconstructed)
	{
		type: "assistant",
		message: {
			content: [{ type: "text", text: "Here is my answer." }],
			usage: { input_tokens: 80, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		},
	},
	// rate_limit_event (if exposed)
	{ type: "rate_limit_event", message: "rate limit info" },
];

const SUCCESS_RESULT = {
	type: "result",
	subtype: "success",
	structured_output: { body: "This is the body content of the digest that is long enough", headline: "Test headline" },
	usage: { input_tokens: 80, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 },
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe("runCaptureQuery — stream event suppression (5.8)", () => {
	let restoreFactory = null;
	let restoreApi = null;

	afterEach(() => {
		restoreFactory?.();
		restoreFactory = null;
		restoreApi?.();
		restoreApi = null;
		__resetCachedSessionForTests();
	});

	it("emits exactly [start, done] — no intermediate stream events", async () => {
		function factory() {
			const allMsgs = [...INTERMEDIATE_SDK_MESSAGES, SUCCESS_RESULT];
			let done = false;
			async function* gen() {
				for (const msg of allMsgs) {
					if (done) return;
					yield msg;
				}
			}
			return {
				[Symbol.asyncIterator]: gen,
				async interrupt() { done = true; },
				close() { done = true; },
			};
		}

		restoreFactory = __setQueryFactoryForTests(factory);
		restoreApi = __setPiApiRefForTests({ getActiveTools: () => [] });

		const stream = streamClaudeAgentSdk(
			MOCK_MODEL,
			{
				systemPrompt: "Summarize this.",
				messages: [{ role: "user", content: "here is my session", timestamp: Date.now() }],
				tools: [CAPTURE_TOOL],
			},
		);
		const events = await collectEvents(stream);

		// Exactly 2 events: start + done
		assert.equal(
			events.length,
			2,
			`Expected exactly 2 events, got ${events.length}: ${JSON.stringify(events.map((e) => e.type))}`,
		);

		assert.equal(events[0].type, "start", "First event must be 'start'");
		assert.equal(events[1].type, "done", "Second event must be 'done'");
		assert.equal(events[1].reason, "toolUse", "done event reason must be 'toolUse'");

		// No intermediate event types
		const INTERMEDIATE_TYPES = new Set([
			"text_start",
			"text_delta",
			"text_end",
			"thinking_start",
			"thinking_delta",
			"thinking_end",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
		]);
		for (const evt of events) {
			assert.ok(
				!INTERMEDIATE_TYPES.has(evt.type),
				`Intermediate event type '${evt.type}' must NOT be emitted by the capture path`,
			);
		}
	});

	it("done event carries correct toolCall content block", async () => {
		function factory() {
			const msgs = [...INTERMEDIATE_SDK_MESSAGES, SUCCESS_RESULT];
			async function* gen() { for (const m of msgs) yield m; }
			return { [Symbol.asyncIterator]: gen, async interrupt() {}, close() {} };
		}

		restoreFactory = __setQueryFactoryForTests(factory);
		restoreApi = __setPiApiRefForTests({ getActiveTools: () => [] });

		const result = await streamClaudeAgentSdk(
			MOCK_MODEL,
			{
				systemPrompt: "test",
				messages: [{ role: "user", content: "summarize", timestamp: Date.now() }],
				tools: [CAPTURE_TOOL],
			},
		).result();

		assert.equal(result.stopReason, "toolUse");
		assert.equal(result.content.length, 1);
		const toolCall = result.content[0];
		assert.equal(toolCall.type, "toolCall");
		assert.equal(toolCall.name, "submit_digest");
		assert.deepEqual(toolCall.arguments, SUCCESS_RESULT.structured_output);
		assert.ok(toolCall.id.startsWith("toolu_"), `toolCall.id should start with 'toolu_', got: ${toolCall.id}`);
	});

	it("emits start + error on error result (still no intermediate events)", async () => {
		function factory() {
			const msgs = [
				...INTERMEDIATE_SDK_MESSAGES,
				{
					type: "result",
					subtype: "error_max_structured_output_retries",
					structured_output: undefined,
					usage: { input_tokens: 80, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
				},
			];
			async function* gen() { for (const m of msgs) yield m; }
			return { [Symbol.asyncIterator]: gen, async interrupt() {}, close() {} };
		}

		restoreFactory = __setQueryFactoryForTests(factory);
		restoreApi = __setPiApiRefForTests({ getActiveTools: () => [] });

		const events = await collectEvents(
			streamClaudeAgentSdk(
				MOCK_MODEL,
				{
					systemPrompt: "test",
					messages: [{ role: "user", content: "summarize", timestamp: Date.now() }],
					tools: [CAPTURE_TOOL],
				},
			),
		);

		assert.equal(events.length, 2);
		assert.equal(events[0].type, "start");
		assert.equal(events[1].type, "error");
	});
});
