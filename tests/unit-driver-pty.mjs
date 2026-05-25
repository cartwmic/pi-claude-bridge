#!/usr/bin/env node
// Unit tests for src/driver/pty.ts spawn orchestrator (T1.4).
// Uses a mock node-pty spawn so tests don't require the real claude binary.
// Trust-scanner tests live in tests/unit-driver-trust-scanner.mjs.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { setPtySpawn, spawnDriver } from "../src/driver/pty.js";
import { ipcConnect } from "../src/mcp/ipc.js";

// --- Mock PTY -------------------------------------------------------------

let mockProcs = [];
function clearMockProcs() { mockProcs = []; }

function installMockPty() {
	setPtySpawn((file, args, opts) => {
		const proc = new EventEmitter();
		proc.pid = Math.floor(Math.random() * 100000);
		proc.writes = [];
		proc.killSignals = [];
		proc.write = (d) => proc.writes.push(d);
		proc.kill = (s) => { proc.killSignals.push(s); /* don't actually exit */ };
		proc.onData = (cb) => proc.on("data", cb);
		proc.onExit = (cb) => proc.on("exit", cb);
		proc.fakeData = (d) => proc.emit("data", d);
		proc.fakeExit = (exitCode, signal) => proc.emit("exit", { exitCode, signal });
		proc.spawnFile = file;
		proc.spawnArgs = args;
		proc.spawnOpts = opts;
		mockProcs.push(proc);
		return proc;
	});
}

// --- Helpers --------------------------------------------------------------

