/**
 * Unit tests for output-capture call-shape validation (tasks 2.5 and 2.6).
 *
 * Covers:
 *  - validateCaptureCallShape() pure-function cases
 *  - classifyToolsForCapture() pure-function cases
 *  - streamClaudeAgentSdk() end-to-end shape-gate: rejection, acceptance, fallthrough
 *  - Tool-result delivery is NOT classified (task 2.5)
 *  - piApiRef === null fallback (task 2.5)
 *  - Log assertion: "streamSimple: rejected capture-shape" present on rejection,
 *    no "streamSimple: fresh query" (without mode=capture) for the same call (task 2.6)
 *
 * Uses dynamic import so CLAUDE_BRIDGE_DEBUG_PATH is set before the logger initialises.
 */

import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Type } from "@sinclair/typebox";

// ── Log routing: must happen before index.js is loaded ──────────────────────
const LOG_DIR = mkdtempSync(join(tmpdir(), "bridge-shape-test-"));
const LOG_FILE = join(LOG_DIR, "bridge.log");
process.env.CLAUDE_BRIDGE_DEBUG_PATH = LOG_FILE;
process.env.CLAUDE_BRIDGE_DEBUG = "1";

// ── Dynamic import so the logger uses our temp file ─────────────────────────
const {
	streamClaudeAgentSdk,
	validateCaptureCallShape,
	classifyToolsForCapture,
	getActiveToolNameSet,
	cleanSchemaForSdk,
	__setQueryFactoryForTests,
	__setPiApiRefForTests,
	__resetCachedSessionForTests,
} = await import("../index.js");

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal model stub (only fields used by newTurnOutput + calculateCost). */
const MOCK_MODEL = {
	id: "claude-haiku-4-5",
	cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

/** Build a minimal user-turn Context. */
function ctx({ tools = [], systemPrompt = "test", messages } = {}) {
	return {
		systemPrompt,
		messages: messages ?? [{ role: "user", content: "hello", timestamp: Date.now() }],
		tools,
	};
}

/** Wait for log writes to flush (pino writes async to rotating-file-stream). */
const flushMs = () => new Promise((r) => setTimeout(r, 120));

/** Read all pino JSON log lines from our temp file. Returns parsed objects. */
function readLogObjects() {
	try {
		return readFileSync(LOG_FILE, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => {
				try { return JSON.parse(l); }
				catch { return null; }
			})
			.filter(Boolean);
	} catch {
		return [];
	}
}

/** Collect ALL events emitted by an AssistantMessageEventStream. */
async function collectEvents(stream) {
	const events = [];
	for await (const evt of stream) events.push(evt);
	return events;
}

/** Mock factory that immediately throws when called — used to assert no factory call. */
function makeBombFactory(label) {
	function bomb() {
		throw new Error(`BUG: ${label} factory should not have been called`);
	}
	bomb.calls = [];
	return bomb;
}

/** Factory that records calls and returns a result immediately (for capture path). */
function makeRecordingCaptureFactory(structuredOutput = { body: "x".repeat(50), headline: "h", topics: [] }) {
	const calls = [];
	function factory(params) {
		calls.push(params);
		async function* gen() {
			yield {
				type: "result",
				subtype: "success",
				structured_output: structuredOutput,
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

// ── Tools for shape tests ────────────────────────────────────────────────────

const objectTool = (name) => ({
	name,
	description: `test tool ${name}`,
	parameters: Type.Object({ x: Type.String() }),
});
const arrayTool = (name) => ({
	name,
	description: `test array-root tool ${name}`,
	parameters: Type.Array(Type.String()),
});

// ────────────────────────────────────────────────────────────────────────────
// 1. validateCaptureCallShape — pure function tests
// ────────────────────────────────────────────────────────────────────────────

describe("validateCaptureCallShape", () => {
	it("zero capture tools → all-executable", () => {
		const result = validateCaptureCallShape({ executable: [objectTool("regA")], capture: [] });
		assert.equal(result.kind, "all-executable");
	});

	it("zero tools at all → all-executable", () => {
		const result = validateCaptureCallShape({ executable: [], capture: [] });
		assert.equal(result.kind, "all-executable");
	});

	it("single capture tool with object root → single-capture", () => {
		const tool = objectTool("capA");
		const result = validateCaptureCallShape({ executable: [], capture: [tool] });
		assert.equal(result.kind, "single-capture");
		assert.equal(result.captureTool.name, "capA");
		assert.equal(result.cleanedSchema.type, "object");
	});

	it("two capture tools, no executable → rejected", () => {
		const result = validateCaptureCallShape({
			executable: [],
			capture: [objectTool("capA"), objectTool("capB")],
		});
		assert.equal(result.kind, "rejected");
		assert.match(result.reason, /capA/);
		assert.match(result.reason, /capB/);
	});

	it("mixed: one capture + one executable → rejected", () => {
		const result = validateCaptureCallShape({
			executable: [objectTool("regA")],
			capture: [objectTool("capB")],
		});
		assert.equal(result.kind, "rejected");
		assert.match(result.reason, /capB/);
		assert.match(result.reason, /regA/);
	});

	it("single capture tool with non-object root (array) → rejected", () => {
		const result = validateCaptureCallShape({
			executable: [],
			capture: [arrayTool("capArr")],
		});
		assert.equal(result.kind, "rejected");
		assert.match(result.reason, /capArr/);
		assert.match(result.reason, /array/);
	});

	it("single capture with object root carries cleanedSchema with no symbols", () => {
		const tool = objectTool("capZ");
		const result = validateCaptureCallShape({ executable: [], capture: [tool] });
		assert.equal(result.kind, "single-capture");
		// Cleaned schema has no symbol-keyed properties
		function hasNoSymbols(obj) {
			if (typeof obj !== "object" || obj === null) return true;
			if (Object.getOwnPropertySymbols(obj).length > 0) return false;
			return Object.values(obj).every(hasNoSymbols);
		}
		assert.ok(hasNoSymbols(result.cleanedSchema), "cleanedSchema should have no symbol keys at any depth");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// 2. classifyToolsForCapture — pure function tests
// ────────────────────────────────────────────────────────────────────────────

describe("classifyToolsForCapture", () => {
	const ctxWith = (tools) => ({ tools, messages: [], systemPrompt: "" });

	it("all tools in activeNames → all executable", () => {
		const tools = [objectTool("regA"), objectTool("regB")];
		const result = classifyToolsForCapture(ctxWith(tools), new Set(["regA", "regB"]), "__excluded__");
		assert.deepEqual(result.executable.map((t) => t.name), ["regA", "regB"]);
		assert.deepEqual(result.capture, []);
	});

	it("no tools in activeNames → all capture", () => {
		const tools = [objectTool("capA"), objectTool("capB")];
		const result = classifyToolsForCapture(ctxWith(tools), new Set([]), "__excluded__");
		assert.deepEqual(result.executable, []);
		assert.deepEqual(result.capture.map((t) => t.name), ["capA", "capB"]);
	});

	it("mixed: some in activeNames → split correctly", () => {
		const tools = [objectTool("regA"), objectTool("capB")];
		const result = classifyToolsForCapture(ctxWith(tools), new Set(["regA"]), "__excluded__");
		assert.deepEqual(result.executable.map((t) => t.name), ["regA"]);
		assert.deepEqual(result.capture.map((t) => t.name), ["capB"]);
	});

	it("excludeName is skipped entirely", () => {
		const tools = [objectTool("__excluded__"), objectTool("capA")];
		const result = classifyToolsForCapture(ctxWith(tools), new Set([]), "__excluded__");
		// the excluded tool should be excluded from both arrays
		const allNames = [...result.executable.map((t) => t.name), ...result.capture.map((t) => t.name)];
		assert.ok(!allNames.includes("__excluded__"), "excluded tool should be excluded");
		assert.deepEqual(result.capture.map((t) => t.name), ["capA"]);
	});

	it("empty ctx.tools → both arrays empty", () => {
		const result = classifyToolsForCapture({ tools: [], messages: [], systemPrompt: "" }, new Set(["x"]), "__excluded__");
		assert.deepEqual(result.executable, []);
		assert.deepEqual(result.capture, []);
	});

	it("undefined ctx.tools → both arrays empty", () => {
		const result = classifyToolsForCapture({ messages: [], systemPrompt: "" }, new Set(["x"]), "__excluded__");
		assert.deepEqual(result.executable, []);
		assert.deepEqual(result.capture, []);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// 3. streamClaudeAgentSdk end-to-end shape gate
// ────────────────────────────────────────────────────────────────────────────

describe("streamClaudeAgentSdk — capture-shape gate", () => {
	let restoreFactory = null;
	let restoreApi = null;

	afterEach(() => {
		restoreFactory?.();
		restoreFactory = null;
		restoreApi?.();
		restoreApi = null;
		__resetCachedSessionForTests();
	});

	/**
	 * Helper: drive a streamClaudeAgentSdk call through the shape gate with
	 * two unregistered tools in ctx.tools. Confirms rejection events.
	 */
	async function driveRejection(tools) {
		// Bomb factory: if called, it's a bug (rejection should short-circuit before any query)
		restoreFactory = __setQueryFactoryForTests(makeBombFactory("rejection"));
		// piApiRef returns no active tools → all tools are capture tools
		restoreApi = __setPiApiRefForTests({ getActiveTools: () => [] });

		const stream = streamClaudeAgentSdk(MOCK_MODEL, ctx({ tools }));
		const events = await collectEvents(stream);
		return events;
	}

	// ── 3.1 Two unregistered tools: rejected ─────────────────────────────────

	it("two unregistered tools → rejected (stream emits start+error; no factory call)", async () => {
		const preLogCount = readLogObjects().length;

		const events = await driveRejection([objectTool("capA"), objectTool("capB")]);
		await flushMs();

		// Stream must emit start then error
		assert.equal(events.length, 2, `Expected 2 events but got: ${JSON.stringify(events.map((e) => e.type))}`);
		assert.equal(events[0].type, "start");
		assert.equal(events[1].type, "error");
		assert.match(events[1].error.errorMessage, /capA/);
		assert.match(events[1].error.errorMessage, /capB/);
		assert.equal(events[1].error.stopReason, "error");

		// Log assertions (task 2.6): "rejected capture-shape" present, "fresh query" absent
		const newLines = readLogObjects().slice(preLogCount);
		const hasRejected = newLines.some((l) => typeof l.msg === "string" && l.msg.includes("streamSimple: rejected capture-shape"));
		const hasFreshQuery = newLines.some(
			(l) => typeof l.msg === "string" && l.msg.includes("streamSimple: fresh query") && !l.mode,
		);
		assert.ok(hasRejected, `Expected 'streamSimple: rejected capture-shape' in log. New lines: ${JSON.stringify(newLines.map((l) => l.msg))}`);
		assert.ok(!hasFreshQuery, `Expected no 'streamSimple: fresh query' (non-capture) in log for rejected call`);
	});

	// ── 3.2 Mixed: one registered + one unregistered → rejected ──────────────

	it("mixed registered+unregistered → rejected", async () => {
		restoreFactory = __setQueryFactoryForTests(makeBombFactory("mixed-rejection"));
		restoreApi = __setPiApiRefForTests({ getActiveTools: () => ["regA"] });

		const stream = streamClaudeAgentSdk(MOCK_MODEL, ctx({ tools: [objectTool("regA"), objectTool("capB")] }));
		const events = await collectEvents(stream);

		assert.equal(events.length, 2);
		assert.equal(events[0].type, "start");
		assert.equal(events[1].type, "error");
		assert.match(events[1].error.errorMessage, /capB/);
		assert.match(events[1].error.errorMessage, /regA/);
	});

	// ── 3.3 Single capture tool with non-object root → rejected ──────────────

	it("single capture tool with array root → rejected", async () => {
		restoreFactory = __setQueryFactoryForTests(makeBombFactory("array-root-rejection"));
		restoreApi = __setPiApiRefForTests({ getActiveTools: () => [] });

		const stream = streamClaudeAgentSdk(MOCK_MODEL, ctx({ tools: [arrayTool("capArr")] }));
		const events = await collectEvents(stream);

		assert.equal(events.length, 2);
		assert.equal(events[0].type, "start");
		assert.equal(events[1].type, "error");
		assert.match(events[1].error.errorMessage, /capArr/);
		assert.match(events[1].error.errorMessage, /array/);
	});

	// ── 3.4 Single capture tool with object root → accepted (capture path) ───

	it("single capture tool with object root → accepted (capture path runs)", async () => {
		const captureFactory = makeRecordingCaptureFactory();
		restoreFactory = __setQueryFactoryForTests(captureFactory);
		restoreApi = __setPiApiRefForTests({ getActiveTools: () => [] });

		const stream = streamClaudeAgentSdk(
			MOCK_MODEL,
			ctx({ tools: [objectTool("capObj")], systemPrompt: "test capture" }),
		);
		const result = await stream.result();

		assert.equal(result.stopReason, "toolUse", `Expected toolUse stopReason, got: ${result.stopReason}`);
		assert.equal(result.content.length, 1);
		assert.equal(result.content[0].type, "toolCall");
		assert.equal(result.content[0].name, "capObj");
		// Capture path factory was called once with outputFormat
		assert.equal(captureFactory.calls.length, 1);
		assert.ok(captureFactory.calls[0].options?.outputFormat, "Capture call must have outputFormat");
	});

	// ── 3.5 Empty ctx.tools → falls through to fresh-query path ─────────────

	it("empty ctx.tools → falls through (fresh query, not capture)", async () => {
		const freshFactory = makeRecordingCaptureFactory(); // will NOT be called with outputFormat
		restoreFactory = __setQueryFactoryForTests(freshFactory);
		restoreApi = __setPiApiRefForTests({ getActiveTools: () => [] });

		// Minimal fresh query mock: just end without yielding tool_use
		function emptyFreshFactory(params) {
			freshFactory.calls.push(params);
			async function* gen() {
				yield { type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: 1 } } } };
				// end without tool_use → finalizer pushes done:stop
			}
			return {
				[Symbol.asyncIterator]: gen,
				async interrupt() {},
				close() {},
			};
		}
		emptyFreshFactory.calls = freshFactory.calls; // share the calls array
		restoreFactory = __setQueryFactoryForTests(emptyFreshFactory);

		const stream = streamClaudeAgentSdk(MOCK_MODEL, ctx({ tools: [] }));
		const result = await stream.result();

		// Should NOT go to capture path: no outputFormat on the factory call
		assert.ok(emptyFreshFactory.calls.length > 0, "Factory should be called for fresh query");
		const call = emptyFreshFactory.calls[0];
		assert.ok(!call.options?.outputFormat, "Fresh query should NOT have outputFormat set");
		// Result is stop (no tool_use in mock)
		assert.equal(result.stopReason, "stop");
	});

	// ── 3.6 All-registered tools → falls through (fresh query, not capture) ──

	it("all-registered tools → falls through (no capture path)", async () => {
		restoreApi = __setPiApiRefForTests({ getActiveTools: () => ["regA", "regB"] });

		const calls = [];
		function trackingFactory(params) {
			calls.push(params);
			async function* gen() {
				yield { type: "stream_event", event: { type: "message_start", message: { usage: {} } } };
			}
			return {
				[Symbol.asyncIterator]: gen,
				async interrupt() {},
				close() {},
			};
		}
		trackingFactory.calls = calls;
		restoreFactory = __setQueryFactoryForTests(trackingFactory);

		const stream = streamClaudeAgentSdk(
			MOCK_MODEL,
			ctx({ tools: [objectTool("regA"), objectTool("regB")] }),
		);
		const result = await stream.result();

		assert.ok(calls.length > 0, "Factory should be called");
		assert.ok(!calls[0].options?.outputFormat, "All-registered path should not set outputFormat");
	});

	// ── 3.7 Tool-result delivery with non-empty ctx.tools: NOT classified ────

	it("tool-result delivery (lastMsg.role=toolResult, no active frame) → Case 2, not classified", async () => {
		// If classification ran on this call, it would reject (two capture tools).
		// But Case 2 (orphaned tool result) should fire BEFORE classification.
		restoreFactory = __setQueryFactoryForTests(makeBombFactory("tool-result-classified-erroneously"));
		restoreApi = __setPiApiRefForTests({ getActiveTools: () => [] });

		// Context where the LAST message is a toolResult — triggers Case 2 (no frame on stack)
		const contextWithToolResult = {
			systemPrompt: "test",
			messages: [
				{ role: "user", content: "do it", timestamp: Date.now() },
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "toolu_orphan", name: "capA", arguments: {} }],
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				{
					role: "toolResult",
					toolCallId: "toolu_orphan",
					toolName: "capA",
					content: [{ type: "text", text: "result" }],
					isError: false,
					timestamp: Date.now(),
				},
			],
			// Two capture tools — if classification ran, it would reject
			tools: [objectTool("capA"), objectTool("capB")],
		};

		const stream = streamClaudeAgentSdk(MOCK_MODEL, contextWithToolResult);
		const events = await collectEvents(stream);

		// Case 2 emits start + error(aborted), not rejected
		assert.equal(events.length, 2);
		assert.equal(events[0].type, "start");
		assert.equal(events[1].type, "error");
		// Reason must be "aborted" (Case 2 path), not "error" (rejection path)
		assert.equal(events[1].reason, "aborted", "Tool-result delivery should produce 'aborted', not 'error'");
		assert.match(events[1].error.errorMessage, /aborted/i);
		// errorMessage must NOT mention "capture-shape" or "limitation" (those come from classification)
		assert.ok(
			!events[1].error.errorMessage?.includes("limitation"),
			"Orphaned tool-result error should not mention capture limitation",
		);
	});

	// ── 3.8 piApiRef === null fallback → all tools treated as capture ─────────

	it("piApiRef === null → all tools treated as capture (object-root accepted)", async () => {
		const captureFactory = makeRecordingCaptureFactory();
		restoreFactory = __setQueryFactoryForTests(captureFactory);
		// Set piApiRef to null — getActiveToolNameSet() returns empty set
		restoreApi = __setPiApiRefForTests(null);

		const stream = streamClaudeAgentSdk(
			MOCK_MODEL,
			ctx({ tools: [objectTool("anyTool")], systemPrompt: "test" }),
		);
		const result = await stream.result();

		assert.equal(result.stopReason, "toolUse");
		assert.equal(captureFactory.calls.length, 1);
		assert.ok(captureFactory.calls[0].options?.outputFormat, "With null piApiRef, tool should be classified as capture");
	});
});
