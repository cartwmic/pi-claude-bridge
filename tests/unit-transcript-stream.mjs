#!/usr/bin/env node
// Unit tests for src/driver/transcript.ts (T1.5).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptTailer, computeTranscriptPath } from "../src/driver/transcript.js";

function makeTempDir() {
	return realpathSync(mkdtempSync(join(tmpdir(), "transcript-test-")));
}

function makeEntry(extra) {
	return JSON.stringify(extra) + "\n";
}

/**
 * Attach event collector to a tailer BEFORE start(). Returns
 * { events, waitFor(kind, timeoutMs) }. Required because the tailer can fire
 * events synchronously-ish during start() / first poll cycle, before any
 * later test code attaches handlers.
 */
function collectFromStart(tailer) {
	const events = [];
	tailer.on("event", (e) => events.push(e));
	return {
		events,
		waitFor(untilKind, timeoutMs = 5000) {
			return new Promise((resolve, reject) => {
				if (events.some((e) => e.kind === untilKind)) return resolve(events);
				const handler = (e) => {
					if (e.kind === untilKind) {
						tailer.off("event", handler);
						resolve(events);
					}
				};
				tailer.on("event", handler);
				setTimeout(() => {
					tailer.off("event", handler);
					reject(new Error(`timeout waiting for ${untilKind}; got ${events.map((e) => e.kind).join(",")}`));
				}, timeoutMs);
			});
		},
	};
}

describe("computeTranscriptPath", () => {
	it("encodes cwd '/' as '-' and joins home + uuid", () => {
		const p = computeTranscriptPath("/home/user", "/private/var/folders/x/foo", "abc-123");
		assert.equal(p, "/home/user/.claude/projects/-private-var-folders-x-foo/abc-123.jsonl");
	});
});

describe("TranscriptTailer — file creation flow", () => {
	it("emits done(stop-settled) after stopSettle() + settle window", async () => {
		const dir = makeTempDir();
		const path = join(dir, "tx.jsonl");
		writeFileSync(path, "");
		const tailer = new TranscriptTailer({ transcriptPath: path, settleMs: 50, pollIntervalMs: 25 });
		const col = collectFromStart(tailer);
		tailer.start();
		await new Promise((r) => setTimeout(r, 50));
		tailer.stopSettle();
		await col.waitFor("done");
		assert.equal(col.events[col.events.length - 1].kind, "done");
		assert.equal(col.events[col.events.length - 1].reason, "stop-settled");
	});

	it("emits error if transcript never appears within creationTimeoutMs", async () => {
		const dir = makeTempDir();
		const path = join(dir, "nonexistent.jsonl");
		const tailer = new TranscriptTailer({
			transcriptPath: path,
			creationTimeoutMs: 100,
			pollIntervalMs: 50,
		});
		const col = collectFromStart(tailer);
		tailer.start();
		await col.waitFor("error");
		assert.match(col.events[0].errorMessage, /did not appear/);
	});

	it("opens existing file (warm-resume scenario)", async () => {
		const dir = makeTempDir();
		const path = join(dir, "warm.jsonl");
		writeFileSync(path, makeEntry({
			type: "assistant",
			uuid: "u1",
			message: { content: [{ type: "text", text: "hello from warm" }], usage: { input_tokens: 1, output_tokens: 2 } },
		}));
		const tailer = new TranscriptTailer({ transcriptPath: path, settleMs: 100, pollIntervalMs: 25 });
		const col = collectFromStart(tailer);
		tailer.start();
		await new Promise((r) => setTimeout(r, 100));
		tailer.stopSettle();
		await col.waitFor("done");
		const text = col.events.find((e) => e.kind === "text-delta");
		assert.ok(text);
		assert.equal(text.text, "hello from warm");
	});
});

