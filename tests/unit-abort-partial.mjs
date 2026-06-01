#!/usr/bin/env node
// T1.14a — partial-preservation on abort, for BOTH drivers.
//
// On abort/finalize the bridge MUST commit the streamed partial (text + any
// prior tool_use blocks) into the aborted AssistantMessage rather than handing
// pi a fresh empty message, so the abandoned prefix survives into pi history
// for next-turn cold-replay (S7/S13 coherence). When no text block was
// streamed, a synthetic "[interrupted]" text block is appended.
//
// We also assert the NORMAL (non-abort) SDK terminal event KIND/REASON is
// unchanged (no regression from the T1.14a edit).

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
	streamClaudeAgentSdk,
	__setQueryFactoryForTests,
	__setPiApiRefForTests,
	__resetCachedSessionForTests,
	__setDriverForTests,
	__setSpawnClaudePForTests,
} from "../index.js";
import { connectIpcClient } from "../src/mcp/ipc.js";
import { randomUUID } from "node:crypto";

const MOCK_MODEL = {
	id: "claude-haiku-4-5",
	cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

function userCtx(text = "count to ten please") {
	return {
		systemPrompt: "You are helpful.",
		tools: [],
		messages: [{ role: "user", content: text, timestamp: Date.now() }],
	};
}

async function collectEvents(stream) {
	const events = [];
	for await (const evt of stream) events.push(evt);
	return events;
}

// ── SDK path: a controllable factory that streams text then blocks until abort ──
//
// gen() yields message_start + a text block with deltas, then awaits a gate.
// interrupt() opens the gate so the generator can observe `done` and return —
// mirroring how query.interrupt() unblocks the SDK consumer loop.
function makeBlockingTextFactory(textChunks) {
	let openGate;
	const gate = new Promise((res) => { openGate = res; });
	let done = false;
	function factory(params) {
		async function* gen() {
			yield { type: "system", subtype: "init", session_id: "sess-abort-1" };
			yield { type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: 5 } } } };
			yield { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } };
			for (const c of textChunks) {
				if (done) return;
				yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: c } } };
			}
			await gate; // block here until interrupt()/abort opens the gate
			return;
		}
		return {
			[Symbol.asyncIterator]: gen,
			async interrupt() { done = true; openGate(); },
			close() { done = true; openGate(); },
		};
	}
	return factory;
}

// A factory that opens NO content block at all before blocking (abort lands
// before any block is started → turnBlocks has no text block).
function makeBlockingNoBlockFactory() {
	let openGate;
	const gate = new Promise((res) => { openGate = res; });
	let done = false;
	function factory() {
		async function* gen() {
			yield { type: "system", subtype: "init", session_id: "sess-abort-2" };
			yield { type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: 5 } } } };
			await gate;
			return;
		}
		return {
			[Symbol.asyncIterator]: gen,
			async interrupt() { done = true; openGate(); },
			close() { done = true; openGate(); },
		};
	}
	void done;
	return factory;
}

// A factory that streams text then ends cleanly (normal turn, no abort).
function makeCleanTextFactory(text) {
	function factory() {
		async function* gen() {
			yield { type: "system", subtype: "init", session_id: "sess-clean-1" };
			yield { type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: 5 } } } };
			yield { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } };
			yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } };
			yield { type: "stream_event", event: { type: "content_block_stop", index: 0 } };
			yield { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } } };
			yield { type: "stream_event", event: { type: "message_stop" } };
			yield { type: "result", subtype: "success", usage: { input_tokens: 5, output_tokens: 3 } };
		}
		return { [Symbol.asyncIterator]: gen, async interrupt() {}, close() {} };
	}
	return factory;
}

describe("T1.14a — SDK path: mid-stream abort preserves partial text", () => {
	let restore = [];
	afterEach(() => { restore.forEach((r) => r()); restore = []; __resetCachedSessionForTests(); });

	it("aborting mid-text → aborted message contains the streamed partial", async () => {
		restore.push(__setPiApiRefForTests({ getActiveTools: () => [] }));
		restore.push(__setQueryFactoryForTests(makeBlockingTextFactory(["1, ", "2, ", "3"])));
		const ac = new AbortController();
		const stream = streamClaudeAgentSdk(MOCK_MODEL, userCtx(), { signal: ac.signal });

		const events = [];
		// Drain in the background; abort once we've seen some text deltas.
		const drain = (async () => { for await (const e of stream) events.push(e); })();
		await new Promise((res) => setTimeout(res, 80));
		ac.abort();
		await drain;

		const terminal = events[events.length - 1];
		assert.equal(terminal.reason, "aborted", "terminal event reason is aborted");
		const msg = terminal.error ?? terminal.message;
		assert.equal(msg.stopReason, "aborted");
		const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
		assert.ok(text.includes("1, "), `partial text must survive; got "${text}"`);
	});
});

