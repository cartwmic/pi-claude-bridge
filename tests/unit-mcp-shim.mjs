#!/usr/bin/env node
// Unit tests for src/mcp/shim.ts (T1.6) — MCP stdio shim behavior.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	parseShimArgs,
	validateAgainstSchema,
	createShimHandlers,
	buildMcpServerCore,
	CAPTURE_SUCCESS_TEXT,
} from "../src/mcp/shim.js";
import { createIpcServer, generateSocketPath, connectIpcClient } from "../src/mcp/ipc.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join as joinPath } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve as pathResolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHIM_PATH = pathResolve(__dirname, "../src/mcp/shim.ts");

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64");

// A fake router over a real tmp socket. Parks tool_calls; resolves on demand.
function fakeRouter() {
	const sock = generateSocketPath();
	const parked = new Map(); // id -> resolve fn for the response
	const stashed = [];
	const onCall = new Map(); // id -> {resolveCall}
	let pendingResolve = null;

	const server = createIpcServer(sock, {
		onToolCall: (req) =>
			new Promise((resolve) => {
				parked.set(req.id, (content, isError) =>
					resolve({ kind: "tools/call:response", id: req.id, content, isError }),
				);
				if (pendingResolve) {
					const r = pendingResolve;
					pendingResolve = null;
					r(req);
				}
			}),
		onCaptureStash: (req) => {
			stashed.push(req.arguments);
		},
	});

	return {
		sock,
		stashed,
		start: () => server.listen(),
		stop: () => server.close(),
		parkedCount: () => parked.size,
		// resolve the first parked call by id (or any if only one)
		resolve: (content, isError) => {
			const [id, fn] = parked.entries().next().value;
			parked.delete(id);
			fn(content, isError);
		},
		waitForCall: () => new Promise((r) => (pendingResolve = r)),
	};
}

async function withHandlers(config, fn) {
	const router = fakeRouter();
	await router.start();
	const ipc = await connectIpcClient(router.sock);
	const handlers = createShimHandlers({ config, ipc, log: () => {} });
	try {
		await fn(handlers, router);
	} finally {
		ipc.close();
		await router.stop();
	}
}

describe("shim — parseShimArgs", () => {
	it("parses socket, mode, tools from argv", () => {
		const cfg = parseShimArgs([
			"--socket", "/tmp/x.sock",
			"--mode", "main",
			"--tools", b64([{ name: "mcp__custom-tools__read" }]),
		]);
		assert.equal(cfg.socketPath, "/tmp/x.sock");
		assert.equal(cfg.mode, "main");
		assert.deepEqual(cfg.tools, [{ name: "mcp__custom-tools__read" }]);
	});

	it("requires --socket", () => {
		assert.throws(() => parseShimArgs(["--mode", "main", "--tools", b64([])]), /--socket/);
	});

	it("requires --capture-tool in capture mode", () => {
		assert.throws(
			() => parseShimArgs(["--socket", "/s", "--mode", "capture", "--tools", b64([])]),
			/--capture-tool/,
		);
	});

	it("falls back to env for tools", () => {
		const cfg = parseShimArgs(["--socket", "/s", "--mode", "main"], {
			PI_CLAUDE_BRIDGE_SHIM_TOOLS: b64([{ name: "t" }]),
		});
		assert.deepEqual(cfg.tools, [{ name: "t" }]);
	});

	it("parses --ready-file (optional MCP-readiness sentinel)", () => {
		const cfg = parseShimArgs([
			"--socket", "/tmp/x.sock",
			"--mode", "main",
			"--tools", b64([{ name: "mcp__custom-tools__read" }]),
			"--ready-file", "/tmp/x.sock.ready",
		]);
		assert.equal(cfg.readyFile, "/tmp/x.sock.ready");
	});

	it("readyFile is undefined when --ready-file absent", () => {
		const cfg = parseShimArgs(["--socket", "/s", "--mode", "main", "--tools", b64([])]);
		assert.equal(cfg.readyFile, undefined);
	});
});

describe("shim — validateAgainstSchema", () => {
	const schema = {
		type: "object",
		required: ["summary"],
		properties: { summary: { type: "string" }, count: { type: "integer" } },
	};

	it("passes valid args", () => {
		assert.equal(validateAgainstSchema(schema, { summary: "ok", count: 3 }), null);
	});
	it("names the missing required field", () => {
		const e = validateAgainstSchema(schema, { count: 1 });
		assert.equal(e.field, "summary");
	});
	it("names the wrong-typed field", () => {
		const e = validateAgainstSchema(schema, { summary: 5 });
		assert.equal(e.field, "summary");
		assert.match(e.message, /string/);
	});
});