describe("TranscriptTailer — JSONL projection", () => {
	it("projects assistant text block to text-delta event", async () => {
		const dir = makeTempDir();
		const path = join(dir, "tx.jsonl");
		writeFileSync(path, "");
		const tailer = new TranscriptTailer({ transcriptPath: path, settleMs: 100, pollIntervalMs: 25 });
		const col = collectFromStart(tailer);
		tailer.start();
		await new Promise((r) => setTimeout(r, 50));
		appendFileSync(path, makeEntry({
			type: "assistant", uuid: "u1",
			message: { content: [{ type: "text", text: "Hello world" }] },
		}));
		await new Promise((r) => setTimeout(r, 100));
		tailer.stopSettle();
		await col.waitFor("done");
		const td = col.events.find((e) => e.kind === "text-delta");
		assert.ok(td);
		assert.equal(td.text, "Hello world");
		assert.equal(td.sourceUuid, "u1");
	});

	it("projects tool_use block with full input", async () => {
		const dir = makeTempDir();
		const path = join(dir, "tx.jsonl");
		writeFileSync(path, "");
		const tailer = new TranscriptTailer({ transcriptPath: path, settleMs: 100, pollIntervalMs: 25 });
		const col = collectFromStart(tailer);
		tailer.start();
		await new Promise((r) => setTimeout(r, 50));
		appendFileSync(path, makeEntry({
			type: "assistant", uuid: "u1",
			message: { content: [{
				type: "tool_use", id: "toolu_001", name: "mcp__custom-tools__bash",
				input: { command: "ls -la" },
			}] },
		}));
		await new Promise((r) => setTimeout(r, 100));
		tailer.stopSettle();
		await col.waitFor("done");
		const tu = col.events.find((e) => e.kind === "tool-use");
		assert.ok(tu);
		assert.equal(tu.toolUseId, "toolu_001");
		assert.equal(tu.name, "mcp__custom-tools__bash");
		assert.deepEqual(tu.input, { command: "ls -la" });
	});

	it("projects thinking block (T0.2)", async () => {
		const dir = makeTempDir();
		const path = join(dir, "tx.jsonl");
		writeFileSync(path, "");
		const tailer = new TranscriptTailer({ transcriptPath: path, settleMs: 100, pollIntervalMs: 25 });
		const col = collectFromStart(tailer);
		tailer.start();
		await new Promise((r) => setTimeout(r, 50));
		appendFileSync(path, makeEntry({
			type: "assistant", uuid: "u1",
			message: { content: [{ type: "thinking", thinking: "Let me reason...", signature: "sig123" }] },
		}));
		await new Promise((r) => setTimeout(r, 100));
		tailer.stopSettle();
		await col.waitFor("done");
		const th = col.events.find((e) => e.kind === "thinking-delta");
		assert.ok(th);
		assert.equal(th.text, "Let me reason...");
		assert.equal(th.signature, "sig123");
		assert.equal(th.redacted, false);
	});

	it("projects redacted_thinking block", async () => {
		const dir = makeTempDir();
		const path = join(dir, "tx.jsonl");
		writeFileSync(path, "");
		const tailer = new TranscriptTailer({ transcriptPath: path, settleMs: 100, pollIntervalMs: 25 });
		const col = collectFromStart(tailer);
		tailer.start();
		await new Promise((r) => setTimeout(r, 50));
		appendFileSync(path, makeEntry({
			type: "assistant", uuid: "u1",
			message: { content: [{ type: "redacted_thinking" }] },
		}));
		await new Promise((r) => setTimeout(r, 100));
		tailer.stopSettle();
		await col.waitFor("done");
		const th = col.events.find((e) => e.kind === "thinking-delta");
		assert.ok(th);
		assert.equal(th.redacted, true);
	});

	it("emits usage event from assistant.message.usage (T0.3)", async () => {
		const dir = makeTempDir();
		const path = join(dir, "tx.jsonl");
		writeFileSync(path, "");
		const tailer = new TranscriptTailer({ transcriptPath: path, settleMs: 100, pollIntervalMs: 25 });
		const col = collectFromStart(tailer);
		tailer.start();
		await new Promise((r) => setTimeout(r, 50));
		appendFileSync(path, makeEntry({
			type: "assistant", uuid: "u1",
			message: {
				model: "claude-opus-4-7",
				stop_reason: "end_turn",
				content: [{ type: "text", text: "x" }],
				usage: {
					input_tokens: 10,
					output_tokens: 20,
					cache_read_input_tokens: 100,
					cache_creation_input_tokens: 200,
					cache_creation: { ephemeral_1h_input_tokens: 50, ephemeral_5m_input_tokens: 150 },
				},
			},
		}));
		await new Promise((r) => setTimeout(r, 100));
		tailer.stopSettle();
		await col.waitFor("done");
		const usage = col.events.find((e) => e.kind === "usage");
		assert.ok(usage);
		assert.equal(usage.usage.input, 10);
		assert.equal(usage.usage.output, 20);
		assert.equal(usage.usage.cacheRead, 100);
		assert.equal(usage.usage.cacheWrite, 200);
		assert.equal(usage.usage.cacheCreate1h, 50);
		assert.equal(usage.usage.cacheCreate5m, 150);
		assert.equal(usage.model, "claude-opus-4-7");
		assert.equal(usage.stopReason, "end_turn");
	});
});