function makeTempCwd(prefix = "pty-test-") {
	return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function makeTranscriptDir(uuid, cwd) {
	const encoded = cwd.replaceAll("/", "-");
	const dir = join(homedir(), ".claude", "projects", encoded);
	mkdirSync(dir, { recursive: true });
	return { dir, transcriptPath: join(dir, uuid + ".jsonl") };
}

function makeEntry(o) { return JSON.stringify(o) + "\n"; }

// --- Tests ----------------------------------------------------------------

describe("spawnDriver — CLI argument assembly", () => {
	before(() => installMockPty());
	after(() => clearMockProcs());

	it("passes --session-id, --mcp-config, --settings, --setting-sources \"\", --strict-mcp-config, --permission-mode, --dangerously-skip-permissions", async () => {
		clearMockProcs();
		const cwd = makeTempCwd();
		const h = await spawnDriver({
			shimPath: "/abs/shim.js",
			model: "claude-sonnet-4-6",
			prompt: "hi",
			systemPrompt: "test",
			cwd,
			mode: "main",
			tools: [],
			autoAnswerTrustDialog: false,
		});
		const args = mockProcs[0].spawnArgs;
		assert.ok(args.includes("--session-id"));
		assert.ok(args.includes("--strict-mcp-config"));
		assert.ok(args.includes("--setting-sources"));
		assert.equal(args[args.indexOf("--setting-sources") + 1], "");
		assert.ok(args.includes("--permission-mode"));
		assert.ok(args.includes("--dangerously-skip-permissions"));
		assert.ok(args.includes("--mcp-config"));
		assert.ok(args.includes("--settings"));
		assert.ok(args.includes("--model"));
		assert.equal(args[args.indexOf("--model") + 1], "claude-sonnet-4-6");
		// D26: prompt is NOT passed as a positional arg — it is typed into the
		// TUI input post-`SessionStart`. Asserting absence guards the regression.
		assert.ok(!args.includes("hi"), "prompt must NOT appear as positional argv (D26)");
		// Last arg should be a flag-pair value, never the prompt body.
		assert.notEqual(args[args.length - 1], "hi");
		await h.router.close();
	});

	it("passes --resume + computes transcript path using resumeSessionId (D22)", async () => {
		clearMockProcs();
		const cwd = makeTempCwd();
		const fixedId = "11111111-2222-3333-4444-555555555555";
		const h = await spawnDriver({
			shimPath: "/abs/shim.js",
			model: "claude-sonnet-4-6",
			prompt: "hi",
			systemPrompt: "x",
			cwd,
			mode: "main",
			tools: [],
			resumeSessionId: fixedId,
			autoAnswerTrustDialog: false,
		});
		const args = mockProcs[0].spawnArgs;
		assert.ok(args.includes("--resume"));
		assert.equal(args[args.indexOf("--resume") + 1], fixedId);
		assert.ok(!args.includes("--session-id"));
		assert.equal(h.sessionId, fixedId);
		assert.ok(h.transcriptPath.endsWith(fixedId + ".jsonl"));
		await h.router.close();
	});

	it("D27: does NOT pass --system-prompt or --system-prompt-file at all (content goes in typed user message instead)", async () => {
		clearMockProcs();
		const cwd = makeTempCwd();
		const big = "x".repeat(60_000);
		const h = await spawnDriver({
			shimPath: "/abs/shim.js",
			model: "m",
			prompt: "hi",
			systemPrompt: big,
			cwd,
			mode: "main",
			tools: [],
			autoAnswerTrustDialog: false,
		});
		const args = mockProcs[0].spawnArgs;
		assert.ok(!args.includes("--system-prompt"), "--system-prompt must not be in argv (D27)");
		assert.ok(!args.includes("--system-prompt-file"), "--system-prompt-file must not be in argv (D27)");
		await h.router.close();
	});

	it("capture mode adds --disable-slash-commands (F4 mitigation)", async () => {
		clearMockProcs();
		const cwd = makeTempCwd();
		const h = await spawnDriver({
			shimPath: "/abs/shim.js",
			model: "m",
			prompt: "hi",
			systemPrompt: "verbatim",
			cwd,
			mode: "capture",
			tools: [{ name: "extractor", inputSchema: { type: "object" } }],
			capture: { toolName: "extractor", schema: { type: "object", required: ["x"] } },
			autoAnswerTrustDialog: false,
		});
		const args = mockProcs[0].spawnArgs;
		assert.ok(args.includes("--disable-slash-commands"));
		await h.router.close();
	});

	it("uses realpath(cwd) for transcript path", async () => {
		clearMockProcs();
		const cwd = makeTempCwd();
		const h = await spawnDriver({
			shimPath: "/abs/shim.js",
			model: "m",
			prompt: "hi",
			systemPrompt: "x",
			cwd,
			mode: "main",
			tools: [],
			autoAnswerTrustDialog: false,
		});
		// On macOS, /var/folders → /private/var/folders. The transcript path
		// should encode the REALPATH'd form.
		assert.ok(h.transcriptPath.includes(cwd.replaceAll("/", "-")));
		await h.router.close();
	});
});

describe("spawnDriver — transcript event projection", () => {
	before(() => installMockPty());
	after(() => clearMockProcs());

	it("emits transcript events via 'transcript' channel and 'done' on settle", async () => {
		clearMockProcs();
		const cwd = makeTempCwd();
		const h = await spawnDriver({
			shimPath: "/abs/shim.js",
			model: "m",
			prompt: "hi",
			systemPrompt: "x",
			cwd,
			mode: "main",
			tools: [],
			autoAnswerTrustDialog: false,
			settleMs: 50,
		});
		const transcriptEvents = [];
		const doneEvents = [];
		h.on("transcript", (e) => transcriptEvents.push(e));
		h.on("done", (e) => doneEvents.push(e));

		// Create transcript dir + file
		const { dir } = makeTranscriptDir(h.sessionId, realpathSync(cwd));
		const tp = h.transcriptPath;
		writeFileSync(tp, "");
		await new Promise((r) => setTimeout(r, 150));
		appendFileSync(tp, makeEntry({
			type: "assistant", uuid: "u1",
			message: { content: [{ type: "text", text: "hello" }], usage: { input_tokens: 1, output_tokens: 2 } },
		}));
		await new Promise((r) => setTimeout(r, 150));
		// Simulate Stop hook event arriving via the router (this triggers
		// tailer.stopSettle() in the driver, mirroring real behavior).
		const peer = await ipcConnect(h.router.socketPath);
		const hookFrames = [];
		peer.on("frame", (f) => hookFrames.push(f));
		peer.send({ kind: "hello", role: "hook" });
		peer.send({
			kind: "hook_event",
			id: "h1",
			event: "Stop",
			payload: { session_id: h.sessionId },
		});
		await new Promise((r) => setTimeout(r, 50));
		appendFileSync(tp, makeEntry({ type: "system", subtype: "stop_hook_summary" }));
		await new Promise((r) => setTimeout(r, 400));
		const text = transcriptEvents.find((e) => e.kind === "text-delta");
		assert.ok(text, `expected text-delta; got: ${transcriptEvents.map((e) => e.kind).join(",")}`);
		assert.equal(text.text, "hello");
		const done = doneEvents[0];
		assert.ok(done, `expected done; transcriptEvents=${transcriptEvents.map((e) => e.kind).join(",")}`);
		assert.equal(done.reason, "stop-settled");
		peer.destroy();
		await h.router.close();
	});
});

describe("spawnDriver — abort lifecycle (D15)", () => {
	before(() => installMockPty());
	after(() => clearMockProcs());

	it("abort() sends SIGINT then SIGKILL after grace; emits done(aborted)", async () => {
		clearMockProcs();
		const cwd = makeTempCwd();
		const h = await spawnDriver({
			shimPath: "/abs/shim.js",
			model: "m",
			prompt: "hi",
			systemPrompt: "x",
			cwd,
			mode: "main",
			tools: [],
			autoAnswerTrustDialog: false,
			abortGraceMs: 50,
			settleMs: 25,
		});
		const proc = mockProcs[0];
		const dones = [];
		h.on("done", (e) => dones.push(e));
		const abortPromise = h.abort();
		await new Promise((r) => setTimeout(r, 100));
		await abortPromise;
		assert.ok(proc.killSignals.includes("SIGINT"));
		assert.ok(proc.killSignals.includes("SIGKILL"));
		assert.equal(dones[0].reason, "aborted");
		assert.ok(h.router);
		await h.router.close().catch(() => {});
	});

	it("AbortSignal triggers abort()", async () => {
		clearMockProcs();
		const cwd = makeTempCwd();
		const ctrl = new AbortController();
		const h = await spawnDriver({
			shimPath: "/abs/shim.js",
			model: "m",
			prompt: "hi",
			systemPrompt: "x",
			cwd,
			mode: "main",
			tools: [],
			autoAnswerTrustDialog: false,
			abortGraceMs: 50,
			signal: ctrl.signal,
		});
		const dones = [];
		h.on("done", (e) => dones.push(e));
		ctrl.abort();
		await new Promise((r) => setTimeout(r, 150));
		assert.equal(dones[0]?.reason, "aborted");
		await h.router.close().catch(() => {});
	});
});

describe("spawnDriver — unexpected PTY exit error path", () => {
	before(() => installMockPty());
	after(() => clearMockProcs());

	it("PTY exit before Stop hook → done(error) within 500ms", async () => {
		clearMockProcs();
		const cwd = makeTempCwd();
		const h = await spawnDriver({
			shimPath: "/abs/shim.js",
			model: "m",
			prompt: "hi",
			systemPrompt: "x",
			cwd,
			mode: "main",
			tools: [],
			autoAnswerTrustDialog: false,
			settleMs: 25,
		});
		const dones = [];
		h.on("done", (e) => dones.push(e));
		mockProcs[0].fakeExit(1, "SIGABRT");
		await new Promise((r) => setTimeout(r, 700));
		assert.equal(dones[0].reason, "error");
		assert.match(dones[0].errorMessage, /exitCode=1/);
		await h.router.close();
	});
});

// ===========================================================================
// D26: InkQuiescenceTracker + typed-injection sequence (T5.5 + T5.6)
// ===========================================================================

import { InkQuiescenceTracker, typePromptWithDebounce } from "../src/driver/pty.js";

describe("InkQuiescenceTracker (D26)", () => {
	it("resolves 'quiescent' after silentMs has elapsed since last output", async () => {
		let clock = 1000;
		const sleeps = [];
		const tracker = new InkQuiescenceTracker({
			silentMs: 80,
			ceilingMs: 2000,
			pollMs: 15,
			now: () => clock,
			sleep: async (ms) => { sleeps.push(ms); clock += ms; },
		});
		// Simulate a burst of output ending at t=1000
		tracker.noteOutput();
		const outcome = await tracker.waitForQuiescent();
		assert.equal(outcome, "quiescent");
		// First poll: clock advances by 15ms (1015) — diff=15 < 80, keep waiting.
		// Continues until clock - lastOutput >= 80, i.e. after ~6 polls (90ms).
		assert.ok(sleeps.length >= 5, `expected >=5 polls, got ${sleeps.length}`);
	});

	it("resolves 'ceiling-hit' if output never stops within ceilingMs", async () => {
		let clock = 0;
		const tracker = new InkQuiescenceTracker({
			silentMs: 80,
			ceilingMs: 200,
			pollMs: 15,
			now: () => clock,
			sleep: async (ms) => {
				clock += ms;
				// Simulate continuous output: every poll, refresh lastOutput.
				tracker.noteOutput();
			},
		});
		tracker.noteOutput();
		const outcome = await tracker.waitForQuiescent();
		assert.equal(outcome, "ceiling-hit");
	});

	it("treats lastOutputAtMs==0 as 'no output yet' (does not insta-resolve)", async () => {
		let clock = 0;
		const sleeps = [];
		const tracker = new InkQuiescenceTracker({
			silentMs: 80,
			ceilingMs: 200,
			pollMs: 15,
			now: () => clock,
			sleep: async (ms) => { sleeps.push(ms); clock += ms; },
		});
		// Never call noteOutput.
		const outcome = await tracker.waitForQuiescent();
		// Should hit ceiling, not "quiescent at t=0".
		assert.equal(outcome, "ceiling-hit");
	});
});

describe("typePromptWithDebounce (D26)", () => {
	it("writes prompt, awaits debounce, then writes Enter", async () => {
		const writes = [];
		const sleepCalls = [];
		const proc = { write: (s) => writes.push({ s, t: Date.now() }) };
		const fakeSleep = async (ms) => { sleepCalls.push(ms); };
		await typePromptWithDebounce(proc, "hello world", 120, fakeSleep);
		assert.equal(writes.length, 2);
		assert.equal(writes[0].s, "hello world");
		assert.equal(writes[1].s, "\r");
		assert.deepEqual(sleepCalls, [120]);
	});

	it("uses default 500ms debounce when not specified", async () => {
		const writes = [];
		const sleepCalls = [];
		await typePromptWithDebounce(
			{ write: (s) => writes.push(s) },
			"x",
			undefined,
			async (ms) => { sleepCalls.push(ms); },
		);
		assert.deepEqual(sleepCalls, [500]);
		assert.deepEqual(writes, ["x", "\r"]);
	});

	it("writes order is strictly prompt before Enter (no interleaving)", async () => {
		const order = [];
		const proc = { write: (s) => order.push(s) };
		await typePromptWithDebounce(proc, "abc", 5, async (ms) => {
			// During the debounce window, no writes should have happened beyond
			// the first.
			assert.deepEqual(order, ["abc"]);
		});
		assert.deepEqual(order, ["abc", "\r"]);
	});
});

describe("spawnDriver — typed-injection on SessionStart (D26)", () => {
	before(() => installMockPty());
	after(() => clearMockProcs());

	it("does NOT type the prompt before SessionStart hook fires", async () => {
		clearMockProcs();
		const cwd = makeTempCwd();
		const h = await spawnDriver({
			shimPath: "/abs/shim.js",
			model: "claude-sonnet-4-6",
			prompt: "hello-D26",
			systemPrompt: "x",
			cwd,
			mode: "main",
			tools: [],
			autoAnswerTrustDialog: false,
			sessionStartWaitMs: 60_000, // don't trip the failsafe during test
		});
		// Give the spawn a moment to settle.
		await new Promise((r) => setTimeout(r, 50));
		const writes = mockProcs[0].writes;
		const wroteHello = writes.some((w) => typeof w === "string" && w.includes("hello-D26"));
		assert.ok(!wroteHello, "prompt must not be typed before SessionStart");
		await h.router.close();
	});
});

// ===========================================================================
// D27: composeBundledUserMessage (system prompt + user prompt → single typed message)
// ===========================================================================

import { composeBundledUserMessage } from "../src/driver/pty.js";

describe("composeBundledUserMessage (D27)", () => {
	it("wraps non-empty systemPrompt in <system_context> tags before userPrompt", () => {
		const out = composeBundledUserMessage("You are pi.", "What is 2+2?");
		assert.equal(out, "<system_context>\nYou are pi.\n</system_context>\n\nWhat is 2+2?");
	});

	it("returns userPrompt verbatim when systemPrompt is empty", () => {
		assert.equal(composeBundledUserMessage("", "hi"), "hi");
	});

	it("returns userPrompt verbatim when systemPrompt is whitespace only", () => {
		assert.equal(composeBundledUserMessage("   \n\t  ", "hi"), "hi");
	});

	it("preserves the exact systemPrompt content byte-for-byte (constitution V on capture path)", () => {
		const sp = "You are a verbatim system.\nLine 2.\n\tIndented.";
		const out = composeBundledUserMessage(sp, "ok");
		assert.ok(out.includes(sp), "system prompt must appear verbatim inside the wrapper");
	});

	it("preserves the exact userPrompt content byte-for-byte", () => {
		const up = "do thing\nwith newline\nand more";
		const out = composeBundledUserMessage("sp", up);
		assert.ok(out.endsWith(up), "user prompt must be the trailing segment");
	});
});
