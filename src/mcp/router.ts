// src/mcp/router.ts
//
// In-process router for the shim↔bridge channel. One router instance per
// PTY frame. Receives IPC frames from the shim, dispatches:
//
//   - tool_call (main mode)    → emit `toolCall` event for the bridge stream
//                                 layer; park a Promise; resolve when
//                                 deliverToolResult(id, ...) is called.
//   - capture_stash (capture)   → store args; ack.
//   - hook_event                → emit `hookEvent`; deliver response via
//                                 deliverHookResponse(id, stdout).
//
// The router is mode-aware: spawned with `mode: "main" | "capture"` and the
// tool-call surface to advertise to the shim. The router IS the source of
// truth for "is this turn still alive" — abort tears it down, preserves
// pending state for late-tool-result coherence (D15).
//
// Lifecycle:
//   - new Router({ mode, tools })
//   - await router.listen()                 (binds unix socket)
//   - bridge passes `router.socketPath` to shim spawn
//   - bridge listens on router events
//   - on abort: router.preserveAndDetachFromPty()  (keep state; close socket)
//   - on completion: await router.close()
//
// State preservation per D15: pendingResolvers + pendingResults stay alive
// after `preserveAndDetachFromPty()` until cleared by the bridge.

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
	IpcServer,
	IpcPeer,
	type IpcFrame,
	type ToolCallFrame,
	type ToolResultFrame,
	type CaptureStashFrame,
	type CaptureStashAckFrame,
	type HookEventFrame,
	type HookResponseFrame,
	type HelloFrame,
} from "./ipc.js";

// --- Public types --------------------------------------------------------

export interface RouterToolDefinition {
	name: string;
	description?: string;
	inputSchema: unknown;
}

export interface RouterOptions {
	mode: "main" | "capture";
	/** Tools to advertise to the shim's `tools/list` response. */
	tools: RouterToolDefinition[];
	/** Pre-allocated socket path. If omitted, the router generates one. */
	socketPath: string;
	/** Tool-call timeout. After this elapses without deliverToolResult(),
	 *  the router resolves the call with an error frame. Default 5 minutes. */
	toolCallTimeoutMs?: number;
}

export interface PendingToolCall {
	id: string;
	name: string;
	arguments: unknown;
	resolve: (frame: ToolResultFrame) => void;
	timer: ReturnType<typeof setTimeout> | undefined;
}

export type ToolResultContent = ToolResultFrame["content"];

// --- Router implementation -----------------------------------------------

export class Router extends EventEmitter {
	private server: IpcServer;
	private mcpPeer: IpcPeer | undefined;
	private hookPeer: IpcPeer | undefined;
	/** Tool calls awaiting pi-side `tool_result` (main mode only). */
	public readonly pendingResolvers: Map<string, PendingToolCall> = new Map();
	/** Tool calls whose result arrived BEFORE the router could deliver them
	 *  (e.g. abort path; D15 preservation). Bridge drains these on next turn. */
	public readonly pendingResults: Map<string, ToolResultContent> = new Map();
	/** Latest stashed capture args (capture mode). */
	public capturedArgs: unknown | undefined;
	private closed = false;

	constructor(public readonly opts: RouterOptions) {
		super();
		this.server = new IpcServer(opts.socketPath);
	}

	async listen(): Promise<void> {
		this.server.on("connection", (peer) => {
			// Peer role discriminated by hello frame.
			const onFrame = (f: IpcFrame) => this.onFrame(peer, f);
			peer.on("frame", onFrame);
		});
		await this.server.listen();
	}

	private onFrame(peer: IpcPeer, frame: IpcFrame): void {
		if (this.closed) return;
		switch (frame.kind) {
			case "hello":
				this.handleHello(peer, frame);
				return;
			case "tool_call":
				this.handleToolCall(peer, frame);
				return;
			case "capture_stash":
				this.handleCaptureStash(peer, frame);
				return;
			case "hook_event":
				this.handleHookEvent(peer, frame);
				return;
			case "error":
				this.emit("ipc_error", frame);
				return;
			default:
				// tool_result / hook_response / capture_stash_ack should
				// never arrive at the router (router is the producer of those).
				this.emit("ipc_error", {
					kind: "error",
					code: "unexpected_frame",
					message: `router received unexpected frame kind: ${(frame as any).kind}`,
				});
		}
	}

	private handleHello(peer: IpcPeer, frame: HelloFrame): void {
		if (frame.role === "mcp") {
			this.mcpPeer = peer;
		} else {
			this.hookPeer = peer;
		}
		this.emit("hello", frame);
	}

