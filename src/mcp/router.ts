// src/mcp/router.ts
//
// In-process router for ONE claude-p spawn/frame. Owns the bridge side of the
// MCP shim's IPC channel (via ipc.ts) and implements the held-open
// promise-park that the Phase-0 spike validated: a `tools/call` arriving from
// the shim is parked until pi delivers the tool result, then the resolved
// payload flows back over IPC to the shim, which returns it as the MCP
// response. `claude` blocks inline the whole time.
//
// This mirrors index.ts's existing per-frame contract (the
// `pendingResolvers`/`pendingResults` maps populated by the SDK MCP handler)
// so wiring from the bridge (T1.9) is mechanical.
//
// ---------------------------------------------------------------------------
// D32 correlation — how the keying works here
// ---------------------------------------------------------------------------
// The held-open round-trip is split across two channels: the shim sends a
// `tools/call` with its OWN request id (+ name + arguments) but NOT, in
// general, the model's `toolu_…` id; pi delivers `toolResult.id` = a pi-facing
// id. Per D32 the round-trip is DRIVEN BY THE SHIM, not by parsing stdout: the
// router mints its OWN pi-facing id for each parked shim call and keys the
// resolver by that id. pi echoes that id back on its `toolResult`, and the
// bridge calls `router.deliver(piToolResultId, result)` to resolve the
// matching parked call. The model's `toolu_…` id is therefore NOT needed to
// ROUTE the round-trip; correlation to the stdout `toolu_…` (matching on
// name + canonicalized args, positional fallback for identical parallel calls)
// is UX-only and may be reconciled later — it does not gate resolution.
//
// Parallel held calls (S11): each parked call gets a distinct minted pi id, so
// two concurrent calls — even with identical name+args — are keyed
// independently and never cross-wire. The router asserts (via a structured log
// warning, not a throw) the serialization invariant that no two outstanding
// parked calls share the same (name, canonicalized-args) WITHIN one assistant
// line; the minted-id keying keeps them disjoint regardless.

import { randomBytes } from "node:crypto";
import {
	createIpcServer,
	generateSocketPath,
	type IpcServer,
	type ToolCallRequest,
	type ToolCallResponse,
	type CaptureStashRequest,
	type ToolResultContent,
} from "./ipc.js";

export type ToolResult = { content: ToolResultContent; isError?: boolean };

/** A tool definition the router advertises to the shim for this spawn. */
export type ToolDef = {
	/** Fully-qualified MCP name, e.g. `mcp__custom-tools__read`. */
	name: string;
	description?: string;
	/** JSON Schema for the tool's arguments (passed to the shim). */
	inputSchema?: Record<string, unknown>;
};

/** Minimal logger shape (pino-compatible); defaults to a no-op. */
export type RouterLogger = {
	debug: (...a: any[]) => void;
	info: (...a: any[]) => void;
	warn: (...a: any[]) => void;
	error: (...a: any[]) => void;
};

const NOOP_LOG: RouterLogger = {
	debug() {},
	info() {},
	warn() {},
	error() {},
};

/** Metadata recorded for each parked call (UX correlation per D32). */
export type ParkedCallInfo = {
	/** The router-minted pi-facing id (the resolver/result key). */
	piId: string;
	/** The shim-side JSON-RPC request id (for logging/trace). */
	shimRequestId: string;
	name: string;
	arguments: Record<string, unknown>;
	/** Canonicalized arguments for name+args matching (D32 UX correlation). */
	argsKey: string;
};

export type RouterOptions = {
	/** Socket path to listen on. Defaults to a unique-per-spawn path (D20). */
	socketPath?: string;
	logger?: RouterLogger;
	/** Mint a pi-facing id for a parked call. Overridable for deterministic tests. */
	mintPiId?: () => string;
};

export type Router = {
	readonly socketPath: string;
	/** Tools advertised to the shim for this spawn (read by the bridge for --mcp-config). */
	readonly toolDefs: ToolDef[];
	/** Mirrors index.ts: resolver fns keyed by the minted pi-facing id. */
	readonly pendingResolvers: Map<string, (result: ToolResult) => void>;
	/** Mirrors index.ts: results that arrived before a parked call was registered. */
	readonly pendingResults: Map<string, ToolResult>;

	/** Begin listening on the IPC socket. */
	start: () => Promise<void>;
	/** Declare the tools this spawn exposes (the bridge reads them for --mcp-config). */
	declareTools: (defs: ToolDef[]) => void;
	/**
	 * Deliver a pi tool result for a previously-parked call (the bridge calls
	 * this from streamSimple()). Resolves the parked Promise; if the call has
	 * not been parked yet (early result race), stashes it in pendingResults.
	 */
	deliver: (piToolResultId: string, result: ToolResult) => void;
	/** Read the validated capture args stashed by the shim (capture path, D21). */
	getCaptureStash: () => Record<string, unknown> | undefined;
	/** Inspect currently-parked calls (UX correlation + tests). */
	listParkedCalls: () => ParkedCallInfo[];
	/** Close the IPC server and drop all connections. */
	stop: () => Promise<void>;
};

