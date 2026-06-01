#!/usr/bin/env node
// Unit tests for the claude-p stdout stream parser in src/driver/stream.ts (T1.4).
//
// Cases are derived from the REAL claude-p fixture
// (.spike-notes/claude-p-gate/expC-claude-p-stream.jsonl) plus synthetic
// multi-round / parallel-tool / partial-line / drift fixtures.
//
// The parser is exercised WITHOUT a real subprocess: lines are fed via
// parser.write(chunk) and the subprocess lifecycle is signaled via
// parser.endOfStream({ aborted, exitInfo }). Events are collected through the
// onEvent callback.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { ClaudePStreamParser } from "../src/driver/stream.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(
	__dirname,
	"..",
	".spike-notes",
	"claude-p-gate",
	"expC-claude-p-stream.jsonl",
);

// ── helpers ──────────────────────────────────────────────────────────────────

/** A pino-compatible capturing logger: records warn() calls. */
function makeLogger() {
	const warns = [];
	return {
		warns,
		warn(...args) {
			warns.push(args);
		},
		// no-ops for the other levels the parser might touch
		info() {},
		debug() {},
		error() {},
	};
}

function newParser(logger) {
	const events = [];
	const parser = new ClaudePStreamParser({
		logger,
		onEvent: (e) => events.push(e),
	});
	return { parser, events };
}

/** Convenience: serialize a JS object as a JSON line (no trailing newline). */
function line(obj) {
	return JSON.stringify(obj);
}

// Synthetic content-line builders matching the verified claude-p schema.
function assistantBlocks(...blocks) {
	return {
		type: "assistant",
		message: { role: "assistant", content: blocks },
	};
}
function textBlock(text) {
	return { type: "text", text };
}
function thinkingBlock(thinking) {
	return { type: "thinking", thinking };
}
function toolUseBlock(id, name, input) {
	return { type: "tool_use", id, name, input };
}
function userToolResult(toolUseId, content) {
	return {
		type: "user",
		message: {
			role: "user",
			content: [{ type: "tool_result", tool_use_id: toolUseId, content }],
		},
	};
}
function resultLine(usage) {
	return { type: "result", subtype: "success", is_error: false, usage };
}

// ── 1. Real fixture replay ─────────────────────────────────────────────────

describe("real fixture replay (expC-claude-p-stream.jsonl)", () => {
	it("filters noise, suppresses WaitForMcpServers, surfaces bridged tool_use, maps usage then done", () => {
		const logger = makeLogger();
		const { parser, events } = newParser(logger);

		const raw = readFileSync(FIXTURE, "utf8");
		// Feed the whole fixture as one chunk; parser must split on newlines.
		parser.write(raw);

		// tool-use events: only the bridged mcp__* tool, NOT WaitForMcpServers.
		const toolUses = events.filter((e) => e.kind === "tool-use");
		assert.equal(toolUses.length, 1, "exactly one bridged tool-use surfaced");
		assert.equal(toolUses[0].name, "mcp__pi-spike-tools__pi_ping");
		assert.equal(toolUses[0].toolUseId, "toolu_01C41AFoMwaK29HtBL9i6bGP");
		assert.deepEqual(toolUses[0].arguments, { note: "test ping" });

		// No tool-use event names WaitForMcpServers.
		assert.ok(
			!toolUses.some((e) => e.name === "WaitForMcpServers"),
			"WaitForMcpServers must be suppressed",
		);

		// usage event from result line, exact mapping.
		const usage = events.filter((e) => e.kind === "usage");
		assert.equal(usage.length, 1, "exactly one usage event");
		assert.deepEqual(usage[0].usage, {
			input: 48,
			output: 2287,
			cacheRead: 127119,
			cacheWrite: 103973,
			totalTokens: 48 + 2287 + 127119 + 103973,
		});

		// done event after usage, reason result.
		const done = events.filter((e) => e.kind === "done");
		assert.equal(done.length, 1, "exactly one done event");
		assert.equal(done[0].reason, "result");

		// Ordering: usage before done; both last.
		const usageIdx = events.findIndex((e) => e.kind === "usage");
		const doneIdx = events.findIndex((e) => e.kind === "done");
		assert.ok(usageIdx < doneIdx, "usage precedes done");
		assert.equal(doneIdx, events.length - 1, "done is terminal");

		// No error events on a clean stream.
		assert.ok(!events.some((e) => e.kind === "error"), "no error on clean stream");

		// At least the trailing assistant text was emitted as a text-delta.
		const texts = events.filter((e) => e.kind === "text-delta");
		assert.ok(
			texts.some((e) => e.text.includes("PONG_FROM_PI_7Z9Q")),
			"final assistant text surfaced as text-delta",
		);
	});
});