describe("TranscriptTailer — error / drift / partial handling", () => {
	it("warns on malformed JSONL line (not a stream error)", async () => {
		const dir = makeTempDir();
		const path = join(dir, "tx.jsonl");
		writeFileSync(path, "");
		const tailer = new TranscriptTailer({ transcriptPath: path, settleMs: 100, pollIntervalMs: 25 });
		const col = collectFromStart(tailer);
		tailer.start();
		await new Promise((r) => setTimeout(r, 50));
		appendFileSync(path, "{not valid json\n");
		appendFileSync(path, makeEntry({ type: "assistant", uuid: "u1", message: { content: [{ type: "text", text: "after" }] } }));
		await new Promise((r) => setTimeout(r, 100));
		tailer.stopSettle();
		await col.waitFor("done");
		const warn = col.events.find((e) => e.kind === "warn" && /malformed/.test(e.reason));
		assert.ok(warn, `expected warn for malformed line; got: ${col.events.map((e) => `${e.kind}:${e.reason || ""}`).join(", ")}`);
		const text = col.events.find((e) => e.kind === "text-delta");
		assert.ok(text, "expected text-delta after malformed line");
	});

	it("warns on unknown top-level type (drift detection)", async () => {
		const dir = makeTempDir();
		const path = join(dir, "tx.jsonl");
		writeFileSync(path, "");
		const tailer = new TranscriptTailer({ transcriptPath: path, settleMs: 100, pollIntervalMs: 25 });
		const col = collectFromStart(tailer);
		tailer.start();
		await new Promise((r) => setTimeout(r, 50));
		appendFileSync(path, makeEntry({ type: "session_id_rotated", sessionId: "new" }));
		appendFileSync(path, makeEntry({ type: "assistant", uuid: "u1", message: { content: [{ type: "text", text: "after" }] } }));
		await new Promise((r) => setTimeout(r, 100));
		tailer.stopSettle();
		await col.waitFor("done");
		const warn = col.events.find((e) => e.kind === "warn" && /session_id_rotated/.test(e.reason));
		assert.ok(warn);
		const text = col.events.find((e) => e.kind === "text-delta");
		assert.ok(text);
	});

	it("buffers partial lines until newline arrives", async () => {
		const dir = makeTempDir();
		const path = join(dir, "tx.jsonl");
		writeFileSync(path, "");
		const tailer = new TranscriptTailer({ transcriptPath: path, settleMs: 200, pollIntervalMs: 25 });
		const col = collectFromStart(tailer);
		tailer.start();
		await new Promise((r) => setTimeout(r, 50));
		const fullLine = JSON.stringify({ type: "assistant", uuid: "u1", message: { content: [{ type: "text", text: "partial" }] } });
		appendFileSync(path, fullLine.slice(0, 30));
		await new Promise((r) => setTimeout(r, 100));
		// no text-delta yet
		assert.ok(!col.events.some((e) => e.kind === "text-delta"), "should not emit text-delta until newline");
		appendFileSync(path, fullLine.slice(30) + "\n");
		await new Promise((r) => setTimeout(r, 100));
		tailer.stopSettle();
		await col.waitFor("done");
		const text = col.events.find((e) => e.kind === "text-delta");
		assert.ok(text);
		assert.equal(text.text, "partial");
	});

	it("closes early on system/stop_hook_summary terminal entry", async () => {
		const dir = makeTempDir();
		const path = join(dir, "tx.jsonl");
		writeFileSync(path, "");
		const tailer = new TranscriptTailer({ transcriptPath: path, settleMs: 5000, pollIntervalMs: 25 });
		const col = collectFromStart(tailer);
		tailer.start();
		await new Promise((r) => setTimeout(r, 50));
		appendFileSync(path, makeEntry({ type: "assistant", uuid: "u1", message: { content: [{ type: "text", text: "hi" }] } }));
		await new Promise((r) => setTimeout(r, 100));
		tailer.stopSettle();
		// Should NOT yet have done event (settleMs is 5000)
		await new Promise((r) => setTimeout(r, 100));
		assert.ok(!col.events.some((e) => e.kind === "done"));
		appendFileSync(path, makeEntry({ type: "system", subtype: "stop_hook_summary" }));
		const t0 = Date.now();
		await col.waitFor("done", 3000);
		const elapsed = Date.now() - t0;
		assert.ok(elapsed < 3000, `expected fast close on stop_hook_summary; elapsed ${elapsed}ms`);
		const text = col.events.find((e) => e.kind === "text-delta");
		assert.ok(text);
	});
});

describe("TranscriptTailer — abort()", () => {
	it("emits done(aborted) and closes", async () => {
		const dir = makeTempDir();
		const path = join(dir, "tx.jsonl");
		writeFileSync(path, "");
		const tailer = new TranscriptTailer({ transcriptPath: path, settleMs: 100, pollIntervalMs: 25 });
		const col = collectFromStart(tailer);
		tailer.start();
		await new Promise((r) => setTimeout(r, 50));
		tailer.abort();
		await new Promise((r) => setTimeout(r, 50));
		const done = col.events.find((e) => e.kind === "done");
		assert.ok(done);
		assert.equal(done.reason, "aborted");
		assert.equal(tailer.getState(), "closed");
	});
});
