#!/usr/bin/env node
// Canonical ACs:
// - claude-print-driver.partial-stream-is-normalized-without-duplication
// - claude-print-driver.direct-protocol-drift-surfaces-explicitly
// - claude-print-driver.direct-usage-and-session-metadata-are-authoritative

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	ClaudePrintStreamParser,
	CLAUDE_PRINT_MAX_NDJSON_LINE_BYTES,
	CLAUDE_PRINT_MAX_DIAGNOSTIC_BYTES,
} from "../src/driver/claudePrintStream.js";

const SESSION = "11111111-1111-4111-8111-111111111111";

function line(record) {
	return `${JSON.stringify(record)}\n`;
}

function usage(input, output, cacheRead = 0, cacheWrite = 0) {
	return {
		input_tokens: input,
		output_tokens: output,
		cache_read_input_tokens: cacheRead,
		cache_creation_input_tokens: cacheWrite,
	};
}

function init(sessionId = SESSION) {
	return { type: "system", subtype: "init", session_id: sessionId };
}

function stream(event, parentToolUseId = null, sessionId = SESSION) {
	return {
		type: "stream_event",
		event,
		parent_tool_use_id: parentToolUseId,
		session_id: sessionId,
	};
}

function messageStart(id) {
	return stream({ type: "message_start", message: { id, role: "assistant" } });
}

function blockStart(index, contentBlock) {
	return stream({ type: "content_block_start", index, content_block: contentBlock });
}

function blockDelta(index, delta) {
	return stream({ type: "content_block_delta", index, delta });
}

function blockStop(index) {
	return stream({ type: "content_block_stop", index });
}

function messageDelta(stopReason) {
	return stream({ type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 1 } });
}

function messageStop() {
	return stream({ type: "message_stop" });
}

function assistant(id, content, assistantUsage, parentToolUseId = null, sessionId = SESSION) {
	return {
		type: "assistant",
		message: {
			id,
			type: "message",
			role: "assistant",
			content,
			stop_reason: null,
			usage: assistantUsage,
		},
		parent_tool_use_id: parentToolUseId,
		session_id: sessionId,
	};
}

function result(overrides = {}) {
	return {
		type: "result",
		subtype: "success",
		is_error: false,
		result: "final answer",
		stop_reason: "end_turn",
		terminal_reason: "completed",
		session_id: SESSION,
		total_cost_usd: 1.25,
		usage: usage(15, 40, 80, 20),
		...overrides,
	};
}

function createParser(options = {}) {
	const events = [];
	const debug = [];
	const parser = new ClaudePrintStreamParser({
		onEvent: (event) => events.push(event),
		...options,
		logger: {
			debug: (...args) => debug.push(args),
			warn() {},
		},
	});
	return { parser, events, debug };
}

function feedRecords(parser, records) {
	for (const record of records) parser.write(line(record));
}

function finish(parser, records) {
	feedRecords(parser, records);
	return parser.endOfStream({ exitInfo: { code: 0 } });
}

function validSuccessRecords() {
	return [
		init(),
		messageStart("msg_tool"),
		blockStart(0, { type: "thinking", thinking: "" }),
		blockDelta(0, { type: "thinking_delta", thinking: "plan " }),
		blockDelta(0, { type: "signature_delta", signature: "sig" }),
		blockStop(0),
		blockStart(1, {
			type: "tool_use",
			id: "toolu_bridge",
			name: "mcp__custom-tools__read",
			input: {},
		}),
		blockDelta(1, { type: "input_json_delta", partial_json: "{\"path\":\"x\"}" }),
		blockStop(1),
		messageDelta("tool_use"),
		messageStop(),
		assistant("msg_tool", [
			{ type: "thinking", thinking: "plan ", signature: "sig" },
			{ type: "tool_use", id: "toolu_native", name: "Read", input: { path: "/tmp/x" } },
			{ type: "tool_use", id: "toolu_foreign", name: "mcp__foreign__read", input: {} },
			{ type: "tool_use", id: "toolu_bridge", name: "mcp__custom-tools__read", input: { path: "x" } },
		], usage(5, 10, 20, 5)),
		// Same complete assistant record may be repeated; observation remains one-shot.
		assistant("msg_tool", [
			{ type: "tool_use", id: "toolu_bridge", name: "mcp__custom-tools__read", input: { path: "x" } },
		], usage(5, 10, 20, 5)),
		// Nested records are observational and cannot mutate top-level content/usage.
		stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "NESTED" } }, "toolu_bridge"),
		assistant("nested", [{ type: "text", text: "NESTED COMPLETE" }], usage(999, 999), "toolu_bridge"),
		messageStart("msg_final"),
		blockStart(0, { type: "text", text: "" }),
		blockDelta(0, { type: "text_delta", text: "final " }),
		blockDelta(0, { type: "text_delta", text: "answer" }),
		blockStop(0),
		messageDelta("end_turn"),
		messageStop(),
		// Complete text is metadata-only and must not duplicate partial text.
		assistant("msg_final", [{ type: "text", text: "final answer" }], usage(10, 30, 60, 15)),
		result(),
	];
}

