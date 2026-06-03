#!/usr/bin/env node
// Regression: leaked tool-call PROTOCOL markup in assistant text.
//
// Observed 2026-06-03 (pi session 019e8c37, provider claude-bridge, opus-4-7):
// when the model can't reach its MCP tools (shim not attached / API 529 / degraded
// agent loop) it emits tool calls as TEXT —
//   <function_calls><invoke name="mcp__custom-tools__bash"><parameter …>…</parameter></invoke></function_calls>
// claude-p streams that as an ordinary assistant `text` block, so the bridge
// rendered 27 such blocks to the user as raw XML.
//
// Per D32 the parser does NOT route tools (shim/router owns routing); the fix is to
// keep raw protocol XML out of the user-visible text. These tests assert:
//   1. sanitizeLeakedToolProtocol() removes mcp__ <function_calls> blocks + the
//      <§></§> artifact, preserves genuine prose, and counts what it stripped.
//   2. End-to-end through ClaudePStreamParser, NO text-delta event carries the
//      markup, a warn (claudeP.stream.toolProtocolLeak) is logged, and the real
//      prose still streams.
//   3. False-positive guard: a user legitimately discussing the <function_calls>
//      format (no mcp__ invoke) is NOT clobbered.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ClaudePStreamParser, sanitizeLeakedToolProtocol } from "../src/driver/stream.js";

// A faithful slice of the real leak: leading error text + <§></§> artifact + two
// mcp__ tool-call blocks + a trailing coherent answer (genuine prose to preserve).
const LEAKED = [
	"API Error: 529 Overloaded. This is a server-side issue.Check bridge config first.",
	"",
	"<§>",
	"</§>",
	"",
	"Let me search.",
	"",
	'<function_calls>',
	'<invoke name="mcp__custom-tools__bash">',
	'<parameter name="command">grep -r "opus" ~/.claude 2>/dev/null | head -40</parameter>',
	"</invoke>",
	"</function_calls>",
	'<function_calls>',
	'<invoke name="mcp__custom-tools__read">',
	'<parameter name="abs_path">/Users/cartwmic/.pi/config.toml</parameter>',
	"</invoke>",
	"</function_calls>",
	"",
	"**Steps:** run `pi --list-models` to confirm the 4.8 id is present, then edit your pi default.",
].join("\n");

const MARKUP_MARKERS = ["<function_calls>", "</function_calls>", "<invoke", "<parameter", "<§>", "</§>"];

function makeLogger() {
	const warns = [];
	return { warns, warn: (...a) => warns.push(a), info() {}, debug() {}, error() {} };
}

describe("sanitizeLeakedToolProtocol", () => {
	it("strips mcp__ <function_calls> blocks + <§></§>, preserves prose, counts spans", () => {
		const { clean, stripped } = sanitizeLeakedToolProtocol(LEAKED);
		assert.equal(stripped, 3, "2 function_calls blocks + 1 <§></§> artifact");
		for (const m of MARKUP_MARKERS) {
			assert.ok(!clean.includes(m), `clean text must not contain ${m}`);
		}
		// genuine prose on both sides survives
		assert.ok(clean.includes("Let me search."));
		assert.ok(clean.includes("**Steps:**") && clean.includes("pi --list-models"));
		// the 529 notice (not protocol markup) is left intact
		assert.ok(clean.includes("529 Overloaded"));
	});

	it("is a no-op for ordinary text (0 stripped)", () => {
		const t = "Here is your answer. No XML here.";
		const { clean, stripped } = sanitizeLeakedToolProtocol(t);
		assert.equal(stripped, 0);
		assert.equal(clean, t);
	});

	it("handles a dangling <function_calls> opener that invokes an mcp__ tool", () => {
		const t = 'ok\n<function_calls>\n<invoke name="mcp__custom-tools__bash">\n<parameter name="command">ls';
		const { clean, stripped } = sanitizeLeakedToolProtocol(t);
		assert.ok(stripped >= 1);
		assert.ok(!clean.includes("<function_calls>") && !clean.includes("<invoke"));
		assert.ok(clean.startsWith("ok"));
	});

	it("does NOT clobber a user legitimately discussing the format (no mcp__ invoke)", () => {
		const t = 'To call a tool you write <function_calls> with an <invoke name="someTool"> block.';
		const { clean, stripped } = sanitizeLeakedToolProtocol(t);
		assert.equal(stripped, 0, "no mcp__ invocation → not a real leak → left intact");
		assert.equal(clean, t);
	});
});

describe("ClaudePStreamParser — no tool-protocol leak reaches text-delta", () => {
	it("withholds raw <function_calls> XML, warns, and still streams the real prose", () => {
		const logger = makeLogger();
		const events = [];
		const parser = new ClaudePStreamParser({ logger, onEvent: (e) => events.push(e) });

		parser.write(
			JSON.stringify({
				type: "assistant",
				message: { role: "assistant", content: [{ type: "text", text: LEAKED }] },
			}) + "\n",
		);
		parser.write(
			JSON.stringify({
				type: "result",
				subtype: "success",
				usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			}) + "\n",
		);
		parser.endOfStream({ aborted: false, exitInfo: { code: 0, signal: null } });

		const deltas = events.filter((e) => e.kind === "text-delta");
		assert.ok(deltas.length >= 1, "the real prose still streams");
		const joined = deltas.map((d) => d.text).join("");
		for (const m of MARKUP_MARKERS) {
			assert.ok(!joined.includes(m), `no text-delta may contain ${m}`);
		}
		assert.ok(joined.includes("**Steps:**"), "genuine answer preserved");

		const leakWarn = logger.warns.find(
			(w) => w[0] && typeof w[0] === "object" && w[0].event === "claudeP.stream.toolProtocolLeak",
		);
		assert.ok(leakWarn, "a toolProtocolLeak warn must be emitted");
		assert.equal(leakWarn[0].stripped, 3);

		// And it must RAISE the degradation signal so the bridge can surface the
		// turn as a failure (constitution VII) when no real tool routed.
		const leakEvent = events.find((e) => e.kind === "tool-protocol-leak");
		assert.ok(leakEvent, "parser must emit a tool-protocol-leak event");
		assert.equal(leakEvent.stripped, 3);
		assert.equal(leakEvent.hadProse, true, "this turn had a real answer after the markup");
	});
});
