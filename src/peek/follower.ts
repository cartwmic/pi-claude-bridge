// src/peek/follower.ts — mirror-file follower + peek state machine.
//
// Follows the current main-turn mirror file (poll-based tail; replay from
// byte 0 on retarget so the emulator converges to the exact screen — the
// mid-stream-join property proven in the spike), feeds a PeekScreen, and
// notifies the overlay with COALESCED frame updates.
//
// States (claude-peek-overlay.explicit-idle-and-error-states):
//   idle  — no active main-turn mirror (between turns / before first turn)
//   live  — following a mirror file
//   error — a peek-path failure occurred; explicit, never silent
//
// Failure isolation (claude-peek-overlay.peek-failures-never-affect-the-
// inference-turn): every fs/emulator touch is wrapped; errors become the
// `error` state + a log entry. Nothing here can throw into callers.

import { closeSync, openSync, readSync, statSync } from "fs";
import { PeekScreen } from "./screen.js";

export type PeekState = "idle" | "live" | "error";

export interface FollowerLogger {
	warn(obj: unknown, msg?: string): void;
}

export interface MirrorFollowerOptions {
	/** Poll interval for new bytes (ms). */
	pollMs?: number;
	/** Minimum interval between frame notifications (ms) — ≤20/s default. */
	coalesceMs?: number;
	/**
	 * ENOENT tolerance after retarget (ms). claude-p creates the mirror file
	 * LAZILY on the first PTY output chunk, so the path is published before
	 * the file exists — a missing file is EXPECTED for the first moments of a
	 * turn. Within the grace window (and before any bytes were read) ENOENT
	 * keeps polling; after it, ENOENT is a real failure → error state.
	 */
	graceMs?: number;
	log?: FollowerLogger;
	/** Called (coalesced) when the screen changed. */
	onFrame?: (rows: string[]) => void;
	/** Called on every state transition. */
	onState?: (state: PeekState) => void;
}

export class MirrorFollower {
	private screen = new PeekScreen();
	private path: string | null = null;
	private offset = 0;
	private timer: ReturnType<typeof setInterval> | undefined;
	private lastNotify = 0;
	private dirty = false;
	private notifyTimer: ReturnType<typeof setTimeout> | undefined;
	private stateValue: PeekState = "idle";
	private feeding = false;
	private readonly pollMs: number;
	private readonly coalesceMs: number;
	private readonly graceMs: number;
	private targetSince = 0;
	private readonly opts: MirrorFollowerOptions;
	private disposed = false;

	constructor(opts: MirrorFollowerOptions = {}) {
		this.opts = opts;
		this.pollMs = opts.pollMs ?? 100;
		this.coalesceMs = opts.coalesceMs ?? 50;
		this.graceMs = opts.graceMs ?? 10_000;
	}

	get state(): PeekState {
		return this.stateValue;
	}

	/** Current screen rows (always safe to call). */
	rows(): string[] {
		return this.screen.snapshotRows();
	}

	/**
	 * Follow a new mirror path (replay from byte 0), or null → idle.
	 * Never throws.
	 */
	retarget(path: string | null): void {
		if (this.disposed) return;
		this.stopPolling();
		this.path = path;
		this.offset = 0;
		this.targetSince = Date.now();
		this.screen.reset();
		if (path === null) {
			this.setState("idle");
			return;
		}
		this.setState("live");
		this.timer = setInterval(() => this.poll(), this.pollMs);
		this.poll(); // immediate first read (replay-from-0)
	}

	private poll(): void {
		if (this.disposed || this.feeding || this.path === null) return;
		let chunk: Buffer | null = null;
		try {
			const size = this.statSizeWithGrace();
			if (size === null) return; // lazily-created file not there yet (grace)
			if (size < this.offset) {
				// File TRUNCATED under us: a resilience retry re-created the same
				// mirror path (claude-p opens with truncate). Reset and replay from
				// byte 0 so the overlay follows the retry attempt instead of
				// freezing on a stale offset (code-review r1 finding).
				this.offset = 0;
				this.screen.reset();
				this.markDirty();
				return; // next poll reads from 0
			}
			if (size <= this.offset) return;
			const fd = openSync(this.path, "r");
			try {
				const len = size - this.offset;
				chunk = Buffer.alloc(len);
				const n = readSync(fd, chunk, 0, len, this.offset);
				chunk = chunk.subarray(0, n);
				this.offset += n;
			} finally {
				closeSync(fd);
			}
		} catch (err) {
			this.fail(err);
			return;
		}
		if (!chunk || chunk.length === 0) return;
		this.feeding = true;
		this.screen
			.feed(chunk)
			.then(() => {
				this.feeding = false;
				this.markDirty();
			})
			.catch((err) => {
				this.feeding = false;
				this.fail(err);
			});
	}

	/** Coalesced frame notification: at most one per coalesceMs. */
	private markDirty(): void {
		this.dirty = true;
		if (this.notifyTimer) return; // a flush is already scheduled
		const since = Date.now() - this.lastNotify;
		const wait = Math.max(0, this.coalesceMs - since);
		this.notifyTimer = setTimeout(() => {
			this.notifyTimer = undefined;
			if (!this.dirty || this.disposed) return;
			this.dirty = false;
			this.lastNotify = Date.now();
			try {
				this.opts.onFrame?.(this.rows());
			} catch {
				/* overlay errors never propagate */
			}
		}, wait);
	}

	/**
	 * Size of the target file, or null when ENOENT is still tolerable (lazy
	 * creation grace: no bytes read yet AND within graceMs of retarget).
	 * Throws for real failures (including post-grace ENOENT).
	 */
	private statSizeWithGrace(): number | null {
		try {
			return statSync(this.path!).size;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException)?.code;
			if (code === "ENOENT" && this.offset === 0 && Date.now() - this.targetSince < this.graceMs) {
				return null;
			}
			throw err;
		}
	}

	/**
	 * Externally-reported peek failure (e.g. mirror preparation failed before
	 * any file existed): show the explicit error state without a file to
	 * follow (claude-peek-overlay.explicit-idle-and-error-states).
	 */
	forceError(reason: string): void {
		if (this.disposed) return;
		this.stopPolling();
		this.path = null;
		this.setState("error");
		this.opts.log?.warn({ reason }, "peek: external peek failure surfaced to overlay (non-fatal)");
	}

	private fail(err: unknown): void {
		this.stopPolling();
		this.setState("error");
		this.opts.log?.warn(
			{ err: err instanceof Error ? err.message : String(err), path: this.path },
			"peek: follower failure (non-fatal; overlay shows error state)",
		);
	}

	private setState(s: PeekState): void {
		if (this.stateValue === s) return;
		this.stateValue = s;
		try {
			this.opts.onState?.(s);
		} catch {
			/* overlay errors never propagate */
		}
	}

	private stopPolling(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	dispose(): void {
		this.disposed = true;
		this.stopPolling();
		if (this.notifyTimer) clearTimeout(this.notifyTimer);
		this.notifyTimer = undefined;
		this.screen.dispose();
	}
}
