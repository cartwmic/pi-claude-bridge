#!/usr/bin/env node
// src/mcp/shim.ts
//
// Standalone stdio MCP server subprocess (T1.6). Spawned by `claude` (via
// claude-p's `--mcp-config`), it speaks MCP/JSON-RPC over its stdio to
// `claude` and proxies tool calls to the bridge's in-process router over a
// dedicated unix socket (the ipc.ts transport). It is the only
// bridge-controlled interface the inference driver sees.
//
// Runnable as `node dist/mcp/shim.js …` in prod and `node --import tsx
// src/mcp/shim.ts …` (or imported by tests) in dev.
//
// ---------------------------------------------------------------------------
// How the shim receives its configuration (CONTRACT for the bridge, T1.9)
// ---------------------------------------------------------------------------
// The bridge passes everything via ARGV in the `--mcp-config` JSON's `args`
// array (design D19 uses an array form, so no shell quoting). Recognized flags:
//
//   --socket <path>     REQUIRED. Unix-socket path of the router for this spawn.
//   --mode <main|capture>  REQUIRED. Selects the tools/call behavior.
//   --tools <base64-json>  REQUIRED. base64(JSON) of the advertised tool defs:
//                          [{ name, description?, inputSchema? }, …]. base64 so
//                          arbitrary JSON survives an argv slot without quoting.
//   --capture-tool <name>  REQUIRED in capture mode. The MCP name of the capture
//                          tool whose args are validated locally and stashed.
//
// (Tool defs MAY alternatively be supplied via the env var
// PI_CLAUDE_BRIDGE_SHIM_TOOLS, base64-JSON, if argv length is a concern; argv
// takes precedence. The bridge wires whichever it prefers in T1.9.)

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	McpError,
	ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import { connectIpcClient, createLineDecoder, type IpcClient, type ToolResultContent } from "./ipc.js";

export type ShimMode = "main" | "capture";

export type ShimToolDef = {
	name: string;
	description?: string;
	/** JSON Schema for the tool's arguments. */
	inputSchema?: Record<string, unknown>;
};

export type ShimConfig = {
	socketPath: string;
	mode: ShimMode;
	tools: ShimToolDef[];
	/** Required in capture mode: the MCP name of the capture tool. */
	captureToolName?: string;
};

export const CAPTURE_SUCCESS_TEXT = "Capture received. End your turn now.";

// ---------------------------------------------------------------------------
// argv / env parsing
// ---------------------------------------------------------------------------

function decodeToolsB64(b64: string): ShimToolDef[] {
	const json = Buffer.from(b64, "base64").toString("utf8");
	const parsed = JSON.parse(json);
	if (!Array.isArray(parsed)) throw new Error("--tools must decode to a JSON array");
	return parsed;
}

export function parseShimArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ShimConfig {
	const get = (flag: string): string | undefined => {
		const i = argv.indexOf(flag);
		return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
	};

	const socketPath = get("--socket");
	if (!socketPath) throw new Error("shim: --socket <path> is required");

	const mode = (get("--mode") ?? "main") as ShimMode;
	if (mode !== "main" && mode !== "capture") throw new Error(`shim: invalid --mode ${mode}`);

	const toolsB64 = get("--tools") ?? env.PI_CLAUDE_BRIDGE_SHIM_TOOLS;
	if (!toolsB64) throw new Error("shim: --tools <base64-json> (or PI_CLAUDE_BRIDGE_SHIM_TOOLS) is required");
	const tools = decodeToolsB64(toolsB64);

	const captureToolName = get("--capture-tool");
	if (mode === "capture" && !captureToolName) throw new Error("shim: --capture-tool <name> required in capture mode");

	return { socketPath, mode, tools, captureToolName };
}

// ---------------------------------------------------------------------------
// Minimal JSON-Schema validation for capture args (local, in-shim per spec)
// ---------------------------------------------------------------------------

export type ValidationError = { field: string; message: string };

/**
 * Validate `args` against a (subset of) JSON Schema sufficient for capture
 * tools: top-level `type: "object"`, `required: [...]`, and per-property
 * `type` checks. Returns the first failing field path, or null on success.
 * Kept dependency-free and deterministic so the shim needs no ajv at runtime.
 */
