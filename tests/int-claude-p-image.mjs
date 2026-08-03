#!/usr/bin/env node
// T1.16b — Image content handling in v1 (claude-p driver).
//
// Spec "Image content handling in v1":
//   - MAIN-provider path with image content → the bridge STRIPS the image blocks,
//     WARN-logs the drop, and proceeds TEXT-ONLY (claude-p cannot inject images).
//     The turn still spawns and runs.
//   - CAPTURE path with image content → the bridge WARN-logs and strips image
//     blocks, then proceeds under the documented lossy text-only replay contract.
//
// Tested via the driver/capture seams with a MOCKED spawn (no real claude-p):
//   - main path  → __setSpawnClaudePForTests (resilience-wrapper factory). We
//     assert the spawn WAS called, the cfg it received carries NO image data
//     (text-only prompt/systemPrompt), and the drop is warn-logged.
//   - capture path → __setCaptureSpawnForTests. We assert the text-only spawn
//     runs, receives no image bytes, stashes valid arguments, and completes.
//
// Deterministic, no subprocess. Concurrency 1 (single test file). Does NOT
// override CLAUDE_CONFIG_DIR / HOME.

import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Type } from "@sinclair/typebox";
import { connectIpcClient } from "../src/mcp/ipc.js";

// ── Route the bridge debug log to a temp file BEFORE importing index ──────────
// (lets us assert the image-strip WARN was emitted on the main path).
const LOG_DIR = mkdtempSync(join(tmpdir(), "bridge-img-"));
const LOG_PATH = join(LOG_DIR, "bridge.log");
process.env.CLAUDE_BRIDGE_DEBUG_PATH = LOG_PATH;
process.env.CLAUDE_BRIDGE_DEBUG = "1";

const {
	streamClaudeAgentSdk,
	__setPiApiRefForTests,
	__setSpawnClaudePForTests,
	__setCaptureSpawnForTests,
	__resetCachedSessionForTests,
} = await import("../index.js");

const ts = () => Date.now();
const MODEL = { id: "claude-haiku-4-5", cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } };

// A 1x1 PNG-ish base64 blob (content irrelevant; just must be present).
const IMG_B64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** A pi user message carrying a text block + an image block (pi content shape). */
function imageUserMessage(text = "describe this image") {
	return {
		role: "user",
		content: [
			{ type: "text", text },
			{ type: "image", data: IMG_B64, mimeType: "image/png" },
		],
		timestamp: ts(),
	};
}

/** Read the full debug log written so far. */
function readLog() {
	try {
		return readFileSync(LOG_PATH, "utf-8");
	} catch {
		return "";
	}
}

/**
 * Poll the debug log until `re` appears (pino + rotating-file-stream flush
 * asynchronously). Returns the log text once matched, or the last text after the
 * timeout (the caller's assertion then reports the miss).
 */
async function waitForLog(re, timeoutMs = 3000) {
	const deadline = Date.now() + timeoutMs;
	let log = readLog();
	while (!re.test(log) && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 50));
		log = readLog();
	}
	return log;
}

/** True if any base64 image-data substring leaked into the given string. */
function carriesImageData(s) {
	return typeof s === "string" && s.includes(IMG_B64);
}

let restore = [];
afterEach(() => {
	restore.forEach((r) => r());
	restore = [];
	__resetCachedSessionForTests();
});

before(() => {
	// Pi api ref present with no active tools — so a capture-shaped tool is
	// classified as a capture tool (unregistered), and a no-tool turn is a normal
	// main-provider turn.
});

// ────────────────────────────────────────────────────────────────────────────
// MAIN PATH — strips images, warn-logs, proceeds text-only
// ────────────────────────────────────────────────────────────────────────────

