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

// A real user PROMPT line: claude-p renders the prompt content as a STRING.
function userPrompt(text) {
	return { type: "user", message: { role: "user", content: text } };
}
// Inter-segment / lifecycle noise claude-p flushes around replayed turns.
function noiseLine(type) {
	return { type };
}
function lastPromptLine(lastPrompt) {
	return { type: "last-prompt", lastPrompt, leafUuid: "x", sessionId: "s" };
}
function turnLifecycleNoise() {
	return [
		line(noiseLine("mode")),
		line({ type: "system", subtype: "stop_hook_summary" }),
		line({ type: "system", subtype: "turn_duration" }),
	].join("\n");
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

// ── 1b. G3: real MULTI-ROUND fixture — result is per-TURN, not per-segment ──
//
// Captured by tests/int-claude-p-multiround.mjs against the REAL claude-p binary
// (3 sequential held tool rounds in one spawn). This is the cut-over-BLOCKING
// turn-end assertion (gate 0b.G3): a per-segment `result` mis-detected as
// turn-end would corrupt multi-round turns. The fixture proves claude-p emits
// exactly ONE `result` line for the whole turn (no `result` between rounds), so
// the parser's "turn-end only on result; tool rounds don't terminate" rule is
// correct against the observed schema.
const MULTIROUND_FIXTURE = join(
	__dirname,
	"..",
	".spike-notes",
	"claude-p-gate",
	"g1-multiround-stream.jsonl",
);

describe("G3: real multi-round fixture (g1-multiround-stream.jsonl)", () => {
	it("emits exactly ONE terminal done at the single per-turn result, across >=3 tool rounds", () => {
		let raw;
		try {
			raw = readFileSync(MULTIROUND_FIXTURE, "utf8");
		} catch {
			// Fixture only exists after the G1 integration run; skip if absent so the
			// default unit sweep (which doesn't spawn claude-p) stays green.
			return;
		}

		// Pre-assert the fixture itself contains exactly ONE `result` line (per-TURN,
		// not per-segment) — this is the raw-schema half of G3.
		const resultLines = raw
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0)
			.filter((l) => {
				try {
					return JSON.parse(l).type === "result";
				} catch {
					return false;
				}
			});
		assert.equal(
			resultLines.length,
			1,
			`fixture must carry exactly ONE result line per turn (per-TURN, not per-segment); saw ${resultLines.length}`,
		);

		const logger = makeLogger();
		const { parser, events } = newParser(logger);
		parser.write(raw);
		parser.endOfStream({ aborted: false, exitInfo: { code: 0, signal: null } });

		// >=3 bridged tool rounds surfaced (claude double-prefixes the MCP name:
		// `mcp__custom-tools__mcp__custom-tools__step`; matched by prefix+suffix).
		const toolUses = events.filter(
			(e) => e.kind === "tool-use" && e.name.startsWith("mcp__") && e.name.endsWith("__step"),
		);
		assert.ok(toolUses.length >= 3, `>=3 bridged tool-use rounds; saw ${toolUses.length}`);

		// WaitForMcpServers never surfaces as a bridged tool-use.
		assert.ok(
			!events.some((e) => e.kind === "tool-use" && e.name === "WaitForMcpServers"),
			"WaitForMcpServers filtered",
		);

		// Exactly ONE terminal done(reason=result), and it is the LAST event — no
		// tool round terminated the turn early.
		const done = events.filter((e) => e.kind === "done");
		assert.equal(done.length, 1, "exactly one terminal done across all rounds");
		assert.equal(done[0].reason, "result");
		assert.equal(events[events.length - 1].kind, "done", "done is terminal");

		// Exactly one usage event (from the single result line); no error on a clean
		// multi-round stream.
		assert.equal(events.filter((e) => e.kind === "usage").length, 1, "one usage event");
		assert.ok(!events.some((e) => e.kind === "error"), "no error on clean multi-round stream");
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

// ── 10. warm-resume RE-ECHO suppression (G5) ───────────────────────────────
//
// On a `--resume` turn claude-p drains the FULL replayed transcript to stdout
// before the live turn. With suppressResumeReplay:true the parser emits ONLY the
// LIVE turn — the final segment after the last user-prompt line, incl. its tool
// rounds + final text + terminal usage/done. Default/false → no suppression. The
// "last segment" rule is robust to prior-prompt-count drift (abort) and to the
// SAME prompt text recurring across turns (both break a count/text boundary).

function newParserSuppressed(logger) {
	const events = [];
	const parser = new ClaudePStreamParser({
		logger: logger ?? makeLogger(),
		onEvent: (e) => events.push(e),
		suppressResumeReplay: true,
	});
	return { parser, events };
}

// Synthetic --resume stream: 2 replayed prompt turns, then a LIVE turn that runs a
// tool round (assistant text → bridged tool_use → tool_result user line → final
// text) and ends with the terminal result. Mirrors the verified schema in
// g4-singleshot-raw/e1.raw.txt (user-string prompts, last-prompt + noise between
// segments) plus the tool-round shape from g1-multiround-stream.jsonl.
function resumeStream() {
	return [
		// ── replayed turn 1 ──
		line(noiseLine("mode")),
		line(userPrompt("My favorite number is 4242. Acknowledge with just 'ok'.")),
		line(assistantBlocks(thinkingBlock("hmm"))),
		line(assistantBlocks(textBlock("ok"))),
		turnLifecycleNoise(),
		line(lastPromptLine("My favorite number is 4242. Acknowledge with just 'ok'.")),
		// ── replayed turn 2 ──
		line(userPrompt("What is my favorite number? Reply with just the number.")),
		line(assistantBlocks(textBlock("4242"))),
		turnLifecycleNoise(),
		line(lastPromptLine("What is my favorite number? Reply with just the number.")),
		// ── LIVE turn (3rd prompt) with a tool round ──
		line(userPrompt("Use the step tool then tell me the result.")),
		line(assistantBlocks(textBlock("LIVE: let me call the tool"))),
		line(assistantBlocks(toolUseBlock("toolu_live", "mcp__custom-tools__step", { n: 1 }))),
		userToolResult("toolu_live", "stepped"),
		line(assistantBlocks(textBlock("LIVE: done, result is 1"))),
		turnLifecycleNoise(),
		line(resultLine({ input_tokens: 10, output_tokens: 3 })),
	].join("\n") + "\n";
}

describe("warm-resume RE-ECHO suppression (G5)", () => {
	it("suppresses replayed history, emits ONLY the live turn (text + tool + final + usage/done)", () => {
		const { parser, events } = newParserSuppressed();
		parser.write(resumeStream());

		const texts = events.filter((e) => e.kind === "text-delta").map((e) => e.text);
		// Replayed assistant text ("ok", "4242") MUST NOT re-echo.
		assert.ok(!texts.includes("ok"), 'replayed "ok" must be suppressed');
		assert.ok(!texts.includes("4242"), 'replayed "4242" must be suppressed');
		// Only the live-turn text survives, in order.
		assert.deepEqual(texts, ["LIVE: let me call the tool", "LIVE: done, result is 1"]);

		// The live tool_use IS observed (suppression must not break live tool obs).
		const tools = events.filter((e) => e.kind === "tool-use");
		assert.equal(tools.length, 1);
		assert.equal(tools[0].toolUseId, "toolu_live");
		assert.equal(tools[0].name, "mcp__custom-tools__step");

		// Live events are flushed BEFORE the terminal usage/done, preserving order.
		const kinds = events.map((e) => e.kind);
		assert.deepEqual(kinds, ["text-delta", "tool-use", "text-delta", "usage", "done"]);

		// Terminal usage + done are NEVER suppressed.
		const usage = events.find((e) => e.kind === "usage");
		assert.ok(usage, "terminal usage emitted");
		assert.equal(usage.usage.input, 10);
		assert.equal(usage.usage.output, 3);
		assert.ok(events.some((e) => e.kind === "done" && e.reason === "result"), "terminal done emitted");
	});

	it("tool_result user lines within the live turn do NOT discard live content (text before tool_result kept)", () => {
		const { parser, events } = newParserSuppressed();
		parser.write(resumeStream());
		const texts = events.filter((e) => e.kind === "text-delta").map((e) => e.text);
		// "LIVE: let me call the tool" precedes the tool_result and MUST be present.
		assert.ok(texts.includes("LIVE: let me call the tool"));
		assert.equal(texts.length, 2);
	});

	it("suppressResumeReplay false (default) → NO suppression: fresh-turn behavior unchanged", () => {
		const { parser, events } = newParser(makeLogger());
		parser.write(resumeStream());
		const texts = events.filter((e) => e.kind === "text-delta").map((e) => e.text);
		assert.deepEqual(texts, ["ok", "4242", "LIVE: let me call the tool", "LIVE: done, result is 1"]);
		assert.equal(events.filter((e) => e.kind === "tool-use").length, 1);
		assert.ok(events.some((e) => e.kind === "done" && e.reason === "result"));
	});

	it("robust to DUPLICATE prompt text recurring across turns (the S8 retry case)", () => {
		// The SAME recall prompt is sent on turn 1 (replayed) and the live turn. A
		// first-match-text or count boundary would mis-fire on the replayed copy and
		// re-echo turn-1's answer; the "last segment" rule cannot.
		const dup = "Did the SlowTool finish? Answer in one sentence.";
		const stream = [
			line(userPrompt("Call SlowTool with seconds=10.")),
			line(assistantBlocks(textBlock("calling..."))),
			turnLifecycleNoise(),
			line(lastPromptLine("Call SlowTool with seconds=10.")),
			line(userPrompt(dup)),                                  // replayed copy
			line(assistantBlocks(textBlock("It completed successfully."))), // STALE fabrication
			turnLifecycleNoise(),
			line(lastPromptLine(dup)),
			line(userPrompt(dup)),                                  // LIVE copy (identical text)
			line(assistantBlocks(textBlock("It did not complete; I never called it."))),
			turnLifecycleNoise(),
			line(resultLine({ input_tokens: 2, output_tokens: 2 })),
		].join("\n") + "\n";
		const { parser, events } = newParserSuppressed();
		parser.write(stream);
		const texts = events.filter((e) => e.kind === "text-delta").map((e) => e.text);
		// The stale "It completed successfully." re-echo MUST be gone.
		assert.ok(!texts.some((t) => /completed successfully/i.test(t)), "stale fabrication must not re-echo");
		assert.deepEqual(texts, ["It did not complete; I never called it."]);
		assert.ok(events.some((e) => e.kind === "done" && e.reason === "result"));
	});

	it("robust to prompt-count drift (abort off-by-one): emits the live segment regardless of prior count", () => {
		// Resume transcript persisted 1 prior prompt; whatever pi's history count is,
		// the parser emits the segment after the LAST prompt — no count needed.
		const stream = [
			line(userPrompt("First persisted prior prompt.")),
			line(assistantBlocks(textBlock("ok"))),
			turnLifecycleNoise(),
			line(lastPromptLine("First persisted prior prompt.")),
			line(userPrompt("KIWI-LIVE marker prompt")),
			line(assistantBlocks(textBlock("LIVE answer"))),
			turnLifecycleNoise(),
			line(resultLine({ input_tokens: 1, output_tokens: 1 })),
		].join("\n") + "\n";
		const { parser, events } = newParserSuppressed();
		parser.write(stream);
		const texts = events.filter((e) => e.kind === "text-delta").map((e) => e.text);
		assert.deepEqual(texts, ["LIVE answer"]);
		assert.ok(events.some((e) => e.kind === "done" && e.reason === "result"));
	});

	it("aborted warm-resume (no terminal result): live partial flushed on endOfStream, replay prefix discarded", () => {
		// SIGINT abort mid live turn → no `result`. The buffered LIVE partial must be
		// flushed (for commitAbortedPartial) and the replayed prefix discarded.
		const stream = [
			line(userPrompt("Prior prompt.")),
			line(assistantBlocks(textBlock("PRIOR-DONE"))),
			turnLifecycleNoise(),
			line(lastPromptLine("Prior prompt.")),
			line(userPrompt("Live prompt — count slowly.")),
			line(assistantBlocks(textBlock("LIVE partial 1, 2, 3"))),
			// NO turn lifecycle / result — aborted here.
		].join("\n") + "\n";
		const { parser, events } = newParserSuppressed();
		parser.write(stream);
		// Nothing emitted yet (buffered) until endOfStream.
		assert.equal(events.length, 0, "live content stays buffered until terminal/endOfStream");
		parser.endOfStream({ aborted: true });
		const texts = events.filter((e) => e.kind === "text-delta").map((e) => e.text);
		assert.ok(!texts.includes("PRIOR-DONE"), "replayed prior text must be discarded on abort");
		assert.deepEqual(texts, ["LIVE partial 1, 2, 3"], "live partial flushed on abort");
	});

	it("single prior prompt (warm 2nd turn, no tools) → emits only the 2nd turn's text", () => {
		const { parser, events } = newParserSuppressed();
		const stream = [
			line(noiseLine("mode")),
			line(userPrompt("My favorite number is 4242. Acknowledge with just 'ok'.")),
			line(assistantBlocks(textBlock("ok"))),
			turnLifecycleNoise(),
			line(lastPromptLine("My favorite number is 4242. Acknowledge with just 'ok'.")),
			line(userPrompt("What is my favorite number?")),
			line(assistantBlocks(textBlock("4242"))),
			turnLifecycleNoise(),
			line(resultLine({ input_tokens: 4, output_tokens: 2 })),
		].join("\n") + "\n";
		parser.write(stream);
		const texts = events.filter((e) => e.kind === "text-delta").map((e) => e.text);
		assert.deepEqual(texts, ["4242"], 'turn-1 "ok" suppressed, only live "4242" emitted');
		assert.ok(events.some((e) => e.kind === "done" && e.reason === "result"));
	});
});