describe("shim — tools/list advertises only the declared set", () => {
	it("returns exactly the declared mcp__custom-tools__* tools", async () => {
		const config = {
			socketPath: "/unused",
			mode: "main",
			tools: [
				{ name: "mcp__custom-tools__read", description: "read", inputSchema: { type: "object" } },
				{ name: "mcp__custom-tools__write" },
			],
		};
		await withHandlers(config, async (handlers) => {
			const { tools } = handlers.listTools();
			assert.deepEqual(
				tools.map((t) => t.name).sort(),
				["mcp__custom-tools__read", "mcp__custom-tools__write"],
			);
			// every tool has an inputSchema (defaulted if absent)
			for (const t of tools) assert.ok(t.inputSchema && typeof t.inputSchema === "object");
		});
	});
});

describe("shim — tools/call forwarded + held open until router resolves", () => {
	it("does not resolve until the fake router resolves", async () => {
		const config = {
			socketPath: "/unused",
			mode: "main",
			tools: [{ name: "mcp__custom-tools__read" }],
		};
		await withHandlers(config, async (handlers, router) => {
			let done = false;
			const callP = handlers.callTool("mcp__custom-tools__read", { path: "/tmp/x" }).then((r) => {
				done = true;
				return r;
			});
			await router.waitForCall();
			await new Promise((r) => setTimeout(r, 15));
			assert.equal(done, false, "held open until router resolves");
			assert.equal(router.parkedCount(), 1);

			router.resolve([{ type: "text", text: "contents" }]);
			const res = await callP;
			assert.equal(done, true);
			assert.deepEqual(res.content, [{ type: "text", text: "contents" }]);
		});
	});

	it("returns isError verbatim from the router", async () => {
		const config = { socketPath: "/unused", mode: "main", tools: [{ name: "mcp__custom-tools__x" }] };
		await withHandlers(config, async (handlers, router) => {
			const callP = handlers.callTool("mcp__custom-tools__x", {});
			await router.waitForCall();
			router.resolve([{ type: "text", text: "boom" }], true);
			const res = await callP;
			assert.equal(res.isError, true);
		});
	});
});

describe("shim — unknown tool rejected without contacting router", () => {
	it("throws MethodNotFound (-32601) and never parks", async () => {
		const config = { socketPath: "/unused", mode: "main", tools: [{ name: "mcp__custom-tools__allowed" }] };
		await withHandlers(config, async (handlers, router) => {
			await assert.rejects(
				() => handlers.callTool("mcp__custom-tools__forbidden", {}),
				(err) => {
					assert.equal(err.code, -32601);
					return true;
				},
			);
			assert.equal(router.parkedCount(), 0, "router not contacted");
		});
	});
});

describe("shim — capture mode", () => {
	const captureSchema = { type: "object", required: ["summary"], properties: { summary: { type: "string" } } };
	const captureConfig = () => ({
		socketPath: "/unused",
		mode: "capture",
		captureToolName: "mcp__custom-tools__capture",
		tools: [{ name: "mcp__custom-tools__capture", inputSchema: captureSchema }],
	});

	it("valid args: deterministic response + stash, no park", async () => {
		await withHandlers(captureConfig(), async (handlers, router) => {
			const res = await handlers.callTool("mcp__custom-tools__capture", { summary: "all done" });
			assert.deepEqual(res.content, [{ type: "text", text: CAPTURE_SUCCESS_TEXT }]);
			// stash landed; nothing parked
			await new Promise((r) => setTimeout(r, 10));
			assert.deepEqual(router.stashed, [{ summary: "all done" }]);
			assert.equal(router.parkedCount(), 0);
		});
	});

	it("invalid args: -32602 naming the failing field path", async () => {
		await withHandlers(captureConfig(), async (handlers, router) => {
			await assert.rejects(
				() => handlers.callTool("mcp__custom-tools__capture", { notsummary: 1 }),
				(err) => {
					assert.equal(err.code, -32602);
					assert.match(err.message, /summary/);
					return true;
				},
			);
			assert.equal(router.stashed.length, 0, "no stash on invalid");
		});
	});

	it("repeat valid call: -32603 end-your-turn; first stash retained", async () => {
		await withHandlers(captureConfig(), async (handlers, router) => {
			await handlers.callTool("mcp__custom-tools__capture", { summary: "first" });
			await assert.rejects(
				() => handlers.callTool("mcp__custom-tools__capture", { summary: "second" }),
				(err) => {
					assert.equal(err.code, -32603);
					return true;
				},
			);
			await new Promise((r) => setTimeout(r, 10));
			assert.deepEqual(router.stashed, [{ summary: "first" }], "first call's args remain final");
		});
	});
});