export function validateAgainstSchema(
	schema: Record<string, any> | undefined,
	args: Record<string, unknown>,
	pathPrefix = "",
): ValidationError | null {
	if (!schema || typeof schema !== "object") return null;

	if (schema.type === "object" || schema.properties || schema.required) {
		if (args === null || typeof args !== "object" || Array.isArray(args)) {
			return { field: pathPrefix || "(root)", message: "expected object" };
		}
		const required: string[] = Array.isArray(schema.required) ? schema.required : [];
		for (const key of required) {
			if (!(key in args)) {
				return { field: pathPrefix ? `${pathPrefix}.${key}` : key, message: "required field missing" };
			}
		}
		const props: Record<string, any> = schema.properties ?? {};
		for (const [key, val] of Object.entries(args)) {
			const propSchema = props[key];
			if (!propSchema) continue; // additionalProperties tolerated
			const childPath = pathPrefix ? `${pathPrefix}.${key}` : key;
			const childErr = validateScalarOrNested(propSchema, val, childPath);
			if (childErr) return childErr;
		}
		return null;
	}

	return validateScalarOrNested(schema, args, pathPrefix || "(root)");
}

function validateScalarOrNested(schema: Record<string, any>, val: unknown, field: string): ValidationError | null {
	const t = schema.type;
	if (!t) return null;
	if (t === "object") return validateAgainstSchema(schema, val as Record<string, unknown>, field);
	if (t === "array") {
		if (!Array.isArray(val)) return { field, message: "expected array" };
		return null;
	}
	const ok =
		(t === "string" && typeof val === "string") ||
		(t === "number" && typeof val === "number") ||
		(t === "integer" && typeof val === "number" && Number.isInteger(val)) ||
		(t === "boolean" && typeof val === "boolean");
	if (!ok) return { field, message: `expected ${t}` };
	return null;
}

// ---------------------------------------------------------------------------
// Structured logging (stderr — stdout is the MCP channel)
// ---------------------------------------------------------------------------

export function shimLog(entry: Record<string, unknown>): void {
	try {
		process.stderr.write(JSON.stringify({ src: "pi-claude-bridge-shim", ...entry }) + "\n");
	} catch {
		/* never let logging crash the shim */
	}
}

// ---------------------------------------------------------------------------
// Core handler factory — pure(ish), unit-testable against a fake IPC client
// ---------------------------------------------------------------------------

export type ShimHandlersDeps = {
	config: ShimConfig;
	/** IPC client to the router (already connected). May be null in capture-only flows that never park. */
	ipc: IpcClient;
	log?: (entry: Record<string, unknown>) => void;
};

export type ShimHandlers = {
	/** tools/list payload: exactly the advertised set. */
	listTools: () => { tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> };
	/**
	 * tools/call. Returns the MCP result payload, or throws an McpError for
	 * unknown-tool / invalid-params / repeat-capture cases.
	 */
	callTool: (name: string, args: Record<string, unknown>) => Promise<{ content: ToolResultContent; isError?: boolean }>;
};

export function createShimHandlers(deps: ShimHandlersDeps): ShimHandlers {
	const { config, ipc } = deps;
	const log = deps.log ?? shimLog;
	const advertised = new Set(config.tools.map((t) => t.name));
	let captureDone = false; // first valid capture wins (in-process state)

	const listTools: ShimHandlers["listTools"] = () => ({
		tools: config.tools.map((t) => ({
			name: t.name,
			description: t.description,
			inputSchema: t.inputSchema ?? { type: "object" },
		})),
	});

	const callTool: ShimHandlers["callTool"] = async (name, args) => {
		// Defense-in-depth: reject any name not advertised, WITHOUT contacting the router.
		if (!advertised.has(name)) {
			log({ level: "warn", event: "unknown-tool", name });
			throw new McpError(ErrorCode.MethodNotFound, `unknown tool: ${name}`);
		}

		// ---- capture mode: handled entirely in-shim ----
		if (config.mode === "capture" && name === config.captureToolName) {
			if (captureDone) {
				log({ level: "warn", event: "capture-repeat", name });
				throw new McpError(ErrorCode.InternalError, "Capture already received; end your turn now.");
			}
			const captureDef = config.tools.find((t) => t.name === name);
			const err = validateAgainstSchema(captureDef?.inputSchema, args ?? {});
			if (err) {
				log({ level: "warn", event: "capture-invalid", field: err.field, message: err.message });
				throw new McpError(ErrorCode.InvalidParams, `Invalid params: ${err.field} — ${err.message}`);
			}
			// Stash validated args to the router; do NOT park.
			await ipc.request({ kind: "capture-stash", id: randomUUID(), arguments: args ?? {} });
			captureDone = true;
			log({ level: "info", event: "capture-stashed" });
			return { content: [{ type: "text", text: CAPTURE_SUCCESS_TEXT }] };
		}

		// ---- main mode: forward to router and hold open until it resolves ----
		const reqId = randomUUID();
		log({ level: "debug", event: "forward", name, reqId });
		const res = await ipc.request({ kind: "tools/call", id: reqId, name, arguments: args ?? {} });
		if (res.kind !== "tools/call:response") {
			throw new McpError(ErrorCode.InternalError, "router returned an unexpected frame");
		}
		log({ level: "debug", event: "resolved", name, reqId });
		return { content: res.content, isError: res.isError };
	};

	return { listTools, callTool };
}