describe("T1.14a — SDK path: abort with NO streamed text → synthetic [interrupted]", () => {
	let restore = [];
	afterEach(() => { restore.forEach((r) => r()); restore = []; __resetCachedSessionForTests(); });

	it("aborting before any text → aborted message has a [interrupted] text block", async () => {
		restore.push(__setPiApiRefForTests({ getActiveTools: () => [] }));
		// No content block opened at all before the abort lands.
		restore.push(__setQueryFactoryForTests(makeBlockingNoBlockFactory()));
		const ac = new AbortController();
		const stream = streamClaudeAgentSdk(MOCK_MODEL, userCtx(), { signal: ac.signal });
		const events = [];
		const drain = (async () => { for await (const e of stream) events.push(e); })();
		await new Promise((res) => setTimeout(res, 60));
		ac.abort();
		await drain;

		const terminal = events[events.length - 1];
		assert.equal(terminal.reason, "aborted");
		const msg = terminal.error ?? terminal.message;
		const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
		assert.ok(text.includes("[interrupted]"), `expected synthetic [interrupted]; got "${text}"`);
	});
});

describe("T1.14a — SDK path: normal turn terminal event is unchanged", () => {
	let restore = [];
	afterEach(() => { restore.forEach((r) => r()); restore = []; __resetCachedSessionForTests(); });

	it("clean turn emits done(stop) with the streamed text (no regression)", async () => {
		restore.push(__setPiApiRefForTests({ getActiveTools: () => [] }));
		restore.push(__setQueryFactoryForTests(makeCleanTextFactory("hello world")));
		const stream = streamClaudeAgentSdk(MOCK_MODEL, userCtx());
		const events = await collectEvents(stream);
		const terminal = events[events.length - 1];
		assert.equal(terminal.type, "done", "normal turn terminal KIND is done");
		assert.equal(terminal.reason, "stop", "normal turn terminal REASON is stop");
		assert.equal(terminal.message.stopReason, "stop");
		const text = terminal.message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
		assert.equal(text, "hello world");
	});
});

// ── claude-p path: mock spawn seam ────────────────────────────────────────────
//
// __setSpawnClaudePForTests injects a fake spawnClaudePWithResilience. The fake
// drives processDriverEvent via opts.onEvent (text deltas), then leaves `done`
// pending so we can abort the live frame. handle.abort() forwards to the same
// resolver path the real driver uses (resolve done with stopReason "aborted").
function makeFakeClaudePSpawn(textChunks) {
	return function fakeSpawn(cfg, opts /*, policy */) {
		let resolveDone;
		const done = new Promise((res) => { resolveDone = res; });
		// Stream text deltas synchronously on next tick so the frame's stream is wired.
		queueMicrotask(() => {
			opts.onEvent({ kind: "usage", usage: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 5 } });
			for (const c of textChunks) opts.onEvent({ kind: "text-delta", text: c });
		});
		return {
			pid: 4242,
			abort() { resolveDone({ stopReason: "aborted", sessionId: cfg.session.sessionId, exitCode: null, signal: null }); },
			done,
		};
	};
}

describe("T1.14a — claude-p path: mid-stream abort preserves partial text", () => {
	let restore = [];
	afterEach(() => { restore.forEach((r) => r()); restore = []; __resetCachedSessionForTests(); });

	it("aborting mid-text on the claude-p driver commits the streamed partial", async () => {
		restore.push(__setPiApiRefForTests({ getActiveTools: () => [] }));
		restore.push(__setDriverForTests("claude-p"));
		restore.push(__setSpawnClaudePForTests(makeFakeClaudePSpawn(["alpha ", "beta ", "gamma"])));

		const ac = new AbortController();
		const stream = streamClaudeAgentSdk(MOCK_MODEL, userCtx(), { signal: ac.signal });
		const events = [];
		const drain = (async () => { for await (const e of stream) events.push(e); })();
		await new Promise((res) => setTimeout(res, 80));
		ac.abort();
		await drain;

		const terminal = events[events.length - 1];
		assert.equal(terminal.reason, "aborted", "claude-p abort terminal reason is aborted");
		const msg = terminal.error ?? terminal.message;
		assert.equal(msg.stopReason, "aborted");
		const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
		assert.ok(text.includes("alpha "), `claude-p partial text must survive; got "${text}"`);
	});
});

