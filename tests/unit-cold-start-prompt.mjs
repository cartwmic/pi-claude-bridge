#!/usr/bin/env node
// buildColdStartPrompt — FAITHFUL history invariant.
//
// Decision 2026-06-03: replayed conversation history is embedded VERBATIM. The
// bridge does NOT rewrite what the model previously produced, even if a prior
// turn leaked tool calls as text (<function_calls>…mcp__…). Content-based
// scrubbing was tried and reverted: a leaked tool call and a legitimate
// discussion of the tool-call format are textually identical, so any scrub
// corrupts real conversations (e.g. a developer debugging the bridge's own
// mcp__ protocol — this very kind of session). Leaks are surfaced at generation
// time + caught by the scenario log-guard, never silently rewritten on replay.
//
// These tests lock that in: markup in prior turns must survive untouched.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildColdStartPrompt } from "../index.js";

const PRIOR_WITH_MARKUP = [
	"Let me check your config.",
	"<function_calls>",
	'<invoke name="mcp__custom-tools__bash">',
	'<parameter name="command">grep -rIE "opus|default" ~/.claude 2>/dev/null | head</parameter>',
	"</invoke>",
	"</function_calls>",
].join("\n");

describe("buildColdStartPrompt — embeds replayed history verbatim (no scrubbing)", () => {
	it("PRESERVES tool-call markup in a prior [assistant] turn (does NOT rewrite history)", () => {
		const messages = [
			{ role: "user", content: "What is my default model?" },
			{ role: "assistant", content: [{ type: "text", text: PRIOR_WITH_MARKUP }] },
			{ role: "user", content: "continue" },
		];
		const out = buildColdStartPrompt(messages);
		// The model's prior output is part of the history — kept byte-for-byte.
		assert.ok(out.includes("<function_calls>"), "prior <function_calls> preserved");
		assert.ok(out.includes('<invoke name="mcp__custom-tools__bash">'), "prior <invoke mcp__…> preserved");
		assert.ok(out.includes('<parameter name="command">'), "prior <parameter> preserved");
		assert.ok(out.includes("Let me check your config."), "surrounding prose preserved");
		assert.ok(out.includes("<conversation_history>"), "history framing present");
		assert.ok(out.includes("continue"), "current user message present");
	});

	it("PRESERVES markup that appears in a prior [user] turn too", () => {
		const quoted = `here is the format: <function_calls><invoke name="mcp__custom-tools__read"><parameter name="p">x</parameter></invoke></function_calls>`;
		const messages = [
			{ role: "user", content: quoted },
			{ role: "assistant", content: [{ type: "text", text: "got it" }] },
			{ role: "user", content: "now do it for real" },
		];
		const out = buildColdStartPrompt(messages);
		assert.ok(out.includes(quoted), "prior user message preserved verbatim");
	});

	it("preserves the LIVE current message verbatim", () => {
		const messages = [
			{ role: "user", content: "hello" },
			{ role: "assistant", content: [{ type: "text", text: "hi" }] },
			{ role: "user", content: `how do I write a <function_calls> block calling mcp__custom-tools__bash?` },
		];
		const out = buildColdStartPrompt(messages);
		assert.ok(out.includes("how do I write a <function_calls> block calling mcp__custom-tools__bash?"));
	});

	it("renders structured toolCall as [tool: …] and replays toolResult content", () => {
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

	it("first-ever turn returns the bare user message (no history wrapper)", () => {
		const out = buildColdStartPrompt([{ role: "user", content: "hello world" }]);
		assert.equal(out, "hello world");
	});
});