	private handleToolCall(peer: IpcPeer, frame: ToolCallFrame): void {
		// Capture mode should never see a tool_call frame for the capture
		// tool (the shim answers locally and sends capture_stash). Any
		// tool_call in capture mode is treated as "unknown tool".
		if (this.opts.mode === "capture") {
			peer.send({
				kind: "tool_result",
				id: frame.id,
				content: [{ type: "text", text: "router: tool call rejected (capture mode)" }],
				isError: true,
			} satisfies ToolResultFrame);
			return;
		}
		const timeoutMs = this.opts.toolCallTimeoutMs ?? 300_000;
		const resolve = (result: ToolResultFrame) => {
			const entry = this.pendingResolvers.get(frame.id);
			if (!entry) return;
			if (entry.timer) clearTimeout(entry.timer);
			this.pendingResolvers.delete(frame.id);
			peer.send(result);
		};
		const timer = setTimeout(() => {
			if (this.pendingResolvers.has(frame.id)) {
				resolve({
					kind: "tool_result",
					id: frame.id,
					content: [{ type: "text", text: `router: tool call timeout after ${timeoutMs}ms` }],
					isError: true,
				});
			}
		}, timeoutMs);
		const entry: PendingToolCall = {
			id: frame.id,
			name: frame.name,
			arguments: frame.arguments,
			resolve,
			timer,
		};
		this.pendingResolvers.set(frame.id, entry);
		// Notify bridge stream layer; bridge eventually calls deliverToolResult.
		this.emit("toolCall", entry);
	}

	private handleCaptureStash(peer: IpcPeer, frame: CaptureStashFrame): void {
		if (this.opts.mode !== "capture") {
			peer.send({
				kind: "error",
				id: frame.id,
				code: "invalid_mode",
				message: "capture_stash received in non-capture router",
			});
			return;
		}
		// First-call-wins per D21.
		if (this.capturedArgs === undefined) {
			this.capturedArgs = frame.args;
		}
		peer.send({
			kind: "capture_stash_ack",
			id: frame.id,
		} satisfies CaptureStashAckFrame);
		this.emit("captureStash", frame.args);
	}

	private handleHookEvent(peer: IpcPeer, frame: HookEventFrame): void {
		const resolve = (stdout: string) => {
			peer.send({
				kind: "hook_response",
				id: frame.id,
				stdout,
			} satisfies HookResponseFrame);
		};
		this.emit("hookEvent", { event: frame.event, payload: frame.payload, resolve });
	}

	// --- Public API the bridge stream layer uses -------------------------

	/**
	 * Deliver a pi-side tool_result for a parked tool_call. Looks up the
	 * pending resolver and dispatches. If the resolver is gone (timed out
	 * already), stashes the result in pendingResults for next-turn replay.
	 */
	deliverToolResult(id: string, content: ToolResultContent, isError = false): void {
		const entry = this.pendingResolvers.get(id);
		if (entry) {
			entry.resolve({ kind: "tool_result", id, content, isError });
			return;
		}
		// Resolver gone — preserve for D15 replay.
		this.pendingResults.set(id, content);
	}

	/**
	 * Drain pending resolvers synthetically (used when pi sends a new user
	 * message before delivering an aborted-turn's tool_result; D15).
	 */
	drainPendingResolversSynthetic(text: string): void {
		for (const entry of this.pendingResolvers.values()) {
			if (entry.timer) clearTimeout(entry.timer);
			entry.resolve({
				kind: "tool_result",
				id: entry.id,
				content: [{ type: "text", text }],
				isError: false,
			});
		}
		this.pendingResolvers.clear();
	}

	/**
	 * D15: detach from PTY but keep router state alive for late-tool-result
	 * coherence. Closes the socket (peers disconnect) but does NOT clear
	 * pendingResolvers / pendingResults / capturedArgs.
	 */
	async preserveAndDetachFromPty(): Promise<void> {
		// Time out resolvers immediately so subsequent deliverToolResult
		// calls go to pendingResults instead of trying to write to a dead
		// socket.
		for (const entry of this.pendingResolvers.values()) {
			if (entry.timer) clearTimeout(entry.timer);
		}
		this.pendingResolvers.clear();
		await this.server.close();
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.drainPendingResolversSynthetic("router closed");
		await this.server.close();
	}

	/** Inspectors / accessors for tests + bridge. */
	get socketPath(): string {
		return this.opts.socketPath;
	}
	get mode(): "main" | "capture" {
		return this.opts.mode;
	}
}

/**
 * Helper: generate a unique tool-call id.
 */
export function generateCallId(): string {
	return randomUUID();
}