describe("claude-print partial stream normalization", () => {
	// AC: mcp-stdio-shim.tool-call-correlation-across-the-split-channels-d32
	it("publishes one bridged-only batch only after its message_stop seal", () => {
		const batches = [];
		const { parser } = createParser({ onToolUseBatch: (batch) => batches.push(batch) });
		feedRecords(parser, [
			init(),
			messageStart("msg_batch"),
			blockStart(0, { type: "tool_use", id: "toolu_batch", name: "mcp__custom-tools__read", input: {} }),
			blockDelta(0, { type: "input_json_delta", partial_json: "{\"path\":\"x\"}" }),
			blockStop(0),
			messageDelta("tool_use"),
		]);
		assert.deepEqual(batches, [], "partial tool blocks cannot seal correlation count");
		feedRecords(parser, [messageStop()]);
		assert.deepEqual(batches, [{
			batchId: "msg_batch",
			observations: [{ modelId: "toolu_batch", name: "mcp__custom-tools__read", arguments: { path: "x" } }],
		}]);
	});

	it("defers a complete tool assistant emitted before message_stop until the matching seal", () => {
		const batches = [];
		const { parser } = createParser({ onToolUseBatch: (batch) => batches.push(batch) });
		feedRecords(parser, [
			init(),
			messageStart("msg_early_complete"),
			blockStart(0, { type: "tool_use", id: "toolu_early", name: "mcp__custom-tools__read", input: {} }),
			blockDelta(0, { type: "input_json_delta", partial_json: "{\"path\":\"x\"}" }),
			blockStop(0),
			messageDelta("tool_use"),
			assistant("msg_early_complete", [
				{ type: "tool_use", id: "toolu_early", name: "mcp__custom-tools__read", input: { path: "x" } },
			], usage(5, 5)),
		]);
		assert.deepEqual(batches, [], "complete assistant cannot publish before message_stop");
		feedRecords(parser, [messageStop()]);
		assert.deepEqual(batches, [{
			batchId: "msg_early_complete",
			observations: [{ modelId: "toolu_early", name: "mcp__custom-tools__read", arguments: { path: "x" } }],
		}]);
	});

	it("emits top-level text/thinking boundaries once and filters nested/native/foreign observations", () => {
		const { parser, events } = createParser();
		const bytes = Buffer.from(validSuccessRecords().map(line).join(""));
		// Deliberately split inside JSON and UTF-8-capable byte paths.
		for (let offset = 0; offset < bytes.length; offset += 17) parser.write(bytes.subarray(offset, offset + 17));
		const outcome = parser.endOfStream({ exitInfo: { code: 0 } });

		assert.deepEqual(events, [
			{ kind: "content-block-start", blockType: "thinking" },
			{ kind: "thinking-delta", text: "plan " },
			{ kind: "content-block-end", blockType: "thinking" },
			{ kind: "tool-use", toolUseId: "toolu_bridge", name: "mcp__custom-tools__read", arguments: { path: "x" } },
			{ kind: "content-block-start", blockType: "text" },
			{ kind: "text-delta", text: "final " },
			{ kind: "text-delta", text: "answer" },
			{ kind: "content-block-end", blockType: "text" },
			{
				kind: "usage",
				usage: { input: 10, output: 30, cacheRead: 60, cacheWrite: 15, totalTokens: 115 },
				billing: { input: 15, output: 40, cacheRead: 80, cacheWrite: 20, totalTokens: 155 },
			},
			{ kind: "done", reason: "result" },
		]);
		assert.deepEqual(outcome, {
			kind: "result",
			subtype: "success",
			sessionId: SESSION,
			result: "final answer",
			totalCostUsd: 1.25,
			stopReason: "end_turn",
			invalidateResumeHint: false,
		});
		assert.equal(parser.turnAccepted, true);
	});

	it("accepts only explicit observational record types and logs them", () => {
		const { parser, debug, events } = createParser();
		const outcome = finish(parser, [
			init(),
			{ type: "system", subtype: "status", status: "compacting", session_id: SESSION },
			{ type: "system", subtype: "api_retry", attempt: 1, session_id: SESSION },
			{ type: "system", subtype: "thinking_tokens", estimated_tokens: 68, estimated_tokens_delta: 22, session_id: SESSION },
			{ type: "rate_limit_event", rate_limit_info: { status: "allowed" }, session_id: SESSION },
			{
				type: "tool_progress",
				tool_use_id: "toolu_prior-heartbeat-0",
				tool_name: "mcp__custom-tools__bash",
				parent_tool_use_id: "toolu_prior",
				elapsed_time_seconds: 30,
				heartbeat: true,
				session_id: SESSION,
			},
			{
				type: "user",
				message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_prior", content: "ok" }] },
				parent_tool_use_id: null,
				session_id: SESSION,
			},
			{
				type: "user",
				message: { role: "user", content: [{ type: "text", text: "hook or control observation" }] },
				parent_tool_use_id: null,
				session_id: SESSION,
			},
			...validSuccessRecords().slice(1),
		]);
		assert.equal(outcome.kind, "result");
		assert.equal(events.at(-1).kind, "done");
		const allowlisted = debug.filter(([fields]) =>
			fields?.type === "system/status" ||
			fields?.type === "system/api_retry" ||
			fields?.type === "system/thinking_tokens" ||
			fields?.type === "rate_limit_event" ||
			fields?.type === "tool_progress" ||
			fields?.type === "user/tool_result" ||
			fields?.type === "user/text");
		assert.equal(allowlisted.length, 7);
	});

	it("logs SSE ping keepalive stream events without failing the turn or emitting content", () => {
		const { parser, debug, events } = createParser();
		const [initRecord, ...rest] = validSuccessRecords();
		const outcome = finish(parser, [
			initRecord,
			stream({ type: "ping" }),
			...rest.slice(0, 3),
			stream({ type: "ping" }),
			...rest.slice(3),
		]);
		assert.equal(outcome.kind, "result");
		assert.equal(events.at(-1).kind, "done");
		assert.equal(events.some((event) => event.kind === "error"), false);
		const pings = debug.filter(([fields]) => fields?.type === "stream_event/ping");
		assert.equal(pings.length, 2);
	});
});