// ── 2. Multi-round synthetic: turn-end only on result ──────────────────────

describe("multi-round turn", () => {
	it("keeps the turn in flight across tool rounds; emits done only at result", () => {
		const { parser, events } = newParser(makeLogger());

		parser.write(
			line(assistantBlocks(toolUseBlock("toolu_a", "mcp__custom-tools__read", { path: "/a" }))) + "\n",
		);
		parser.write(line(userToolResult("toolu_a", "ra")) + "\n");
		// no done yet
		assert.ok(!events.some((e) => e.kind === "done"), "no done after round 1");

		parser.write(
			line(assistantBlocks(toolUseBlock("toolu_b", "mcp__custom-tools__write", { path: "/b" }))) + "\n",
		);
		parser.write(line(userToolResult("toolu_b", "rb")) + "\n");
		assert.ok(!events.some((e) => e.kind === "done"), "no done after round 2");

		parser.write(line(assistantBlocks(textBlock("all done"))) + "\n");
		assert.ok(!events.some((e) => e.kind === "done"), "no done before result");

		parser.write(
			line(resultLine({ input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 })) + "\n",
		);

		const toolUses = events.filter((e) => e.kind === "tool-use");
		assert.equal(toolUses.length, 2, "two tool-use events across two rounds");
		const done = events.filter((e) => e.kind === "done");
		assert.equal(done.length, 1, "exactly one done, at result");
		assert.equal(done[0].reason, "result");
	});
});

// ── 3. Parallel tool_use in one assistant line ─────────────────────────────

describe("parallel tool_use", () => {
	it("emits two distinct tool-use events for two blocks in one assistant line", () => {
		const { parser, events } = newParser(makeLogger());
		parser.write(
			line(
				assistantBlocks(
					toolUseBlock("toolu_p1", "mcp__custom-tools__read", { path: "/x" }),
					toolUseBlock("toolu_p2", "mcp__custom-tools__read", { path: "/y" }),
				),
			) + "\n",
		);

		const toolUses = events.filter((e) => e.kind === "tool-use");
		assert.equal(toolUses.length, 2);
		assert.equal(toolUses[0].toolUseId, "toolu_p1");
		assert.equal(toolUses[1].toolUseId, "toolu_p2");
		assert.deepEqual(toolUses[0].arguments, { path: "/x" });
		assert.deepEqual(toolUses[1].arguments, { path: "/y" });
	});
});

// ── 4. Partial-line buffering ──────────────────────────────────────────────

describe("partial-line buffering", () => {
	it("does not emit until a newline arrives; one event after split write", () => {
		const { parser, events } = newParser(makeLogger());
		const full = line(assistantBlocks(textBlock("hello world")));
		const mid = Math.floor(full.length / 2);

		parser.write(full.slice(0, mid));
		assert.equal(events.length, 0, "no event from partial line");

		parser.write(full.slice(mid)); // still no newline
		assert.equal(events.length, 0, "still no event without newline");

		parser.write("\n");
		const texts = events.filter((e) => e.kind === "text-delta");
		assert.equal(texts.length, 1, "exactly one event after newline");
		assert.equal(texts[0].text, "hello world");
	});
});

// ── 5. Malformed line between two valid lines ──────────────────────────────

describe("malformed JSON line", () => {
	it("warns and skips, but emits both surrounding valid events", () => {
		const logger = makeLogger();
		const { parser, events } = newParser(logger);

		parser.write(line(assistantBlocks(textBlock("before"))) + "\n");
		parser.write("this is not json{{{\n");
		parser.write(line(assistantBlocks(textBlock("after"))) + "\n");

		const texts = events.filter((e) => e.kind === "text-delta");
		assert.deepEqual(
			texts.map((e) => e.text),
			["before", "after"],
		);
		assert.ok(!events.some((e) => e.kind === "done"), "malformed line does not end turn");
		assert.ok(logger.warns.length >= 1, "warn logged for malformed line");
	});
});

// ── 6. Unknown valid-JSON top-level type ───────────────────────────────────