describe("T1.16b — main-provider path with image content (claude-p)", () => {
	it("strips image blocks, warn-logs the drop, and STILL spawns text-only", async () => {
		restore.push(__setPiApiRefForTests({ getActiveTools: () => [] }));

		let seenCfg = null;
		let spawnCount = 0;
		// Fake resilience-wrapper spawn: records the cfg, emits a clean result.
		restore.push(
			__setSpawnClaudePForTests((cfg, opts /*, policy */) => {
				spawnCount++;
				seenCfg = cfg;
				let resolveDone;
				const done = new Promise((res) => { resolveDone = res; });
				queueMicrotask(() => {
					opts.onEvent({ kind: "usage", usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10 } });
					opts.onEvent({ kind: "text-delta", text: "ok" });
					opts.onEvent({ kind: "done", reason: "result" });
					resolveDone({ stopReason: "result", sessionId: cfg.session.sessionId, exitCode: 0, signal: null });
				});
				return { pid: 4321, abort() {}, done };
			}),
		);

		const stream = streamClaudeAgentSdk(MODEL, {
			systemPrompt: "You are helpful.",
			messages: [imageUserMessage("what is in this picture?")],
			tools: [],
		});
		const events = [];
		for await (const ev of stream) events.push(ev);
		const result = await stream.result();

		// Proceeds text-only: the turn ran (a spawn happened) and ended cleanly.
		assert.equal(spawnCount, 1, "main path must STILL spawn after stripping images");
		assert.notEqual(result.stopReason, "error", `main path should proceed, got ${result.stopReason}`);

		// The cfg handed to the driver carries NO image data anywhere — prompt is a
		// text positional (or text file), systemPrompt is text, and the raw cfg JSON
		// contains no base64 image blob.
		assert.ok(seenCfg, "spawn received a cfg");
		const promptText = seenCfg.prompt.kind === "positional" ? seenCfg.prompt.text : "";
		assert.ok(!carriesImageData(promptText), "prompt text must not carry image data");
		assert.ok(!carriesImageData(JSON.stringify(seenCfg)), "no image data may leak into the spawn cfg (text-only)");
		// The user's text DID survive (text-only, not empty).
		if (seenCfg.prompt.kind === "positional") {
			assert.match(seenCfg.prompt.text, /picture/i, "text content must survive the image strip");
		}

		// Warn-logged the drop (image-strip-on-main-path marker). pino flushes
		// asynchronously, so poll the log file briefly for the marker.
		const log = await waitForLog(/image-strip-on-main-path/);
		assert.match(log, /image-strip-on-main-path/, "expected the main-path image-strip warning in the debug log");
		assert.match(log, /dropping 1 image block/i, "warning should report the dropped image count");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// CAPTURE PATH — warns, strips images, and proceeds text-only
// ────────────────────────────────────────────────────────────────────────────

describe("T1.16b — capture path with image content (claude-p)", () => {
	const captureTool = {
		name: "submit_thing",
		description: "submit a structured thing",
		parameters: Type.Object({ summary: Type.String() }),
	};

	it("warns, strips image bytes, and completes through the text-only capture spawn", async () => {
		restore.push(__setPiApiRefForTests({ getActiveTools: () => [] })); // tool is unregistered → capture

		let seenCfg = null;
		restore.push(__setCaptureSpawnForTests((cfg, spawnOpts) => {
			seenCfg = cfg;
			let resolveDone;
			const done = new Promise((resolve) => { resolveDone = resolve; });
			queueMicrotask(async () => {
				const parsed = JSON.parse(cfg.mcpConfig);
				const server = Object.values(parsed.mcpServers)[0];
				const socketPath = server.args[server.args.indexOf("--socket") + 1];
				const client = await connectIpcClient(socketPath);
				await client.request({
					kind: "capture-stash",
					id: randomUUID(),
					arguments: { summary: "text-only image summary" },
				});
				client.close();
				spawnOpts.onEvent({ kind: "usage", usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10 } });
				spawnOpts.onEvent({ kind: "done", reason: "result" });
				resolveDone({ stopReason: "result", sessionId: cfg.session.sessionId, exitCode: 0, signal: null });
			});
			return { pid: 4322, abort() {}, done };
		}));

		const stream = streamClaudeAgentSdk(MODEL, {
			systemPrompt: "Summarize.",
			messages: [imageUserMessage("summarize this screenshot")],
			tools: [captureTool],
		});
		const kinds = [];
		for await (const ev of stream) kinds.push(ev.type);
		const result = await stream.result();

		assert.equal(result.stopReason, "toolUse");
		assert.deepEqual(kinds, ["start", "done"]);
		assert.ok(seenCfg, "capture path must spawn after stripping images");
		assert.ok(!carriesImageData(JSON.stringify(seenCfg)), "capture spawn config must not carry image bytes");
		const log = await waitForLog(/capture: dropping 1 image block/);
		assert.match(log, /capture: dropping 1 image block/i);
		assert.match(log, /text-only/i);
	});
});
