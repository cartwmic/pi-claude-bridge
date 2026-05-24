// src/mcp/ipc.ts
//
// Per-PTY unix-domain-socket transport for the shim↔router channel.
//
// Wire protocol (D20): newline-delimited JSON. Each line is one frame.
// Frame kinds:
//   - tool_call        (shim → router)
//   - tool_result      (router → shim)
//   - hook_event       (shim → router)
//   - hook_response    (router → shim)
//   - capture_stash    (shim → router)
//   - capture_stash_ack(router → shim)
//   - hello            (shim → router, on connect, declares mode + tool set)
//   - error            (either direction, for protocol-level errors)
//
// Path generation: socket lives under `os.tmpdir()` with a random component
// so multiple PTYs (or concurrent bridge instances) don't collide
// (R10 mitigation).

import { createServer, type Server, type Socket, connect } from "node:net";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync, existsSync } from "node:fs";
import { EventEmitter } from "node:events";

// --- Wire-protocol frame types -------------------------------------------

export type ToolCallFrame = {
	kind: "tool_call";
	id: string;
	name: string;
	arguments: unknown;
};
export type ToolResultFrame = {
	kind: "tool_result";
	id: string;
	content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
	isError: boolean;
};
export type HookEventFrame = {
	kind: "hook_event";
	id: string;
	event: "SessionStart" | "Stop";
	payload: Record<string, unknown>;
};
export type HookResponseFrame = {
	kind: "hook_response";
	id: string;
	stdout: string;
};
export type CaptureStashFrame = {
	kind: "capture_stash";
	id: string;
	args: unknown;
};
export type CaptureStashAckFrame = {
	kind: "capture_stash_ack";
	id: string;
};
export type HelloFrame = {
	kind: "hello";
	role: "mcp" | "hook";
	/** Shim-declared advertisable tools (mcp mode only). Empty for hook mode. */
	tools?: Array<{ name: string; description?: string; inputSchema: unknown }>;
};
export type ErrorFrame = {
	kind: "error";
	id?: string;
	code: string;
	message: string;
};

export type IpcFrame =
	| ToolCallFrame
	| ToolResultFrame
	| HookEventFrame
	| HookResponseFrame
	| CaptureStashFrame
	| CaptureStashAckFrame
	| HelloFrame
	| ErrorFrame;

// --- Path generation -----------------------------------------------------

/**
 * Generate a unique per-PTY socket path under os.tmpdir(). Includes a
 * random suffix so concurrent PTYs (and concurrent bridge instances) don't
 * collide.
 */
export function generateSocketPath(prefix = "pi-claude-bridge"): string {
	const r = randomBytes(8).toString("hex");
	return join(tmpdir(), `${prefix}-${r}.sock`);
}

// --- IpcServer (router-side) ---------------------------------------------

/**
 * Unix-socket server with newline-delimited JSON framing. The router uses
 * this to accept connections from shim subprocesses (one per role: mcp or
 * hook). Events:
 *
 *   - "connection"  → (peer: IpcPeer)
 *   - "frame"       → (peer: IpcPeer, frame: IpcFrame)
 *   - "close"       → ()  // server itself closed
 *   - "error"       → (err: Error)
 */
export class IpcServer extends EventEmitter {
	private server: Server | undefined;
	private peers: Set<IpcPeer> = new Set();

	constructor(public readonly socketPath: string) {
		super();
	}

	async listen(): Promise<void> {
		if (existsSync(this.socketPath)) {
			try { unlinkSync(this.socketPath); } catch {}
		}
		this.server = createServer((sock) => {
			const peer = new IpcPeer(sock);
			this.peers.add(peer);
			peer.on("frame", (f) => this.emit("frame", peer, f));
			peer.on("close", () => this.peers.delete(peer));
			peer.on("error", (e) => this.emit("error", e));
			this.emit("connection", peer);
		});
		await new Promise<void>((resolve, reject) => {
			this.server!.once("error", reject);
			this.server!.listen(this.socketPath, () => {
				this.server!.removeListener("error", reject);
				resolve();
			});
		});
		this.server.on("error", (e) => this.emit("error", e));
	}

	async close(): Promise<void> {
		for (const p of this.peers) p.destroy();
		this.peers.clear();
		if (this.server) {
			await new Promise<void>((resolve) => this.server!.close(() => resolve()));
			this.server = undefined;
		}
		if (existsSync(this.socketPath)) {
			try { unlinkSync(this.socketPath); } catch {}
		}
	}
}

// --- IpcPeer (per-connection) --------------------------------------------

/**
 * Wraps a single socket connection (server-side OR client-side) with
 * newline-delimited JSON framing. Buffers partial lines.
 */
export class IpcPeer extends EventEmitter {
	private buffer = "";
	private closed = false;

	constructor(private readonly sock: Socket) {
		super();
		sock.setEncoding("utf8");
		sock.on("data", (chunk: string) => this.onData(chunk));
		sock.on("close", () => this.onClose());
		sock.on("error", (err) => this.emit("error", err));
	}

	send(frame: IpcFrame): void {
		if (this.closed) return;
		this.sock.write(JSON.stringify(frame) + "\n");
	}

	destroy(): void {
		this.closed = true;
		try { this.sock.destroy(); } catch {}
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
		let idx;
		while ((idx = this.buffer.indexOf("\n")) !== -1) {
			const line = this.buffer.slice(0, idx);
			this.buffer = this.buffer.slice(idx + 1);
			if (!line.trim()) continue;
			let frame: IpcFrame;
			try {
				frame = JSON.parse(line);
			} catch {
				this.emit("error", new Error(`malformed IPC frame: ${line.slice(0, 200)}`));
				continue;
			}
			this.emit("frame", frame);
		}
	}

	private onClose(): void {
		this.closed = true;
		this.emit("close");
	}
}

// --- IpcClient (shim-side connect helper) --------------------------------

/**
 * Open a client socket to the router's IpcServer. Returns an IpcPeer once
 * connected.
 */
export function ipcConnect(socketPath: string, timeoutMs = 5000): Promise<IpcPeer> {
	return new Promise((resolve, reject) => {
		const sock = connect(socketPath);
		const timer = setTimeout(() => {
			sock.destroy();
			reject(new Error(`ipcConnect timeout after ${timeoutMs}ms: ${socketPath}`));
		}, timeoutMs);
		sock.once("connect", () => {
			clearTimeout(timer);
			resolve(new IpcPeer(sock));
		});
		sock.once("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}