describe("unknown top-level type (drift detection)", () => {
	it("warns naming the type, emits no event, continues", () => {
		const logger = makeLogger();
		const { parser, events } = newParser(logger);

		parser.write(line(assistantBlocks(textBlock("a"))) + "\n");
		parser.write(line({ type: "session_id_rotated", foo: 1 }) + "\n");
		parser.write(line(assistantBlocks(textBlock("b"))) + "\n");

		const texts = events.filter((e) => e.kind === "text-delta");
		assert.deepEqual(texts.map((e) => e.text), ["a", "b"]);
		assert.ok(!events.some((e) => e.kind === "done"));
		assert.ok(
			logger.warns.some((w) => JSON.stringify(w).includes("session_id_rotated")),
			"warn names the unknown type",
		);
	});

	it("does not warn for known-noise types", () => {
		const logger = makeLogger();
		const { parser, events } = newParser(logger);
		for (const t of [
			"mode",
			"permission-mode",
			"file-history-snapshot",
			"attachment",
			"ai-title",
		]) {
			parser.write(line({ type: t }) + "\n");
		}
		assert.equal(events.length, 0, "noise lines produce no events");
		assert.equal(logger.warns.length, 0, "noise lines produce no warnings");
	});

	it("does not warn for system/stop_hook_summary or system/turn_duration", () => {
		const logger = makeLogger();
		const { parser, events } = newParser(logger);
		parser.write(line({ type: "system", subtype: "stop_hook_summary" }) + "\n");
		parser.write(line({ type: "system", subtype: "turn_duration" }) + "\n");
		assert.equal(events.length, 0);
		assert.equal(logger.warns.length, 0);
	});
});

// ── 7. Premature exit without result ───────────────────────────────────────

describe("premature exit", () => {
	it("emits an error event when stdout closes before result (not aborted)", () => {
		const { parser, events } = newParser(makeLogger());
		parser.write(line(assistantBlocks(textBlock("partial answer"))) + "\n");
		parser.endOfStream({ aborted: false, exitInfo: { code: 2, signal: null } });

		const errs = events.filter((e) => e.kind === "error");
		assert.equal(errs.length, 1, "one error event on premature exit");
		assert.match(errs[0].errorMessage, /premature|terminat|result/i);
		assert.ok(!events.some((e) => e.kind === "done"), "no done on premature exit");
	});

	it("does NOT emit error when aborted before result", () => {
		const { parser, events } = newParser(makeLogger());
		parser.write(line(assistantBlocks(textBlock("partial"))) + "\n");
		parser.endOfStream({ aborted: true });
		assert.ok(!events.some((e) => e.kind === "error"), "no error when aborted");
		assert.ok(!events.some((e) => e.kind === "done"), "no done when aborted");
	});

	it("does NOT emit error when result was already seen", () => {
		const { parser, events } = newParser(makeLogger());
		parser.write(
			line(resultLine({ input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })) + "\n",
		);
		parser.endOfStream({ aborted: false, exitInfo: { code: 0, signal: null } });
		assert.ok(!events.some((e) => e.kind === "error"), "no error after clean result");
		assert.equal(events.filter((e) => e.kind === "done").length, 1);
	});
});

// ── 8. Usage mapping exactness ─────────────────────────────────────────────

describe("usage mapping", () => {
	it("maps result.usage fields exactly and sums totalTokens", () => {
		const { parser, events } = newParser(makeLogger());
		parser.write(
			line(
				resultLine({
					input_tokens: 11,
					output_tokens: 22,
					cache_read_input_tokens: 33,
					cache_creation_input_tokens: 44,
				}),
			) + "\n",
		);
		const usage = events.find((e) => e.kind === "usage");
		assert.deepEqual(usage.usage, {
			input: 11,
			output: 22,
			cacheRead: 33,
			cacheWrite: 44,
			totalTokens: 110,
		});
	});

	it("treats missing usage subfields as 0", () => {
		const { parser, events } = newParser(makeLogger());
		parser.write(line(resultLine({ input_tokens: 5, output_tokens: 7 })) + "\n");
		const usage = events.find((e) => e.kind === "usage");
		assert.deepEqual(usage.usage, {
			input: 5,
			output: 7,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 12,
		});
	});
});

// ── 9. thinking-delta ──────────────────────────────────────────────────────

describe("thinking blocks", () => {
	it("emits thinking-delta for non-empty thinking content", () => {
		const { parser, events } = newParser(makeLogger());
		parser.write(line(assistantBlocks(thinkingBlock("let me think"))) + "\n");
		const th = events.filter((e) => e.kind === "thinking-delta");
		assert.equal(th.length, 1);
		assert.equal(th[0].text, "let me think");
	});
});