/** Stable canonical serialization of args for name+args matching (D32). */
function canonicalizeArgs(args: Record<string, unknown>): string {
	const sortDeep = (v: any): any => {
		if (Array.isArray(v)) return v.map(sortDeep);
		if (v && typeof v === "object") {
			const out: Record<string, any> = {};
			for (const k of Object.keys(v).sort()) out[k] = sortDeep(v[k]);
			return out;
		}
		return v;
	};
	return JSON.stringify(sortDeep(args ?? {}));
}

export function createRouter(opts: RouterOptions = {}): Router {
	const log = opts.logger ?? NOOP_LOG;
	const socketPath = opts.socketPath ?? generateSocketPath();
	const mintPiId = opts.mintPiId ?? (() => `pi-${randomBytes(8).toString("hex")}`);

	let toolDefs: ToolDef[] = [];
	const pendingResolvers = new Map<string, (result: ToolResult) => void>();
	const pendingResults = new Map<string, ToolResult>();
	const parked = new Map<string, ParkedCallInfo>(); // keyed by piId
	let captureStash: Record<string, unknown> | undefined;

	const onToolCall = async (req: ToolCallRequest): Promise<ToolCallResponse> => {
		const piId = mintPiId();
		const argsKey = canonicalizeArgs(req.arguments);

		// Serialization-invariant assertion (D32): warn, do not throw — the
		// minted-id keying keeps calls disjoint regardless of name+args overlap.
		for (const p of parked.values()) {
			if (p.name === req.name && p.argsKey === argsKey) {
				log.warn(
					{ name: req.name, piId, existingPiId: p.piId },
					"router: two outstanding parked calls share (name, args); minted ids keep them disjoint (D32)",
				);
				break;
			}
		}

		parked.set(piId, {
			piId,
			shimRequestId: req.id,
			name: req.name,
			arguments: req.arguments,
			argsKey,
		});
		log.debug({ name: req.name, piId, shimRequestId: req.id }, "router: parked tools/call");

		const result = await new Promise<ToolResult>((resolve) => {
			// Early-result race: pi delivered before the shim's call was parked.
			const early = pendingResults.get(piId);
			if (early) {
				pendingResults.delete(piId);
				resolve(early);
				return;
			}
			pendingResolvers.set(piId, resolve);
		});

		parked.delete(piId);
		pendingResolvers.delete(piId);
		return {
			kind: "tools/call:response",
			id: req.id,
			content: result.content,
			isError: result.isError,
		};
	};

	const onCaptureStash = (req: CaptureStashRequest): void => {
		// First valid capture wins (D21). The shim already enforces this (a
		// second valid call gets -32603 and is not stashed), so any stash that
		// reaches here is authoritative; we keep the first defensively.
		if (captureStash !== undefined) {
			log.warn({ id: req.id }, "router: capture-stash arrived after a stash already exists; keeping first");
			return;
		}
		captureStash = req.arguments;
		log.debug({ id: req.id }, "router: capture args stashed");
	};

	const ipc: IpcServer = createIpcServer(socketPath, { onToolCall, onCaptureStash });

	return {
		socketPath,
		get toolDefs() {
			return toolDefs;
		},
		pendingResolvers,
		pendingResults,
		start: () => ipc.listen(),
		declareTools: (defs) => {
			toolDefs = defs.slice();
		},
		deliver: (piToolResultId, result) => {
			const resolve = pendingResolvers.get(piToolResultId);
			if (resolve) {
				pendingResolvers.delete(piToolResultId);
				resolve(result);
				return;
			}
			// Result arrived before the call was parked (or after teardown):
			// stash so the parking path can pick it up (mirrors index.ts).
			pendingResults.set(piToolResultId, result);
			log.debug({ piToolResultId }, "router: deliver before park — stashed in pendingResults");
		},
		getCaptureStash: () => captureStash,
		listParkedCalls: () => Array.from(parked.values()),
		stop: () => ipc.close(),
	};
}