describe("shim — full MCP protocol over a linked transport", () => {
	it("initialize + tools/list reflects the declared set; tools/call round-trips", async () => {
		const config = {
			socketPath: "/unused",
			mode: "main",
			tools: [{ name: "mcp__custom-tools__read", inputSchema: { type: "object" } }],
		};
		const router = fakeRouter();
		await router.start();
		const ipc = await connectIpcClient(router.sock);
		const handlers = createShimHandlers({ config, ipc, log: () => {} });
		const server = buildMcpServerCore(handlers);

		const [clientT, serverT] = InMemoryTransport.createLinkedPair();
		await server.connect(serverT);
		const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });
		await client.connect(clientT);

		try {
			const list = await client.listTools();
			assert.deepEqual(list.tools.map((t) => t.name), ["mcp__custom-tools__read"]);

			const callP = client.callTool({ name: "mcp__custom-tools__read", arguments: { path: "/p" } });
			await router.waitForCall();
			router.resolve([{ type: "text", text: "ok-via-protocol" }]);
			const res = await callP;
			assert.equal(res.content[0].text, "ok-via-protocol");
		} finally {
			await client.close();
			await server.close();
			ipc.close();
			await router.stop();
		}
	});
});

describe("shim — MCP-readiness sentinel (--ready-file)", () => {
	it("creates the sentinel the first time it serves tools/list", async () => {
		const router = fakeRouter();
		await router.start();
		const readyFile = joinPath(tmpdir(), `pcb-test-${process.pid}-${Date.now()}.ready`);
		rmSync(readyFile, { force: true });
		assert.equal(existsSync(readyFile), false, "sentinel must not exist before tools/list");

		const transport = new StdioClientTransport({
			command: process.execPath,
			args: [
				"--import", "tsx", SHIM_PATH,
				"--socket", router.sock,
				"--mode", "main",
				"--tools", b64([{ name: "mcp__custom-tools__read", inputSchema: { type: "object" } }]),
				"--ready-file", readyFile,
			],
		});
		const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });
		try {
			await client.connect(transport); // initialize handshake — NOT tools/list yet
			const list = await client.listTools(); // this is what raises the sentinel
			assert.deepEqual(list.tools.map((t) => t.name), ["mcp__custom-tools__read"]);
			assert.equal(existsSync(readyFile), true, "sentinel must exist after the first tools/list");
		} finally {
			await client.close();
			rmSync(readyFile, { force: true });
			await router.stop();
		}
	});
});

describe("shim — lifecycle: exits when IPC channel closes", () => {
	it("triggers onClose teardown when the router stops", async () => {
		const router = fakeRouter();
		await router.start();
		const ipc = await connectIpcClient(router.sock);
		let closed = false;
		ipc.onClose(() => (closed = true));
		await router.stop();
		await new Promise((r) => setTimeout(r, 30));
		assert.equal(closed, true, "IPC close fired -> shim would exit");
		ipc.close();
	});
});

// Spawn the real shim subprocess (via tsx) to exercise runShim's stdin loop:
// malformed JSON-RPC -> parse error on stdout + survives; stdin close -> exit.
describe("shim — subprocess: malformed JSON-RPC + stdin-close lifecycle", () => {
	it("replies with a parse error, survives, then exits on stdin close", async () => {
		const router = fakeRouter();
		await router.start();

		const child = spawn(
			process.execPath,
			["--import", "tsx", SHIM_PATH, "--socket", router.sock, "--mode", "main", "--tools", b64([{ name: "mcp__custom-tools__read" }])],
			{ stdio: ["pipe", "pipe", "pipe"] },
		);

		let out = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (d) => (out += d));
		const exitP = new Promise((r) => child.on("exit", (code) => r(code)));

		// Give it a moment to connect IPC + start.
		await new Promise((r) => setTimeout(r, 600));

		// Malformed JSON-RPC frame.
		child.stdin.write("this is not json\n");
		// Then a valid initialize request — proves the process survived.
		child.stdin.write(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } },
			}) + "\n",
		);

		// SIGNAL-based wait (not a fixed sleep): under machine load the tsx-booted
		// shim can take well over the old 600+400ms budget to boot and answer,
		// which made this test flake in full-suite runs (code-review r3 #13).
		// Same assertions, generous deadline.
		const deadline = Date.now() + 15_000;
		while (Date.now() < deadline && !(/-32700/.test(out) && /"id":1/.test(out))) {
			await new Promise((r) => setTimeout(r, 50));
		}

		// Parse error must have been emitted on stdout.
		assert.match(out, /-32700/, "parse error code on stdout");
		// And the valid initialize must have been answered (proves survival).
		assert.match(out, /"id":1/, "initialize answered after malformed frame");

		// Closing stdin must terminate the shim.
		child.stdin.end();
		const code = await Promise.race([
			exitP,
			new Promise((r) => setTimeout(() => r("timeout"), 10_000)),
		]);
		assert.notEqual(code, "timeout", "shim exited on stdin close");

		try {
			child.kill();
		} catch {}
		await router.stop();
	});
});
