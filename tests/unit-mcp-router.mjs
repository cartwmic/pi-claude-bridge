#!/usr/bin/env node
// Unit tests for src/mcp/router.ts (T1.8).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Router, generateCallId } from "../src/mcp/router.js";
import { generateSocketPath, ipcConnect } from "../src/mcp/ipc.js";

function makeRouter(mode = "main") {
	const socketPath = generateSocketPath("router-test");
	return new Router({ mode, tools: [{ name: "test_tool", inputSchema: { type: "object" } }], socketPath });
}

describe("Router — main mode", () => {
	it("parks tool_call, emits toolCall event, resolves on deliverToolResult", async () => {
		const router = makeRouter("main");
		await router.listen();
		const calls = [];
		router.on("toolCall", (e) => calls.push(e));

		const client = await ipcConnect(router.socketPath);
		const clientFrames = [];
		client.on("frame", (f) => clientFrames.push(f));
		client.send({ kind: "hello", role: "mcp", tools: [] });
		const id = generateCallId();
		client.send({ kind: "tool_call", id, name: "test_tool", arguments: { x: 1 } });

		await new Promise((r) => setTimeout(r, 50));
		assert.equal(calls.length, 1);
		assert.equal(calls[0].name, "test_tool");
		assert.deepEqual(calls[0].arguments, { x: 1 });
		assert.equal(router.pendingResolvers.size, 1);

		// Deliver result
		router.deliverToolResult(id, [{ type: "text", text: "result OK" }], false);
		await new Promise((r) => setTimeout(r, 25));
		assert.equal(clientFrames.length, 1);
		assert.equal(clientFrames[0].kind, "tool_result");
		assert.equal(clientFrames[0].content[0].text, "result OK");
		assert.equal(router.pendingResolvers.size, 0);

		await router.close();
	});

	it("deliverToolResult with no parked resolver stashes in pendingResults (D15 preservation)", async () => {
		const router = makeRouter("main");
		await router.listen();
		router.deliverToolResult("ghost-id", [{ type: "text", text: "late" }]);
		assert.equal(router.pendingResults.size, 1);
		assert.deepEqual(router.pendingResults.get("ghost-id"), [{ type: "text", text: "late" }]);
		await router.close();
	});

	it("drainPendingResolversSynthetic resolves all parked calls with text", async () => {
		const router = makeRouter("main");
		await router.listen();
		const client = await ipcConnect(router.socketPath);
		const frames = [];
		client.on("frame", (f) => frames.push(f));
		client.send({ kind: "hello", role: "mcp" });
		client.send({ kind: "tool_call", id: "a", name: "t", arguments: {} });
		client.send({ kind: "tool_call", id: "b", name: "t", arguments: {} });
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(router.pendingResolvers.size, 2);
		router.drainPendingResolversSynthetic("[aborted]");
		await new Promise((r) => setTimeout(r, 25));
		const drained = frames.filter((f) => f.kind === "tool_result");
		assert.equal(drained.length, 2);
		for (const f of drained) {
			assert.equal(f.content[0].text, "[aborted]");
		}
		assert.equal(router.pendingResolvers.size, 0);
		await router.close();
	});

	it("tool_call times out and resolves with error", async () => {
		const socketPath = generateSocketPath("router-test");
		const router = new Router({
			mode: "main",
			tools: [],
			socketPath,
			toolCallTimeoutMs: 50,
		});
		await router.listen();
		const client = await ipcConnect(router.socketPath);
		const frames = [];
		client.on("frame", (f) => frames.push(f));
		client.send({ kind: "hello", role: "mcp" });
		client.send({ kind: "tool_call", id: "z", name: "t", arguments: {} });
		await new Promise((r) => setTimeout(r, 150));
		const tr = frames.find((f) => f.kind === "tool_result");
		assert.ok(tr);
		assert.ok(tr.isError);
		assert.match(tr.content[0].text, /timeout/);
		await router.close();
	});
});

describe("Router — capture mode", () => {
	it("capture_stash stores args; first-call-wins; ack returned", async () => {
		const router = makeRouter("capture");
		await router.listen();
		const client = await ipcConnect(router.socketPath);
		const frames = [];
		client.on("frame", (f) => frames.push(f));
		client.send({ kind: "hello", role: "mcp" });
		client.send({ kind: "capture_stash", id: "1", args: { answer: 42 } });
		await new Promise((r) => setTimeout(r, 25));
		assert.deepEqual(router.capturedArgs, { answer: 42 });
		const ack = frames.find((f) => f.kind === "capture_stash_ack");
		assert.ok(ack);

		// Second call: first-call-wins
		client.send({ kind: "capture_stash", id: "2", args: { answer: 99 } });
		await new Promise((r) => setTimeout(r, 25));
		assert.deepEqual(router.capturedArgs, { answer: 42 }, "first call should win");

		await router.close();
	});

	it("rejects tool_call in capture mode (only capture_stash allowed)", async () => {
		const router = makeRouter("capture");
		await router.listen();
		const client = await ipcConnect(router.socketPath);
		const frames = [];
		client.on("frame", (f) => frames.push(f));
		client.send({ kind: "hello", role: "mcp" });
		client.send({ kind: "tool_call", id: "x", name: "anything", arguments: {} });
		await new Promise((r) => setTimeout(r, 25));
		const tr = frames.find((f) => f.kind === "tool_result");
		assert.ok(tr);
		assert.ok(tr.isError);
		await router.close();
	});
});

describe("Router — hook events", () => {
	it("hook_event emits event; deliver via resolve callback writes hook_response", async () => {
		const router = makeRouter("main");
		await router.listen();
		let received;
		router.on("hookEvent", (e) => { received = e; });
		const client = await ipcConnect(router.socketPath);
		const frames = [];
		client.on("frame", (f) => frames.push(f));
		client.send({ kind: "hello", role: "hook" });
		client.send({
			kind: "hook_event",
			id: "h1",
			event: "SessionStart",
			payload: { session_id: "abc", transcript_path: "/x.jsonl" },
		});
		await new Promise((r) => setTimeout(r, 25));
		assert.ok(received);
		assert.equal(received.event, "SessionStart");
		assert.equal(received.payload.session_id, "abc");

		received.resolve("{}");
		await new Promise((r) => setTimeout(r, 25));
		const hr = frames.find((f) => f.kind === "hook_response");
		assert.ok(hr);
		assert.equal(hr.stdout, "{}");

		await router.close();
	});
});

describe("Router — D15 preservation", () => {
	it("preserveAndDetachFromPty clears resolvers but preserves capturedArgs + pendingResults", async () => {
		const router = makeRouter("capture");
		await router.listen();
		const client = await ipcConnect(router.socketPath);
		client.send({ kind: "hello", role: "mcp" });
		client.send({ kind: "capture_stash", id: "1", args: { x: "y" } });
		await new Promise((r) => setTimeout(r, 25));
		assert.deepEqual(router.capturedArgs, { x: "y" });

		// Simulate late tool-result on a separate id
		router.deliverToolResult("late-id", [{ type: "text", text: "late" }]);
		assert.equal(router.pendingResults.size, 1);

		await router.preserveAndDetachFromPty();
		// After detach: socket closed, but state preserved
		assert.deepEqual(router.capturedArgs, { x: "y" });
		assert.equal(router.pendingResults.size, 1);

		await router.close();
	});
});
