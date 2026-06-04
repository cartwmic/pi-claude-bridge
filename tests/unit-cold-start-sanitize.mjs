#!/usr/bin/env node
// Regression: the cold-start prompt must NOT re-feed leaked tool-call PROTOCOL
// markup back to the model.
//
// RCA 2026-06-03 (reproduced .spike-notes/claude-p-gate/coldstart-perpetuation-proof.mjs):
// the bridge has no structured-history channel, so buildColdStartPrompt embeds pi's
// prior conversation verbatim as `[assistant] <text>` inside <conversation_history>.
// If a prior assistant turn's text contains `<function_calls>…mcp__…</function_calls>`
// (the model having emitted a tool call as TEXT — the leak), replaying it verbatim
// PRIMES the model to keep emitting tool calls as text instead of issuing structured
// calls — even when its tools are present. One leaked turn then poisons every
// subsequent cold-start replay (self-reinforcing). The fix scrubs replayed history
// with sanitizeLeakedToolProtocol. These tests assert that — deterministically
// (the end-to-end leak is probabilistic; this is the reliable guard).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildColdStartPrompt } from "../index.js";

const MARKUP = ["<function_calls", "</function_calls>", "<invoke", "<parameter", "<tool_use", "mcp__custom-tools__"];

// A prior assistant turn that LEAKED tool calls as text (the real shape).
const POISONED_ASSISTANT = [
	"Let me check your config.",
	"<function_calls>",
	'<invoke name="mcp__custom-tools__bash">',
	'<parameter name="command">grep -rIE "opus|default" ~/.claude 2>/dev/null | head</parameter>',
	"</invoke>",
	"</function_calls>",
].join("\n");

describe("buildColdStartPrompt — scrubs leaked tool-protocol from replayed history", () => {
	it("removes <function_calls>…mcp__… markup from a prior [assistant] turn, keeps prose", () => {
		const messages = [
			{ role: "user", content: "What is my default model?" },
			{ role: "assistant", content: [{ type: "text", text: POISONED_ASSISTANT }] },
			{ role: "user", content: "continue" },
		];
		const out = buildColdStartPrompt(messages);

		for (const m of MARKUP) {
			assert.ok(!out.includes(m), `cold-start prompt must not replay ${m}`);
		}
		// history framing + genuine prose survive; current message present
		assert.ok(out.includes("<conversation_history>"), "history block preserved");
		assert.ok(out.includes("Let me check your config."), "prior prose preserved");
		assert.ok(out.includes("[user] What is my default model?"), "prior user turn preserved");
		assert.ok(out.includes("continue"), "current user message present");
	});

	it("scrubs leaked markup from a prior [user] history turn too", () => {
		const messages = [
			{ role: "user", content: `here is the format: <function_calls><invoke name="mcp__custom-tools__read"><parameter name="p">x</parameter></invoke></function_calls>` },
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
			{ role: "user", content: "now do it for real" },
		];
		const out = buildColdStartPrompt(messages);
		for (const m of MARKUP) assert.ok(!out.includes(m), `replayed user history must not carry ${m}`);
		assert.ok(out.includes("now do it for real"));
	});

	it("leaves a CLEAN history untouched (no over-scrubbing)", () => {
		const messages = [
			{ role: "user", content: "What is the capital of France?" },
			{ role: "assistant", content: [{ type: "text", text: "The capital of France is Paris." }] },
			{ role: "user", content: "and Germany?" },
		];
		const out = buildColdStartPrompt(messages);
		assert.ok(out.includes("The capital of France is Paris."));
		assert.ok(out.includes("[user] What is the capital of France?"));
		assert.ok(out.includes("and Germany?"));
	});

	it("does NOT scrub the LIVE current message (only replayed history)", () => {
		// A user legitimately asking about the protocol format in THIS turn must
		// reach the model intact — it is intent, not replayed poison.
		const messages = [
			{ role: "user", content: "hello" },
			{ role: "assistant", content: [{ type: "text", text: "hi" }] },
			{ role: "user", content: `how do I write a <function_calls> block calling mcp__custom-tools__bash?` },
		];
		const out = buildColdStartPrompt(messages);
		assert.ok(out.includes("how do I write a <function_calls> block"), "live current message preserved verbatim");
	});

	it("does not choke on toolCall blocks / toolResult turns", () => {
		const messages = [
			{ role: "user", content: "read the file" },
			{ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "a.txt" } }] },
			{ role: "toolResult", toolName: "read", isError: false, content: "name: pi-claude-bridge" },
			{ role: "user", content: "what was the name?" },
		];
		const out = buildColdStartPrompt(messages);
		assert.ok(out.includes("[tool: read("), "structured toolCall rendered");
		assert.ok(out.includes("pi-claude-bridge"), "tool result replayed");
	});
});
