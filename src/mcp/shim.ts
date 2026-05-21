#!/usr/bin/env node
// src/mcp/shim.ts
//
// Multi-mode shim binary (T1.7). Invoked by `claude` in two ways:
//
//   --mode mcp --socket <path> [--tools-file <path>] [--capture-tool <name>]
//      Stdio MCP server. Advertises tools loaded from --tools-file.
//      For each `tools/call`, forwards to bridge router over the unix
//      socket. In capture mode (when --capture-tool is set), validates
//      args against the tool schema locally and handles the deterministic
//      response per D16 + D21.
//
//   --mode hook --event <name> --socket <path>
//      Hook payload relay. Reads payload from stdin, sends `hook_event`
//      frame to router, awaits `hook_response`, writes response.stdout
//      to its own stdout, exits.
//
// Bridge resolves the absolute path to this file via require.resolve and
// passes it in both --mcp-config and --settings (D19).
//
// Wire protocol: see src/mcp/ipc.ts + D20.

import { readFileSync } from "node:fs";
import process from "node:process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
	ipcConnect,
	type IpcPeer,
	type IpcFrame,
	type ToolCallFrame,
	type ToolResultFrame,
	type HookEventFrame,
	type HookResponseFrame,
	type CaptureStashFrame,
	type CaptureStashAckFrame,
	type HelloFrame,
} from "./ipc.js";
import { randomUUID } from "node:crypto";

// --- Argv parsing --------------------------------------------------------

interface ParsedArgs {
	mode: "mcp" | "hook";
	socket: string;
	event?: string;
	toolsFile?: string;
	captureTool?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
	const out: Partial<ParsedArgs> = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = argv[i + 1];
		switch (a) {
			case "--mode":
				out.mode = next as "mcp" | "hook"; i++; break;
			case "--socket":
				out.socket = next; i++; break;
			case "--event":
				out.event = next; i++; break;
			case "--tools-file":
				out.toolsFile = next; i++; break;
			case "--capture-tool":
				out.captureTool = next; i++; break;
		}
	}
	if (!out.mode || (out.mode !== "mcp" && out.mode !== "hook")) {
		throw new Error("shim: --mode mcp|hook required");
	}
	if (!out.socket) {
		throw new Error("shim: --socket <path> required");
	}
	if (out.mode === "hook" && !out.event) {
		throw new Error("shim: --mode hook requires --event <name>");
	}
	return out as ParsedArgs;
}

// --- Tools file shape ----------------------------------------------------

interface ToolsFile {
	tools: Array<{
		name: string;
		description?: string;
		inputSchema: unknown;
	}>;
	/** Optional: capture tool schema for local validation (capture mode). */
	captureSchema?: unknown;
}

function loadToolsFile(path: string): ToolsFile {
	try {
		const raw = readFileSync(path, "utf8");
		return JSON.parse(raw);
	} catch (err) {
		throw new Error(`shim: failed to load --tools-file ${path}: ${(err as Error).message}`);
	}
}

// --- Frame correlator helper --------------------------------------------

class FrameCorrelator {
	private pending: Map<string, (frame: IpcFrame) => void> = new Map();

	register(id: string, resolver: (frame: IpcFrame) => void): void {
		this.pending.set(id, resolver);
	}

	dispatch(frame: IpcFrame): boolean {
		const id = (frame as { id?: string }).id;
		if (!id) return false;
		const resolver = this.pending.get(id);
		if (!resolver) return false;
		this.pending.delete(id);
		resolver(frame);
		return true;
	}
}

// --- Hook mode -----------------------------------------------------------

async function runHookMode(args: ParsedArgs): Promise<void> {
	const stdin = await readStdinToString();
	let payload: Record<string, unknown> = {};
	if (stdin.trim()) {
		try {
			payload = JSON.parse(stdin);
		} catch {
			// Some hook events deliver non-JSON; pass through as raw_stdin field.
			payload = { raw_stdin: stdin };
		}
	}
	let peer: IpcPeer;
	try {
		peer = await ipcConnect(args.socket, 5000);
	} catch (err) {
		// If we can't reach the bridge, fall back to "{}" so claude doesn't hang.
		process.stderr.write(`shim: ipc connect failed: ${(err as Error).message}\n`);
		process.stdout.write("{}");
		return;
	}
	peer.send({ kind: "hello", role: "hook" } satisfies HelloFrame);
	const id = randomUUID();
	const correlator = new FrameCorrelator();
	peer.on("frame", (f) => {
		correlator.dispatch(f);
	});
	const respPromise = new Promise<HookResponseFrame>((resolve, reject) => {
		correlator.register(id, (f) => {
			if (f.kind === "hook_response") resolve(f);
			else reject(new Error(`unexpected response: ${f.kind}`));
		});
		setTimeout(() => reject(new Error("hook response timeout")), 30_000);
	});
	peer.send({
		kind: "hook_event",
		id,
		event: args.event as "SessionStart" | "Stop",
		payload,
	} satisfies HookEventFrame);
	try {
		const resp = await respPromise;
		process.stdout.write(resp.stdout || "{}");
	} catch (err) {
		process.stderr.write(`shim: hook response error: ${(err as Error).message}\n`);
		process.stdout.write("{}");
	} finally {
		peer.destroy();
	}
	// Force exit: stdin watchers / inner timers can otherwise keep the event
	// loop alive for up to 5s, blocking claude from proceeding past the hook.
	process.stdout.write("");
	process.exit(0);
}

function readStdinToString(): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (c: string) => { data += c; });
		process.stdin.on("end", () => resolve(data));
		process.stdin.on("error", reject);
		// If stdin is not a TTY and has no data, "end" fires after a tick.
		// Timeout safety:
		setTimeout(() => resolve(data), 5000);
	});
}

