// src/mcp/ipc.ts
//
// Unix-domain-socket IPC transport shared by the MCP stdio shim (client side,
// a separate OS process spawned by `claude` via `--mcp-config`) and the
// bridge's in-process router (server side). The two halves speak a simple
// newline-delimited JSON protocol (design D20): each frame is
// `JSON.stringify(msg) + "\n"`. Partial reads are buffered until a full line
// arrives, and correlation ids match responses to in-flight requests without
// any ordering assumptions.
//
// This module owns ONLY the socket transport + framing + the shared message
// envelope TYPES. It has no knowledge of MCP, capture validation, or the
// promise-park — those live in shim.ts and router.ts respectively, which
// import the SAME envelope types from here so the wire contract cannot drift.

import { createServer, connect, type Server, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Wire envelope types (shared by shim + router)
// ---------------------------------------------------------------------------

/** Tool-result content shape (mirrors index.ts's MCP tool-result contract). */
export type ToolResultContent = { type: "text"; text: string }[];

/**
 * A `tools/call` forwarded from the shim to the router. `id` is the shim-side
 * request id (a uuid minted per call). The router parks a Promise keyed by its
 * own pi-facing id derived from this message (D32) and resolves it when pi
 * delivers the result.
 */
export type ToolCallRequest = {
	kind: "tools/call";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	/** Optional model id when upstream MCP metadata exposes it; resolver stays pi id. */
	modelToolUseId?: string;
};

/** The router's response to a parked `tools/call`. Returned to the shim verbatim. */
export type ToolCallResponse = {
	kind: "tools/call:response";
	id: string;
	content: ToolResultContent;
	isError?: boolean;
};

/**
 * Capture-mode stash: the shim validated the capture tool's args locally and
 * forwards them to the router for the bridge to read (D21). The shim does NOT
 * park on this — it answers `claude` deterministically itself.
 */
export type CaptureStashRequest = {
	kind: "capture-stash";
	id: string;
	arguments: Record<string, unknown>;
};

/** Router acknowledges a capture stash so the shim knows it landed. */
export type CaptureStashAck = {
	kind: "capture-stash:ack";
	id: string;
};

/** Bounded evidence that one capture call failed local schema validation. */
export type CaptureValidationFailedRequest = {
	kind: "capture-validation-failed";
	id: string;
	/** Monotonic within one shim spawn, starting at one. */
	attempt: number;
	/** Safe JSON-style path to the first failing field. */
	field: string;
	/** UTF-8-safe diagnostic, capped by the shim before transport. */
	message: string;
};

export type CaptureValidationFailedAck = {
	kind: "capture-validation-failed:ack";
	id: string;
};

/** Anything the shim sends to the router. */
export type IpcRequest = ToolCallRequest | CaptureStashRequest | CaptureValidationFailedRequest;
/** Anything the router sends back to the shim. */
export type IpcResponse = ToolCallResponse | CaptureStashAck | CaptureValidationFailedAck;
/** Union of every frame that can appear on the wire. */
export type IpcMessage = IpcRequest | IpcResponse;

// ---------------------------------------------------------------------------
// Newline-delimited JSON framing
// ---------------------------------------------------------------------------

/**
 * Buffers raw socket chunks and yields one parsed JSON object per complete
 * `\n`-terminated line. Robust to partial reads (a chunk may contain a partial
 * line, multiple lines, or split a line across chunks). Malformed lines invoke
 * `onParseError` rather than throwing, so one bad frame never kills the socket.
 */
export function createLineDecoder(
	onMessage: (msg: any) => void,
	onParseError?: (raw: string, err: unknown) => void,
): (chunk: Buffer | string) => void {
	let buf = "";
	return (chunk: Buffer | string) => {
		buf += chunk.toString("utf8");
		let nl: number;
		while ((nl = buf.indexOf("\n")) !== -1) {
			const line = buf.slice(0, nl);
			buf = buf.slice(nl + 1);
			if (line.length === 0) continue;
			try {
				onMessage(JSON.parse(line));
			} catch (err) {
				onParseError?.(line, err);
			}
		}
	};
}

/** Serialize a message to a single newline-delimited frame. */
export function encodeFrame(msg: IpcMessage): string {
	return JSON.stringify(msg) + "\n";
}

// ---------------------------------------------------------------------------
// Socket path generation (router/server side, D20)
// ---------------------------------------------------------------------------

/**
 * Generate a unique-per-spawn unix-socket path under the OS tmpdir. Uses
 * `crypto.randomBytes` so concurrent bridge spawns never collide (D20). The
 * router creates the listener at this path and passes it to the shim via argv.
 */
export function generateSocketPath(): string {
	return join(tmpdir(), `pi-claude-bridge-${randomBytes(12).toString("hex")}.sock`);
}

// ---------------------------------------------------------------------------
// Server half (router side)
// ---------------------------------------------------------------------------

export type IpcServerHandlers = {
	/** Called for each `tools/call` frame. Returns the response to send back. */
	onToolCall: (req: ToolCallRequest) => Promise<ToolCallResponse> | ToolCallResponse;
	/** Called for each `capture-stash` frame. Returns nothing; an ack is sent. */
	onCaptureStash: (req: CaptureStashRequest) => Promise<void> | void;
	/** Called for bounded capture validation evidence. */
	onCaptureValidationFailed?: (req: CaptureValidationFailedRequest) => Promise<void> | void;
};

export type IpcServer = {
	socketPath: string;
	/** Begin listening. Resolves once the socket is bound. */
	listen: () => Promise<void>;
	/** Close the listener and drop all connections. */
	close: () => Promise<void>;
	/** The underlying node net.Server (escape hatch for tests). */
	raw: Server;
};

/**
 * Create the router-side IPC server. A single shim connects per spawn, but the
 * server tolerates the connection arriving after `listen()` and dispatches each
 * decoded frame to the supplied handlers, writing responses back on the same
 * socket. Handler rejections are swallowed at the transport layer (the router
 * is responsible for shaping any error into a valid `IpcResponse`).
 */
export function createIpcServer(socketPath: string, handlers: IpcServerHandlers): IpcServer {
	const sockets = new Set<Socket>();

	const server = createServer((socket) => {
		sockets.add(socket);
		socket.setEncoding("utf8");
		const decode = createLineDecoder(
			async (msg: IpcRequest) => {
				try {
					if (msg.kind === "tools/call") {
						const res = await handlers.onToolCall(msg);
						socket.write(encodeFrame(res));
					} else if (msg.kind === "capture-stash") {
						await handlers.onCaptureStash(msg);
						const ack: CaptureStashAck = { kind: "capture-stash:ack", id: msg.id };
						socket.write(encodeFrame(ack));
					} else if (msg.kind === "capture-validation-failed") {
						await handlers.onCaptureValidationFailed?.(msg);
						const ack: CaptureValidationFailedAck = { kind: "capture-validation-failed:ack", id: msg.id };
						socket.write(encodeFrame(ack));
					}
				} catch {
					// Transport stays up; the router owns error shaping. A swallowed
					// handler throw simply means no response frame for that id, which
					// the shim's pending-request timeout (if any) would surface.
				}
			},
			() => {
				/* malformed IPC frame — ignore the line, keep the socket alive */
			},
		);
		socket.on("data", decode);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => sockets.delete(socket));
	});

	let closePromise: Promise<void> | undefined;
	return {
		socketPath,
		raw: server,
		listen: () =>
			new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(socketPath, () => {
					server.removeListener("error", reject);
					resolve();
				});
			}),
		close: () => {
			if (closePromise) return closePromise;
			closePromise = new Promise<void>((resolve) => {
				for (const s of sockets) s.destroy();
				sockets.clear();
				if (!server.listening) return resolve();
				server.close(() => resolve());
			});
			return closePromise;
		},
	};
}