// ---------------------------------------------------------------------------
// MCP server wiring (SDK Server + StdioServerTransport)
// ---------------------------------------------------------------------------

/**
 * Wire a Server with the shim handlers and connect it over a
 * StdioServerTransport reading from `stdinSource` / writing to `stdoutSink`.
 * Returns the Server so callers can close it. The transport reads from a
 * PassThrough we feed with VALID JSON-RPC lines only; malformed lines are
 * intercepted upstream (see runShim) so we can emit a parse-error reply
 * without the SDK silently dropping them.
 */
/**
 * Build a Server with the shim's tools/list + tools/call handlers attached, but
 * NOT connected to any transport. Tests connect it to an InMemoryTransport;
 * runShim connects it to the stdio transport.
 */
export function buildMcpServerCore(handlers: ShimHandlers): Server {
	const server = new Server(
		{ name: "pi-claude-bridge-shim", version: "1.0.0" },
		{ capabilities: { tools: {} } },
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => handlers.listTools());

	server.setRequestHandler(CallToolRequestSchema, async (req) => {
		const { name, arguments: args } = req.params;
		return handlers.callTool(name, (args ?? {}) as Record<string, unknown>);
	});

	return server;
}

export function buildMcpServer(handlers: ShimHandlers): { server: Server; feed: PassThrough; transport: StdioServerTransport } {
	const server = buildMcpServerCore(handlers);
	const feed = new PassThrough();
	const transport = new StdioServerTransport(feed as any, process.stdout);
	transport.onerror = (err) => shimLog({ level: "error", event: "transport-error", message: String(err) });
	return { server, feed, transport };
}

/** Emit a JSON-RPC parse error to stdout (used when a stdin line is not JSON). */
function writeParseError(stdout: NodeJS.WritableStream, rawLine: string): void {
	let id: string | number | null = null;
	// Best-effort: a malformed frame has no usable id; JSON-RPC permits null.
	const payload = {
		jsonrpc: "2.0",
		id,
		error: { code: ErrorCode.ParseError, message: "Parse error" },
	};
	stdout.write(JSON.stringify(payload) + "\n");
	shimLog({ level: "error", event: "parse-error", rawLen: rawLine.length });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runShim(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ stop: () => Promise<void> }> {
	const config = parseShimArgs(argv, env);
	const ipc = await connectIpcClient(config.socketPath);
	const handlers = createShimHandlers({ config, ipc });
	const { server, feed, transport } = buildMcpServer(handlers);
	await server.connect(transport);

	let stopped = false;
	const stop = async () => {
		if (stopped) return;
		stopped = true;
		try {
			ipc.close();
		} catch {}
		try {
			await server.close();
		} catch {}
	};

	// Lifecycle: exit when stdin closes or the IPC channel closes (bound to this spawn).
	ipc.onClose(() => {
		shimLog({ level: "info", event: "ipc-closed" });
		void stop().then(() => process.exit(0));
	});

	// Custom stdin reader: forward VALID JSON-RPC lines to the SDK transport;
	// reply with a parse error (and survive) on malformed lines.
	const decode = createLineDecoder(
		(msg) => {
			feed.write(JSON.stringify(msg) + "\n");
		},
		(raw) => {
			writeParseError(process.stdout, raw);
		},
	);
	process.stdin.on("data", decode);
	process.stdin.on("end", () => {
		shimLog({ level: "info", event: "stdin-closed" });
		void stop().then(() => process.exit(0));
	});

	return { stop };
}

// Auto-run when invoked as a script (not when imported by tests).
const isMain = (() => {
	try {
		// process.argv[1] is the script path; compare to this module's URL.
		return import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("shim.js") || process.argv[1]?.endsWith("shim.ts");
	} catch {
		return false;
	}
})();

if (isMain) {
	runShim(process.argv.slice(2)).catch((err) => {
		shimLog({ level: "error", event: "startup-failed", message: String(err) });
		process.exit(1);
	});
}
