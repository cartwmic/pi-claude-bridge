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
		const result = classifyToolsForCapture(ctxWith(tools), new Set(["regA", "regB"]), "AskClaude");
		assert.deepEqual(result.executable.map((t) => t.name), ["regA", "regB"]);
		assert.deepEqual(result.capture, []);
	});

	it("no tools in activeNames → all capture", () => {
		const tools = [objectTool("capA"), objectTool("capB")];
		const result = classifyToolsForCapture(ctxWith(tools), new Set([]), "AskClaude");
		assert.deepEqual(result.executable, []);
		assert.deepEqual(result.capture.map((t) => t.name), ["capA", "capB"]);
	});

	it("mixed: some in activeNames → split correctly", () => {
		const tools = [objectTool("regA"), objectTool("capB")];
		const result = classifyToolsForCapture(ctxWith(tools), new Set(["regA"]), "AskClaude");
		assert.deepEqual(result.executable.map((t) => t.name), ["regA"]);
		assert.deepEqual(result.capture.map((t) => t.name), ["capB"]);
	});

	it("excludeName is skipped entirely", () => {
		const tools = [objectTool("AskClaude"), objectTool("capA")];
		const result = classifyToolsForCapture(ctxWith(tools), new Set([]), "AskClaude");
		// AskClaude should be excluded from both arrays
		const allNames = [...result.executable.map((t) => t.name), ...result.capture.map((t) => t.name)];
		assert.ok(!allNames.includes("AskClaude"), "AskClaude should be excluded");
		assert.deepEqual(result.capture.map((t) => t.name), ["capA"]);
	});

	it("empty ctx.tools → both arrays empty", () => {
		const result = classifyToolsForCapture({ tools: [], messages: [], systemPrompt: "" }, new Set(["x"]), "AskClaude");
		assert.deepEqual(result.executable, []);
		assert.deepEqual(result.capture, []);
	});

	it("undefined ctx.tools → both arrays empty", () => {
		const result = classifyToolsForCapture({ messages: [], systemPrompt: "" }, new Set(["x"]), "AskClaude");
		assert.deepEqual(result.executable, []);
		assert.deepEqual(result.capture, []);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// NOTE: Section 3 (streamClaudeAgentSdk end-to-end shape gate) and its helper
// factories were removed in v1.0.0 Phase 3 (task 3.2) along with the SDK path.
// The end-to-end shape gate is now exercised by the PTY integration tests
// (tests/int-pty-capture-*.mjs). The pure-function tests above (sections 1 and
// 2) still cover validateCaptureCallShape and classifyToolsForCapture.
// ────────────────────────────────────────────────────────────────────────────
