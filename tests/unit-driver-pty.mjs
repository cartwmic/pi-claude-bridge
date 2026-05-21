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
		// Positional prompt is last
		assert.equal(args[args.length - 1], "hi");
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

	it("switches to --system-prompt-file for large prompts (>50KB)", async () => {
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
		assert.ok(args.includes("--system-prompt-file"));
		assert.ok(!args.includes("--system-prompt"));
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