// --- MCP mode ------------------------------------------------------------

async function runMcpMode(args: ParsedArgs): Promise<void> {
	if (!args.toolsFile) {
		throw new Error("shim: --mode mcp requires --tools-file");
	}
	const toolsFile = loadToolsFile(args.toolsFile);

	// Connect to bridge router. If unreachable, exit non-zero.
	const peer = await ipcConnect(args.socket, 5000);
	peer.send({
		kind: "hello",
		role: "mcp",
		tools: toolsFile.tools,
	} satisfies HelloFrame);

	const correlator = new FrameCorrelator();
	peer.on("frame", (f) => {
		correlator.dispatch(f);
	});
	peer.on("close", () => {
		// PTY exited; tear down the MCP server.
		process.exit(0);
	});

	// Wire up MCP stdio server.
	const server = new Server(
		{ name: "pi-bridge", version: "0.1.0" },
		{ capabilities: { tools: {} } },
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => {
		return {
			tools: toolsFile.tools.map((t) => ({
				name: t.name,
				description: t.description ?? "",
				inputSchema: t.inputSchema,
			})),
		};
	});

	server.setRequestHandler(CallToolRequestSchema, async (req) => {
		const name = req.params.name;
		const argsIn = req.params.arguments ?? {};

		// Defense-in-depth: reject names not in our advertised set.
		const known = toolsFile.tools.find((t) => t.name === name);
		if (!known) {
			return {
				content: [{ type: "text", text: `unknown tool: ${name}` }],
				isError: true,
			};
		}

		// Capture mode: handle locally if this is the capture tool.
		if (args.captureTool && name === args.captureTool) {
			return await handleCaptureCall(peer, correlator, argsIn, toolsFile.captureSchema);
		}

		// Main mode: forward to router.
		const id = randomUUID();
		return await new Promise((resolve) => {
			correlator.register(id, (f) => {
				if (f.kind === "tool_result") {
					resolve({
						content: f.content as Array<{ type: "text"; text: string }>,
						isError: f.isError,
					});
				} else {
					resolve({
						content: [{ type: "text", text: `shim: unexpected frame kind ${(f as IpcFrame).kind}` }],
						isError: true,
					});
				}
			});
			peer.send({
				kind: "tool_call",
				id,
				name,
				arguments: argsIn,
			} satisfies ToolCallFrame);
		});
	});

	const transport = new StdioServerTransport();
	await server.connect(transport);
	// Server now runs until stdin closes.
}

// One-call-wins state for capture mode.
let captureAlreadyAnswered = false;

async function handleCaptureCall(
	peer: IpcPeer,
	correlator: FrameCorrelator,
	argsIn: unknown,
	captureSchema: unknown | undefined,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError: boolean }> {
	// Subsequent valid calls in the same turn return -32603 per D16.
	if (captureAlreadyAnswered) {
		return {
			content: [
				{
					type: "text",
					text: "Capture tool already received result. End your turn now.",
				},
			],
			isError: true,
		};
	}

	// Validate args against schema (light: structural-only — full JSON
	// Schema validation is the bridge's responsibility on harvest).
	const validation = lightValidateAgainstSchema(argsIn, captureSchema);
	if (validation.ok === false) {
		return {
			content: [{ type: "text", text: `Invalid params: ${validation.reason}` }],
			isError: true,
		};
	}

	// Stash on bridge via IPC.
	const id = randomUUID();
	const ack = await new Promise<CaptureStashAckFrame | undefined>((resolve) => {
		correlator.register(id, (f) => {
			if (f.kind === "capture_stash_ack") resolve(f);
			else resolve(undefined);
		});
		peer.send({ kind: "capture_stash", id, args: argsIn } satisfies CaptureStashFrame);
		setTimeout(() => resolve(undefined), 5000);
	});
	if (!ack) {
		return {
			content: [{ type: "text", text: "shim: capture stash timeout (router did not ack)" }],
			isError: true,
		};
	}

	captureAlreadyAnswered = true;
	return {
		content: [
			{
				type: "text",
				text: "Capture received. End your turn now.",
			},
		],
		isError: false,
	};
}

function lightValidateAgainstSchema(args: unknown, schema: unknown): { ok: true } | { ok: false; reason: string } {
	if (!schema || typeof schema !== "object") return { ok: true };
	const s = schema as { type?: string; required?: string[]; properties?: Record<string, unknown> };
	if (s.type && s.type !== "object") {
		// We only support object-root schemas in v1 (per output-capture).
		return { ok: false, reason: `capture schema root must be object; got ${s.type}` };
	}
	if (args === null || typeof args !== "object" || Array.isArray(args)) {
		return { ok: false, reason: "args must be a JSON object" };
	}
	const a = args as Record<string, unknown>;
	if (Array.isArray(s.required)) {
		for (const k of s.required) {
			if (!(k in a)) {
				return { ok: false, reason: `missing required field: ${k}` };
			}
		}
	}
	return { ok: true };
}

// --- Entry point ---------------------------------------------------------

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (args.mode === "hook") {
		await runHookMode(args);
		return;
	}
	await runMcpMode(args);
}

// Only run when invoked directly (not when imported as a module by tests).
// ESM: import.meta.url === pathToFileURL(process.argv[1]).href when direct.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("/shim.js") || process.argv[1]?.endsWith("/shim.ts")) {
	main().catch((err) => {
		process.stderr.write(`shim fatal: ${(err as Error).stack || err}\n`);
		process.exit(1);
	});
}

// --- Test exports --------------------------------------------------------

export {
	parseArgs as __parseArgs,
	lightValidateAgainstSchema as __lightValidate,
	loadToolsFile as __loadToolsFile,
};