describe("claude-print raw-byte bounded NDJSON and protocol drift", () => {
	it("bounds pending raw bytes before allocation growth and reports a bounded UTF-8 diagnostic", () => {
		const { parser, events } = createParser();
		// Character count remains below 8 MiB; UTF-8 bytes exceed it.
		const oversized = "😀".repeat(Math.floor(CLAUDE_PRINT_MAX_NDJSON_LINE_BYTES / 4) + 2);
		assert.ok(oversized.length < CLAUDE_PRINT_MAX_NDJSON_LINE_BYTES);
		assert.ok(Buffer.byteLength(oversized) > CLAUDE_PRINT_MAX_NDJSON_LINE_BYTES);
		parser.write(oversized);
		assert.equal(parser.pendingBufferBytes, 0);
		const error = events.find((event) => event.kind === "error");
		assert.match(error.errorMessage, /8 MiB/);
		assert.ok(Buffer.byteLength(error.errorMessage, "utf8") <= CLAUDE_PRINT_MAX_DIAGNOSTIC_BYTES + 512);
		const outcome = parser.endOfStream({ exitInfo: { code: 1 } });
		assert.equal(outcome.kind, "protocol-error");
		assert.equal(outcome.invalidateResumeHint, true);
	});

	const driftFixtures = [
		["malformed JSON", ["{not-json\n"], /malformed NDJSON/],
		["non-object JSON", ["42\n"], /JSON object/],
		["unknown top-level type", [line({ type: "future_record" })], /unknown top-level type/],
		["unknown system subtype", [line({ type: "system", subtype: "future" })], /unknown system subtype/],
		["unknown stream subtype", [line(init()), line(stream({ type: "future_event" }))], /unknown stream_event subtype/],
		["delta before block start", [line(init()), line(messageStart("m")), line(blockDelta(0, { type: "text_delta", text: "x" }))], /without active block/],
		["mismatched delta", [line(init()), line(messageStart("m")), line(blockStart(0, { type: "thinking", thinking: "" })), line(blockDelta(0, { type: "text_delta", text: "x" }))], /does not match/],
		["session mismatch", [line(init()), line(stream({ type: "message_start", message: { id: "m" } }, null, "other"))], /session_id mismatch/],
		["unknown user content", [line(init()), line({ type: "user", message: { role: "user", content: [{ type: "image", source: {} }] }, parent_tool_use_id: null, session_id: SESSION })], /unknown user observation content type/],
		["unknown result subtype", validSuccessRecords().slice(0, -1).map(line).concat(line(result({ subtype: "future_error", is_error: true }))), /unknown result subtype/],
		["incompatible success stop", validSuccessRecords().slice(0, -1).map(line).concat(line(result({ stop_reason: "tool_use" }))), /success result requires stop_reason/],
	];

	for (const [name, chunks, expected] of driftFixtures) {
		it(`fails closed for ${name}`, () => {
			const { parser, events } = createParser();
			for (const chunk of chunks) parser.write(chunk);
			const outcome = parser.endOfStream({ exitInfo: { code: 0 } });
			assert.equal(outcome.kind, "protocol-error");
			assert.equal(outcome.invalidateResumeHint, true);
			assert.match(events.find((event) => event.kind === "error").errorMessage, expected);
		});
	}

	it("requires exactly one terminal result, final assistant usage, and coherent cumulative billing", () => {
		for (const [records, expected] of [
			[validSuccessRecords().slice(0, -1), /before exactly one terminal result/],
			[validSuccessRecords().concat(result()), /more than one terminal result/],
			[validSuccessRecords().filter((record) => record.type !== "assistant"), /final top-level assistant usage/],
			[validSuccessRecords().slice(0, -1).concat(result({ usage: usage(1, 1, 1, 1) })), /cumulative usage.*conflicts/],
		]) {
			const { parser, events } = createParser();
			const outcome = finish(parser, records);
			assert.equal(outcome.kind, "protocol-error");
			assert.match(events.find((event) => event.kind === "error").errorMessage, expected);
		}
	});
});