// ---------------------------------------------------------------------------
// Client half (shim side)
// ---------------------------------------------------------------------------

export type IpcClient = {
	/** Send a request and await the correlated response frame. */
	request: (req: IpcRequest) => Promise<IpcResponse>;
	/** Register a callback for when the channel closes (shim teardown trigger). */
	onClose: (cb: () => void) => void;
	/** Close the client socket. */
	close: () => void;
	/** The underlying node socket (escape hatch for tests). */
	raw: Socket;
};

/**
 * Connect the shim-side IPC client to the router's socket. Resolves once the
 * connection is established. Outgoing requests are correlated to incoming
 * responses by `id`, so concurrent in-flight requests resolve independently.
 */
export function connectIpcClient(socketPath: string): Promise<IpcClient> {
	return new Promise((resolve, reject) => {
		const pending = new Map<string, (res: IpcResponse) => void>();
		const requests = new Map<string, { signature: string; promise: Promise<IpcResponse> }>();
		const closeCbs: Array<() => void> = [];

		const socket = connect(socketPath);
		socket.setEncoding("utf8");

		const decode = createLineDecoder((msg: IpcResponse) => {
			const r = pending.get(msg.id);
			if (r) {
				pending.delete(msg.id);
				r(msg);
			}
		});
		socket.on("data", decode);

		socket.once("error", reject);
		socket.on("close", () => {
			for (const cb of closeCbs) cb();
		});

		socket.once("connect", () => {
			socket.removeListener("error", reject);
			socket.on("error", () => {
				/* post-connect errors surface via 'close' */
			});
			resolve({
				raw: socket,
				request: (req: IpcRequest) => {
					const signature = JSON.stringify(req);
					const prior = requests.get(req.id);
					if (prior) {
						if (prior.signature !== signature) return Promise.reject(new Error(`IPC request id ${req.id} reused with different payload`));
						return prior.promise;
					}
					const promise = new Promise<IpcResponse>((resolveReq) => {
						pending.set(req.id, resolveReq);
						socket.write(encodeFrame(req));
					});
					requests.set(req.id, { signature, promise });
					return promise;
				},
				onClose: (cb) => closeCbs.push(cb),
				close: () => {
					if (!socket.destroyed) socket.destroy();
				},
			});
		});
	});
}
