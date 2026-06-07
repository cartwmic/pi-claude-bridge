#!/usr/bin/env node
// Thinking/text presentation through the pi event stream.
//
// pi-agent-core renders an assistant turn SOLELY from `event.partial.content`
// (it ignores the contentIndex/delta fields for display). So the bridge MUST
// keep `frame.turnOutput.content` synced on every text/thinking delta, or the
// whole turn renders blank until turn-end and then dumps at once.
//
// This test drives the claude-p path with a fake spawn that emits a thinking
// block followed by answer text, then asserts:
//   1. partial.content is populated DURING streaming (not empty until the end),
//   2. the thinking trace is finalized (thinking_end) BEFORE answer text opens
//      (text_start), so it renders as a distinct reasoning block, and
//   3. the final message carries BOTH a thinking and a text block, in order.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
	streamClaudeAgentSdk,
	__setPiApiRefForTests,
	__resetCachedSessionForTests,
	__setSpawnClaudePForTests,
} from "../index.js";

const MOCK_MODEL = {
	id: "claude-haiku-4-5",
	cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

function userCtx(text = "reason then answer") {
	return {
		systemPrompt: "You are helpful.",
		tools: [],
		messages: [{ role: "user", content: text, timestamp: Date.now() }],
	};
}

// Fake spawn: emit usage → a thinking delta → text deltas → resolve done(stop).
function makeThinkingSpawn(thinking, textChunks) {
	return function fakeSpawn(cfg, opts /*, policy */) {
		let resolveDone;
		const done = new Promise((res) => { resolveDone = res; });
		queueMicrotask(() => {
			opts.onEvent({ kind: "usage", usage: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 5 } });
			opts.onEvent({ kind: "thinking-delta", text: thinking });
			for (const c of textChunks) opts.onEvent({ kind: "text-delta", text: c });
			opts.onEvent({ kind: "done", reason: "result" });
			resolveDone({ stopReason: "stop", sessionId: cfg.session.sessionId, exitCode: 0, signal: null });
		});
		return { pid: 4242, abort() { resolveDone({ stopReason: "aborted", sessionId: cfg.session.sessionId, exitCode: null, signal: null }); }, done };
	};
}

describe("thinking/text presentation through the pi event stream", () => {
	let restore = [];
	afterEach(() => { restore.forEach((r) => r()); restore = []; __resetCachedSessionForTests(); });

	it("streams partial.content live and keeps thinking a distinct, ordered block", async () => {
		restore.push(__setPiApiRefForTests({ getActiveTools: () => [] }));
		restore.push(__setSpawnClaudePForTests(makeThinkingSpawn("let me reason carefully", ["The ", "answer ", "is 391."])));

		const stream = streamClaudeAgentSdk(MOCK_MODEL, userCtx(), {});
		const events = [];
		for await (const e of stream) events.push(e);

		// (1) Live streaming: at least one mid-stream event must carry a non-empty
		//     partial.content (proves turnOutput.content is synced per-delta).
		const liveContentful = events.filter(
			(e) => (e.type === "thinking_delta" || e.type === "text_delta") &&
				Array.isArray(e.partial?.content) &&
				e.partial.content.some((c) => (c.type === "thinking" && c.thinking) || (c.type === "text" && c.text)),
		);
		assert.ok(liveContentful.length > 0, "partial.content must be populated during streaming, not empty until turn-end");

		// (2) The thinking trace finalizes before answer text opens.
		const thinkingEndIdx = events.findIndex((e) => e.type === "thinking_end");
		const textStartIdx = events.findIndex((e) => e.type === "text_start");
		assert.ok(thinkingEndIdx >= 0, "a thinking_end event must be emitted");
		assert.ok(textStartIdx >= 0, "a text_start event must be emitted");
		assert.ok(thinkingEndIdx < textStartIdx, "thinking_end must precede text_start so thinking renders as a distinct block");

		// (3) Final message: thinking block then text block, both present & distinct.
		const terminal = events[events.length - 1];
		assert.equal(terminal.type, "done");
		const content = terminal.message.content;
		const types = content.map((c) => c.type);
		assert.deepEqual(types, ["thinking", "text"], `expected [thinking, text]; got ${JSON.stringify(types)}`);
		assert.equal(content[0].thinking, "let me reason carefully");
		assert.equal(content[1].text, "The answer is 391.");
	});
});