describe("claude-print terminal matrix and local abort", () => {
	for (const subtype of [
		"error_during_execution",
		"error_max_turns",
		"error_max_budget_usd",
		"error_max_structured_output_retries",
	]) {
		it(`maps ${subtype} to terminal error and invalidates resume`, () => {
			const { parser, events } = createParser();
			const records = validSuccessRecords();
			records[records.length - 1] = result({
				subtype,
				is_error: true,
				result: `terminal ${subtype}`,
				stop_reason: null,
				terminal_reason: "error",
			});
			const outcome = finish(parser, records);
			assert.deepEqual(outcome, {
				kind: "error",
				subtype,
				sessionId: SESSION,
				errorMessage: `terminal ${subtype}`,
				totalCostUsd: 1.25,
				invalidateResumeHint: true,
			});
			assert.equal(events.at(-1).kind, "error");
			assert.match(events.at(-1).errorMessage, new RegExp(subtype));
		});
	}

	it("freezes stream mutation at local abort and ignores every late record", () => {
		const { parser, events } = createParser();
		feedRecords(parser, [
			init(),
			messageStart("msg_abort"),
			blockStart(0, { type: "text", text: "" }),
			blockDelta(0, { type: "text_delta", text: "partial" }),
		]);
		parser.markLocalAbort();
		parser.write("{late-malformed\n");
		parser.write(line(blockDelta(0, { type: "text_delta", text: " MUST_NOT_APPEAR" })));
		parser.write(line(result({
			subtype: "error_during_execution",
			is_error: true,
			result: "Interrupted",
			stop_reason: null,
			terminal_reason: "error",
		})));
		const outcome = parser.endOfStream({ aborted: true, exitInfo: { code: 0 } });
		assert.deepEqual(outcome, {
			kind: "aborted",
			sessionId: SESSION,
			invalidateResumeHint: false,
		});
		assert.deepEqual(events, [
			{ kind: "content-block-start", blockType: "text" },
			{ kind: "text-delta", text: "partial" },
		]);
	});
});