// ── piId routing invariant (the most-important wiring assertion) ──────────────
//
// The pi toolCall block emitted by onRouterPark MUST be keyed by the
// router-minted piId (the id pi echoes back as toolResult.id), NOT the model
// toolu_… id. Here the fake spawn connects to the REAL per-spawn router (socket
// path read out of cfg.mcpConfig) and sends a real `tools/call`. We then assert:
//   (a) the pi toolCall block id === the router's parked piId (read off the
//       toolcall_end event), and
//   (b) delivering a pi toolResult whose id === that piId (a second
//       streamSimple Case-1 call) resolves the parked MCP call.
function makeRouterDrivingSpawn() {
	let onParked; // resolves with the parked piId once the router parks our call
	const parkedPiId = new Promise((res) => { onParked = res; });
	let toolResponse; // resolves with the router's tools/call response (proves Case 1)
	const responded = new Promise((res) => { toolResponse = res; });
	function fakeSpawn(cfg, opts /*, policy */) {
		let resolveDone;
		const done = new Promise((res) => { resolveDone = res; });
		// Read the router socket path out of the shim args in cfg.mcpConfig.
		const mcp = JSON.parse(cfg.mcpConfig);
		const server = mcp.mcpServers["custom-tools"];
		const socketIdx = server.args.indexOf("--socket");
		const socketPath = server.args[socketIdx + 1];
		(async () => {
			const client = await connectIpcClient(socketPath);
			// Send a tools/call as the shim would. The router parks it and fires
			// onPark (→ onRouterPark pushes the pi toolCall block + ends stream).
			const resPromise = client.request({ kind: "tools/call", id: randomUUID(), name: "mcp__custom-tools__read", arguments: { path: "/tmp/x" } });
			void resPromise.then((r) => { toolResponse(r); resolveDone({ stopReason: "result", sessionId: cfg.session.sessionId, exitCode: 0, signal: null }); });
		})();
		return { pid: 7, abort() { resolveDone({ stopReason: "aborted", sessionId: cfg.session.sessionId, exitCode: null, signal: null }); }, done };
	}
	return { fakeSpawn, parkedPiId, responded };
}

describe("T1.9 — piId routing invariant: toolResult.id === piId resolves the parked call", () => {
	let restore = [];
	afterEach(() => { restore.forEach((r) => r()); restore = []; __resetCachedSessionForTests(); });

	it("pi toolCall block is keyed by the router-minted piId, and that id resolves the park", async () => {
		// Active tool `read` so it is treated as executable (not capture).
		restore.push(__setPiApiRefForTests({ getActiveTools: () => ["read"] }));
		restore.push(__setDriverForTests("claude-p"));
		const { fakeSpawn, responded } = makeRouterDrivingSpawn();
		restore.push(__setSpawnClaudePForTests(fakeSpawn));

		const ctx = {
			systemPrompt: "You are helpful.",
			tools: [{ name: "read", description: "read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
			messages: [{ role: "user", content: "read /tmp/x", timestamp: Date.now() }],
		};

		// Turn 1: fresh turn. Drain its stream; the router parks the tools/call and
		// onRouterPark pushes a toolCall block then ends the stream with done(toolUse).
		const stream1 = streamClaudeAgentSdk(MOCK_MODEL, ctx, {});
		const events1 = [];
		for await (const e of stream1) events1.push(e);

		const terminal1 = events1[events1.length - 1];
		assert.equal(terminal1.type, "done");
		assert.equal(terminal1.reason, "toolUse", "turn-1 ends in toolUse (round-trip trigger)");
		const tcEnd = events1.find((e) => e.type === "toolcall_end");
		assert.ok(tcEnd, "a toolcall_end event was emitted");
		const piId = tcEnd.toolCall.id;
		assert.ok(piId && piId.startsWith("pi-"), `toolCall id must be the router-minted piId (pi-…); got "${piId}"`);

		// Turn 2: deliver pi's toolResult keyed by that piId → Case 1 delivery path.
		const ctx2 = {
			...ctx,
			messages: [
				...ctx.messages,
				{ role: "assistant", content: [{ type: "toolCall", id: piId, name: "read", arguments: { path: "/tmp/x" } }], timestamp: Date.now() },
				{ role: "toolResult", toolCallId: piId, toolName: "read", content: "FILE CONTENTS", isError: false, timestamp: Date.now() },
			],
		};
		const stream2 = streamClaudeAgentSdk(MOCK_MODEL, ctx2, {});
		const drain2 = (async () => { const ev = []; for await (const e of stream2) ev.push(e); return ev; })();

		// The router's parked tools/call must now resolve with pi's real content.
		const routerResponse = await responded;
		assert.equal(routerResponse.kind, "tools/call:response");
		assert.equal(routerResponse.content[0].text, "FILE CONTENTS", "delivering toolResult.id===piId resolved the parked call with pi's content");
		await drain2;
	});
});
