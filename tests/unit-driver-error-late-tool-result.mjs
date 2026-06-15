#!/usr/bin/env node
// Layer 1 — a dead claude-p driver must never hang pi.
//
// THE BUG (continuation-note 2026-06-05): when claude-p errors/exits (crash,
// OOM, or any premature non-result exit) WHILE pi is mid-held-tool-call, pi
// hangs forever on a spinner. During a held tool call the bridge sets
// currentPiStream = null (pi owns the turn while executing the tool). The
// error was only surfaced when currentPiStream was non-null, and the
// tool-result delivery path's anti-hang guard (`willHangIfWired`) only checked
// `wasAborted` — not "the driver errored". So a tool-result delivered AFTER the
// driver died was wired into a dead frame whose driver will never generate the
// continuation → infinite spinner.
//
// THE FIX: `frame.driverErrored` is set in finalizeClaudePFrame's error branch
// and folded into `willHangIfWired`, so delivering a tool-result into a dead
// frame closes pi's stream with a terminal ERROR (not an abort, not a hang).
//
// This is the error-path analogue of unit-abort-partial.mjs's piId-routing test.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
	streamClaudeAgentSdk,
	__setPiApiRefForTests,
	__resetCachedSessionForTests,
	__setSpawnClaudePForTests,
} from "../index.js";
import { connectIpcClient } from "../src/mcp/ipc.js";
import { randomUUID } from "node:crypto";

const MOCK_MODEL = {
	id: "claude-haiku-4-5",
	cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

const READ_TOOL_CTX = {
	systemPrompt: "You are helpful.",
	tools: [{ name: "read", description: "read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
	messages: [{ role: "user", content: "read /tmp/x", timestamp: Date.now() }],
};

// Fake spawn that parks a real tools/call against the per-spawn router (so the
// frame gets a real pendingResolver), then leaves `done` pending. The test
// resolves `done` with stopReason "error" via `state.die()` to simulate claude-p
// dying mid-held-tool. The router's parked call is NOT resolved by the spawn —
// only a later pi tool-result delivery (Case 1) can resolve it.
function makeParkThenDieSpawn() {
	const state = { resolveDone: null, sessionId: null, parked: null };
	const parkedReached = new Promise((res) => { state.parked = res; });
	function fakeSpawn(cfg /*, opts, policy */) {
		state.sessionId = cfg.session.sessionId;
		const done = new Promise((res) => { state.resolveDone = res; });
		const mcp = JSON.parse(cfg.mcpConfig);
		const server = mcp.mcpServers["custom-tools"];
		const socketPath = server.args[server.args.indexOf("--socket") + 1];
		(async () => {
			const client = await connectIpcClient(socketPath);
			// Send a tools/call as the shim would; the router parks it + fires
			// onPark → onRouterPark pushes the pi toolCall block and ends turn 1.
			void client.request({ kind: "tools/call", id: randomUUID(), name: "mcp__custom-tools__read", arguments: { path: "/tmp/x" } });
			state.parked();
		})();
		return {
			pid: 9,
			abort() { state.resolveDone?.({ stopReason: "aborted", sessionId: cfg.session.sessionId, exitCode: null, signal: null }); },
			done,
		};
	}
	return { fakeSpawn, state, parkedReached };
}

describe("Layer 1 — driver error mid-held-tool surfaces an error, never hangs", () => {
	let restore = [];
	afterEach(() => { restore.forEach((r) => r()); restore = []; __resetCachedSessionForTests(); });

	it("a tool-result delivered after claude-p died closes pi's stream with a terminal error", async () => {
		restore.push(__setPiApiRefForTests({ getActiveTools: () => ["read"] }));
		const { fakeSpawn, state, parkedReached } = makeParkThenDieSpawn();
		restore.push(__setSpawnClaudePForTests(fakeSpawn));

		// ── Turn 1: fresh turn parks the tools/call; stream ends with done(toolUse).
		const stream1 = streamClaudeAgentSdk(MOCK_MODEL, READ_TOOL_CTX, {});
		const events1 = [];
		for await (const e of stream1) events1.push(e);

		const terminal1 = events1[events1.length - 1];
		assert.equal(terminal1.reason, "toolUse", "turn 1 ends in toolUse (the held-tool round-trip)");
		const piId = events1.find((e) => e.type === "toolcall_end")?.toolCall?.id;
		assert.ok(piId?.startsWith("pi-"), `expected a router-minted piId; got "${piId}"`);

		// Ensure the call is actually parked (pendingResolver exists) before "death".
		await parkedReached;

		// ── claude-p dies mid-held-tool: done resolves with stopReason "error" while
		// currentPiStream is null (pi is "executing" the held tool). finalize sets
		// frame.driverErrored and retains the frame (it has a pending resolver).
		state.resolveDone({ stopReason: "error", sessionId: state.sessionId, exitCode: 2, signal: null });
		await new Promise((r) => setTimeout(r, 30)); // let finalize run

		// ── Turn 2: pi finishes the tool and delivers the result for piId. Before
		// the fix this wired into the dead frame and hung forever. Now Case 1's
		// willHangIfWired (driverErrored) closes the stream with a terminal error.
		const ctx2 = {
			...READ_TOOL_CTX,
			messages: [
				...READ_TOOL_CTX.messages,
				{ role: "assistant", content: [{ type: "toolCall", id: piId, name: "read", arguments: { path: "/tmp/x" } }], timestamp: Date.now() },
				{ role: "toolResult", toolCallId: piId, toolName: "read", content: "FILE CONTENTS", isError: false, timestamp: Date.now() },
			],
		};

		const stream2 = streamClaudeAgentSdk(MOCK_MODEL, ctx2, {});
		// The anti-hang guarantee: this drain MUST complete. A timeout means a hang.
		const events2 = await withTimeout(drainAll(stream2), 2000, "tool-result delivery into a dead frame hung (Layer 1 regression)");

		const terminal2 = events2[events2.length - 1];
		assert.equal(terminal2.type, "error", "delivery into a dead frame yields a terminal error event");
		assert.equal(terminal2.reason, "error", "reason is error (driver died), not aborted");
		const msg = terminal2.error ?? terminal2.message;
		assert.equal(msg.stopReason, "error");
		assert.match(msg.errorMessage ?? "", /claude-p driver exited/i, "error message names the driver exit");
	});
});

async function drainAll(stream) {
	const ev = [];
	for await (const e of stream) ev.push(e);
	return ev;
}

function withTimeout(promise, ms, message) {
	return Promise.race([
		promise,
		new Promise((_, rej) => setTimeout(() => rej(new Error(message)), ms).unref?.()),
	]);
}
