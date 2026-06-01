#!/usr/bin/env node
// Unit tests for src/mcp/ipc.ts (T1.5) — unix-socket transport + framing.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	createIpcServer,
	connectIpcClient,
	generateSocketPath,
	createLineDecoder,
	encodeFrame,
} from "../src/mcp/ipc.js";

function noopHandlers(overrides = {}) {
	return {
		onToolCall: async (req) => ({
			kind: "tools/call:response",
			id: req.id,
			content: [{ type: "text", text: `echo:${req.name}` }],
		}),
		onCaptureStash: async () => {},
		...overrides,
	};
}

describe("ipc framing — createLineDecoder", () => {
	it("decodes a single complete line", () => {
		const got = [];
		const d = createLineDecoder((m) => got.push(m));
		d('{"a":1}\n');
		assert.deepEqual(got, [{ a: 1 }]);
	});

	it("buffers a partial read split across chunks", () => {
		const got = [];
		const d = createLineDecoder((m) => got.push(m));
		d('{"a":');
		d("1}");
		assert.deepEqual(got, []); // no newline yet
		d("\n");
		assert.deepEqual(got, [{ a: 1 }]);
	});

	it("decodes multiple lines in one chunk", () => {
		const got = [];
		const d = createLineDecoder((m) => got.push(m));
		d('{"a":1}\n{"b":2}\n{"c":3}\n');
		assert.deepEqual(got, [{ a: 1 }, { b: 2 }, { c: 3 }]);
	});

	it("invokes onParseError for a malformed line and keeps going", () => {
		const got = [];
		const bad = [];
		const d = createLineDecoder(
			(m) => got.push(m),
			(raw) => bad.push(raw),
		);
		d("not json\n");
		d('{"ok":true}\n');
		assert.deepEqual(bad, ["not json"]);
		assert.deepEqual(got, [{ ok: true }]);
	});

	it("encodeFrame round-trips through the decoder", () => {
		const got = [];
		const d = createLineDecoder((m) => got.push(m));
		const msg = { kind: "tools/call", id: "x1", name: "read", arguments: { p: "/tmp" } };
		d(encodeFrame(msg));
		assert.deepEqual(got, [msg]);
	});
});

describe("ipc — generateSocketPath", () => {
	it("produces unique paths under tmpdir", () => {
		const a = generateSocketPath();
		const b = generateSocketPath();
		assert.notEqual(a, b);
		assert.match(a, /pi-claude-bridge-[0-9a-f]+\.sock$/);
	});
});

describe("ipc — client<->server round-trip over a real tmp socket", () => {
	it("forwards a tools/call and returns the correlated response", async () => {
		const sock = generateSocketPath();
		const server = createIpcServer(sock, noopHandlers());
		await server.listen();
		const client = await connectIpcClient(sock);

		const res = await client.request({
			kind: "tools/call",
			id: "req-1",
			name: "read",
			arguments: { path: "/tmp/x" },
		});
		assert.equal(res.kind, "tools/call:response");
		assert.equal(res.id, "req-1");
		assert.deepEqual(res.content, [{ type: "text", text: "echo:read" }]);

		client.close();
		await server.close();
	});

	it("acks a capture-stash and surfaces args to the handler", async () => {
		const sock = generateSocketPath();
		const stashed = [];
		const server = createIpcServer(
			sock,
			noopHandlers({ onCaptureStash: (req) => stashed.push(req.arguments) }),
		);
		await server.listen();
		const client = await connectIpcClient(sock);

		const ack = await client.request({
			kind: "capture-stash",
			id: "cap-1",
			arguments: { summary: "done" },
		});
		assert.equal(ack.kind, "capture-stash:ack");
		assert.equal(ack.id, "cap-1");
		assert.deepEqual(stashed, [{ summary: "done" }]);

		client.close();
		await server.close();
	});

	it("handles multiple concurrent in-flight messages without cross-wiring", async () => {
		const sock = generateSocketPath();
		// Server resolves out of order: req-slow waits longer than req-fast.
		const server = createIpcServer(sock, {
			onToolCall: async (req) => {
				const delay = req.name === "slow" ? 40 : 5;
				await new Promise((r) => setTimeout(r, delay));
				return { kind: "tools/call:response", id: req.id, content: [{ type: "text", text: req.name }] };
			},
			onCaptureStash: async () => {},
		});
		await server.listen();
		const client = await connectIpcClient(sock);

		const [slow, fast] = await Promise.all([
			client.request({ kind: "tools/call", id: "s", name: "slow", arguments: {} }),
			client.request({ kind: "tools/call", id: "f", name: "fast", arguments: {} }),
		]);
		assert.equal(slow.id, "s");
		assert.equal(slow.content[0].text, "slow");
		assert.equal(fast.id, "f");
		assert.equal(fast.content[0].text, "fast");

		client.close();
		await server.close();
	});
});
