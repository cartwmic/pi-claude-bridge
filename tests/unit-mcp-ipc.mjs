#!/usr/bin/env node
// Unit tests for src/mcp/ipc.ts (T1.6).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { generateSocketPath, IpcServer, ipcConnect } from "../src/mcp/ipc.js";

describe("generateSocketPath", () => {
	it("returns a path under tmpdir with the given prefix", () => {
		const p = generateSocketPath("test-prefix");
		assert.match(p, /test-prefix-[0-9a-f]{16}\.sock$/);
	});

	it("returns unique paths on successive calls (random suffix)", () => {
		const a = generateSocketPath();
		const b = generateSocketPath();
		assert.notEqual(a, b);
	});
});

describe("IpcServer + ipcConnect", () => {
	it("client can connect; bidirectional newline-delimited frames", async () => {
		const path = generateSocketPath();
		const server = new IpcServer(path);
		await server.listen();
		assert.ok(existsSync(path));

		const peers = [];
		server.on("connection", (p) => peers.push(p));

		const clientPeer = await ipcConnect(path);
		// Server should now have one peer
		await new Promise((r) => setTimeout(r, 25));
		assert.equal(peers.length, 1);
		const serverPeer = peers[0];

		const serverFrames = [];
		const clientFrames = [];
		server.on("frame", (_p, f) => serverFrames.push(f));
		clientPeer.on("frame", (f) => clientFrames.push(f));

		// Client → server
		clientPeer.send({ kind: "hello", role: "mcp", tools: [] });
		await new Promise((r) => setTimeout(r, 25));
		assert.equal(serverFrames.length, 1);
		assert.equal(serverFrames[0].kind, "hello");
		assert.equal(serverFrames[0].role, "mcp");

		// Server → client
		serverPeer.send({ kind: "tool_result", id: "x", content: [{ type: "text", text: "ok" }], isError: false });
		await new Promise((r) => setTimeout(r, 25));
		assert.equal(clientFrames.length, 1);
		assert.equal(clientFrames[0].kind, "tool_result");

		await server.close();
		assert.ok(!existsSync(path));
	});

	it("multiple frames per write are split on newlines", async () => {
		const path = generateSocketPath();
		const server = new IpcServer(path);
		await server.listen();
		const peers = [];
		server.on("connection", (p) => peers.push(p));
		const clientPeer = await ipcConnect(path);
		await new Promise((r) => setTimeout(r, 25));
		const serverFrames = [];
		server.on("frame", (_p, f) => serverFrames.push(f));

		// Send 3 frames as one write (using internal newline-delimited form)
		const a = JSON.stringify({ kind: "tool_call", id: "1", name: "x", arguments: {} });
		const b = JSON.stringify({ kind: "tool_call", id: "2", name: "y", arguments: {} });
		const c = JSON.stringify({ kind: "tool_call", id: "3", name: "z", arguments: {} });
		// Write directly via internal socket to test framing
		const sock = clientPeer["sock"];
		sock.write(a + "\n" + b + "\n" + c + "\n");
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(serverFrames.length, 3);
		assert.deepEqual(serverFrames.map((f) => f.id), ["1", "2", "3"]);

		await server.close();
	});

	it("partial line is buffered until newline", async () => {
		const path = generateSocketPath();
		const server = new IpcServer(path);
		await server.listen();
		const peers = [];
		server.on("connection", (p) => peers.push(p));
		const clientPeer = await ipcConnect(path);
		await new Promise((r) => setTimeout(r, 25));
		const serverFrames = [];
		server.on("frame", (_p, f) => serverFrames.push(f));

		const full = JSON.stringify({ kind: "tool_call", id: "1", name: "x", arguments: {} });
		const sock = clientPeer["sock"];
		sock.write(full.slice(0, 10));
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(serverFrames.length, 0);
		sock.write(full.slice(10) + "\n");
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(serverFrames.length, 1);
		assert.equal(serverFrames[0].id, "1");

		await server.close();
	});

	it("malformed JSON line emits error on peer (not crash)", async () => {
		const path = generateSocketPath();
		const server = new IpcServer(path);
		await server.listen();
		const peers = [];
		server.on("connection", (p) => peers.push(p));
		const clientPeer = await ipcConnect(path);
		await new Promise((r) => setTimeout(r, 25));
		const errors = [];
		server.on("error", (e) => errors.push(e));
		const serverFrames = [];
		server.on("frame", (_p, f) => serverFrames.push(f));

		const sock = clientPeer["sock"];
		sock.write("{not valid json}\n");
		sock.write(JSON.stringify({ kind: "hello", role: "hook" }) + "\n");
		await new Promise((r) => setTimeout(r, 50));
		assert.ok(errors.length >= 1, `expected at least one error; got: ${errors.length}`);
		assert.equal(serverFrames.length, 1);
		assert.equal(serverFrames[0].kind, "hello");

		await server.close();
	});

	it("close() unlinks socket file", async () => {
		const path = generateSocketPath();
		const server = new IpcServer(path);
		await server.listen();
		assert.ok(existsSync(path));
		await server.close();
		assert.ok(!existsSync(path));
	});

	it("ipcConnect rejects on timeout against non-existent socket", async () => {
		const path = generateSocketPath();
		await assert.rejects(
			() => ipcConnect(path, 100),
			(err) => err instanceof Error && /ENOENT|timeout/.test(err.message),
		);
	});
});
