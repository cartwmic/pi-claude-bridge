/**
 * Mock SDK query factory for deterministic unit tests.
 *
 * Usage:
 *   import { makeFakeFactory } from "./fixtures/mock-sdk-query.mjs";
 *   import { __setQueryFactoryForTests } from "../index.js";
 *
 *   const factory = makeFakeFactory({ messages: [...sdkMessages] });
 *   const restore = __setQueryFactoryForTests(factory);
 *   // ... run test ...
 *   restore();
 *
 * The factory function itself is the value to pass to __setQueryFactoryForTests.
 * factory.calls[] records every call (params passed by the bridge code).
 */

/**
 * Create a fake query factory.
 *
 * @param {Object} opts
 * @param {any[]}  opts.messages   - SDK messages to yield (in order)
 * @param {Error|null} opts.throwSync  - if non-null, thrown synchronously when factory is called
 * @param {boolean} opts.closeEarly - if true yield nothing even if messages provided
 * @param {(params: any) => void} opts.onCall - optional callback on each factory invocation
 */
export function makeFakeFactory({
	messages = [],
	throwSync = null,
	closeEarly = false,
	onCall = null,
} = {}) {
	const calls = [];

	function factory(params) {
		calls.push(params);
		onCall?.(params);

		if (throwSync) throw throwSync;

		const msgs = closeEarly ? [] : [...messages];

		let done = false;

		async function* gen() {
			for (const msg of msgs) {
				if (done) return;
				yield msg;
			}
		}

		return {
			[Symbol.asyncIterator]: gen,
			async interrupt() {
				done = true;
			},
			close() {
				done = true;
			},
		};
	}

	factory.calls = calls;
	return factory;
}

/**
 * Create a factory whose behavior depends on whether the call is a capture call
 * (options.outputFormat is set) or a regular call.
 *
 * @param {Object} opts
 * @param {any[]} opts.captureMessages   - messages to yield for capture calls
 * @param {any[]} opts.regularMessages   - messages to yield for regular calls
 * @param {() => Promise<void>} opts.regularBlocker - if provided, regular query awaits this before ending
 */
export function makeSmartFactory({
	captureMessages = [],
	regularMessages = [],
	regularBlocker = null,
} = {}) {
	const calls = [];

	function factory(params) {
		calls.push(params);
		const isCapture = Boolean(params.options?.outputFormat);
		const msgs = isCapture ? captureMessages : regularMessages;
		let done = false;

		async function* gen() {
			for (const msg of msgs) {
				if (done) return;
				yield msg;
			}
			if (!isCapture && regularBlocker) {
				await regularBlocker();
			}
		}

		return {
			[Symbol.asyncIterator]: gen,
			async interrupt() {
				done = true;
			},
			close() {
				done = true;
			},
		};
	}

	factory.calls = calls;
	return factory;
}

/**
 * Build a standard success result SDK message for the capture path.
 */
export function makeSuccessResultMsg(structuredOutput, usage = {}) {
	return {
		type: "result",
		subtype: "success",
		structured_output: structuredOutput,
		usage: {
			input_tokens: usage.input_tokens ?? 10,
			output_tokens: usage.output_tokens ?? 5,
			cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
			cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
		},
	};
}

/**
 * Build stream_event messages that simulate a tool_use call.
 * The tool name in the SDK uses the mcp__custom-tools__ prefix.
 */
export function makeToolUseMsgs(toolUseId, toolName) {
	const sdkToolName = toolName.startsWith("mcp__custom-tools__")
		? toolName
		: `mcp__custom-tools__${toolName}`;
	return [
		{ type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: 10 } } } },
		{
			type: "stream_event",
			event: {
				type: "content_block_start",
				index: 0,
				content_block: { type: "tool_use", id: toolUseId, name: sdkToolName, input: {} },
			},
		},
		{
			type: "stream_event",
			event: {
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: "{}" },
			},
		},
		{ type: "stream_event", event: { type: "content_block_stop", index: 0 } },
		{
			type: "stream_event",
			event: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
		},
		{ type: "stream_event", event: { type: "message_stop" } },
	];
}

/**
 * Build a system:init message with a known session_id.
 */
export function makeSystemInitMsg(sessionId) {
	return { type: "system", subtype: "init", session_id: sessionId };
}

/**
 * Build a minimal stop result message (for regular queries).
 */
export function makeStopResultMsg() {
	return {
		type: "result",
		subtype: "success",
		structured_output: undefined,
		usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
	};
}
