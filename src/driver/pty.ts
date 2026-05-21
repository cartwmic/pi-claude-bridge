// src/driver/pty.ts
//
// PTY driver module. This file is built incrementally across two tasks:
//
//   - T1.4b (THIS commit): TrustDialogScanner per D25 — watches PTY output for
//     the workspace-trust dialog and auto-answers it. No node-pty dependency
//     yet; pure data-in / bytes-out / callback-out so it can be unit-tested
//     against synthetic streams.
//
//   - T1.4 (LATER): spawn / hook dispatch / SIGINT+grace abort / lifecycle.
//     Will import node-pty and wire the scanner to a real PTY's onData /
//     write methods.
//
// Keeping the scanner here (rather than in its own file) matches D25's
// architectural intent: the trust dialog is a property of the PTY-driven
// interactive-mode boot, and its handling belongs to the driver, not to a
// generic ANSI parser. The scanner depends on src/driver/ansi.ts for ANSI
// stripping; ansi.ts is the only piece that's both reusable and side-effect
// free.

import { stripAnsi } from "./ansi.js";

// ---------------------------------------------------------------------------
// TrustDialogScanner (D25)
// ---------------------------------------------------------------------------

/**
 * Substrings whose presence in ANSI-stripped PTY output indicates the
 * interactive `claude` workspace-trust dialog is on screen.
 *
 * Both are present in real fixtures (`.spike-notes/14-liveness.md`); we match
 * EITHER because the Ink renderer may paint them on separate lines and we
 * could see one before the other depending on frame timing.
 */
export const TRUST_DIALOG_TRIGGERS: readonly string[] = Object.freeze([
	"Quick safety check",
	"Accessing workspace:",
]);

/** Keystroke sent to dismiss the dialog. `\r` accepts the default option. */
export const TRUST_DIALOG_ANSWER = "\r";

/**
 * Upper bound on the rolling stripped-buffer kept while scanning. Generous
 * enough that no realistic dialog frame is split, small enough that the
 * substring search stays O(constant). Each new chunk re-strips the buffer
 * tail, so the limit applies to STRIPPED bytes, not raw PTY bytes.
 */
export const TRUST_DIALOG_BUFFER_LIMIT = 4096;

/** Default windows (from T1.4b spec). */
export const TRUST_DIALOG_DEFAULT_DIALOG_TIMEOUT_MS = 5000;
export const TRUST_DIALOG_DEFAULT_HARD_TIMEOUT_MS = 30000;

export type TrustDialogScannerState =
	| "scanning" // started, watching for dialog
	| "answered" // dialog detected, \r sent, waiting for transcript
	| "closed-no-dialog" // dialog window elapsed without detection (cwd was trusted)
	| "transcript-seen" // transcript file appeared (external notification) — success
	| "failed"; // hard timeout: no dialog AND no transcript

export interface TrustDialogScannerOptions {
	/** Bytes to write to the PTY when the dialog is detected. */
	onAnswer: (data: string) => void;

	/**
	 * Called once if the scanner reaches a definitive failure state
	 * (no dialog detected AND no transcript event within hardTimeoutMs).
	 */
	onFailure: (reason: string) => void;

	/** Window during which the dialog must appear. Default: 5000ms. */
	dialogTimeoutMs?: number;

	/** Overall liveness window. Default: 30000ms. */
	hardTimeoutMs?: number;

	// --- Injectables for tests (default to real timers when omitted) ---
	setTimer?: (cb: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
}

type TimerHandle = unknown;

/**
 * State machine that consumes PTY output bytes and answers the workspace-trust
 * dialog when it appears.
 *
 * Lifecycle:
 *   1. `new TrustDialogScanner({...}).start()` arms two timers.
 *   2. `feed(chunk)` is called for every PTY data event. The scanner strips
 *      ANSI, appends to a rolling buffer, and checks for trigger substrings.
 *   3. On match: invokes `onAnswer(TRUST_DIALOG_ANSWER)`, state → "answered",
 *      dialog timer cleared. Hard watchdog continues until transcript event.
 *   4. If dialog window elapses with no match: state → "closed-no-dialog"
 *      (cwd was already trusted; no keystroke sent). Hard watchdog still runs.
 *   5. `notifyTranscriptCreated()` (called externally by the transcript
 *      tailer) closes the scanner successfully: state → "transcript-seen",
 *      hard watchdog cleared.
 *   6. If hard watchdog fires before transcript event: state → "failed",
 *      `onFailure(reason)` invoked.
 *
 * All callbacks fire AT MOST ONCE. State transitions are monotonic — once
 * "answered", "transcript-seen", or "failed", further feed() / notify() /
 * timer events are no-ops.
 */
export class TrustDialogScanner {
	private state: TrustDialogScannerState = "scanning";
	private buffer = "";
	private dialogTimer: TimerHandle = undefined;
	private hardTimer: TimerHandle = undefined;
	private started = false;
	private readonly dialogTimeoutMs: number;
	private readonly hardTimeoutMs: number;
	private readonly setTimerFn: NonNullable<TrustDialogScannerOptions["setTimer"]>;
	private readonly clearTimerFn: NonNullable<TrustDialogScannerOptions["clearTimer"]>;

	constructor(private readonly opts: TrustDialogScannerOptions) {
		this.dialogTimeoutMs = opts.dialogTimeoutMs ?? TRUST_DIALOG_DEFAULT_DIALOG_TIMEOUT_MS;
		this.hardTimeoutMs = opts.hardTimeoutMs ?? TRUST_DIALOG_DEFAULT_HARD_TIMEOUT_MS;
		this.setTimerFn =
			opts.setTimer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
		this.clearTimerFn =
			opts.clearTimer ??
			((h: TimerHandle) => clearTimeout(h as ReturnType<typeof setTimeout>));
	}

	/** Arm the dialog window and the hard watchdog. Idempotent. */
	start(): void {
		if (this.started) return;
		this.started = true;
		this.dialogTimer = this.setTimerFn(() => this.onDialogWindowElapsed(), this.dialogTimeoutMs);
		this.hardTimer = this.setTimerFn(() => this.onHardTimeoutElapsed(), this.hardTimeoutMs);
	}

	/** Consume a chunk of raw PTY output. */
	feed(chunk: string): void {
		if (this.state !== "scanning") return;
		this.buffer += chunk;
		// Strip first, then bound. We bound the stripped buffer (not the raw
		// buffer) because that's what substring search runs against; an
		// adversarial stream of pure ANSI escapes could otherwise inflate the
		// raw buffer without ever advancing visible content.
		let stripped = stripAnsi(this.buffer);
		if (stripped.length > TRUST_DIALOG_BUFFER_LIMIT) {
			stripped = stripped.slice(-TRUST_DIALOG_BUFFER_LIMIT);
		}
		this.buffer = stripped;
		for (const trigger of TRUST_DIALOG_TRIGGERS) {
			if (stripped.includes(trigger)) {
				this.answer();
				return;
			}
		}
	}

	/**
	 * External notification: the transcript file appeared, so the dialog was
	 * either already accepted (cwd was trusted) or the answer we sent took
	 * effect. Either way, the scanner is done and the hard watchdog should
	 * be cancelled.
	 */
	notifyTranscriptCreated(): void {
		if (this.state === "failed" || this.state === "transcript-seen") return;
		this.state = "transcript-seen";
		this.clearAllTimers();
	}

	/** Inspector for tests / observability. */
	getState(): TrustDialogScannerState {
		return this.state;
	}

	/**
	 * Abandon scanning without recording a failure. For use by the driver
	 * when it tears down the PTY for unrelated reasons (e.g. user-initiated
	 * abort). Cancels timers; no callbacks fire.
	 */
	cancel(): void {
		if (this.state === "failed" || this.state === "transcript-seen") return;
		this.state = "transcript-seen"; // treat as "closed cleanly"
		this.clearAllTimers();
	}

	// --- Internal -----------------------------------------------------------

	private answer(): void {
		this.state = "answered";
		// Dialog window no longer relevant; the hard watchdog stays armed
		// because we still need the transcript event to confirm liveness.
		if (this.dialogTimer !== undefined) {
			this.clearTimerFn(this.dialogTimer);
			this.dialogTimer = undefined;
		}
		try {
			this.opts.onAnswer(TRUST_DIALOG_ANSWER);
		} catch {
			// Swallow callback errors — the driver's job to handle write
			// failures is downstream of the scanner.
		}
		// Buffer no longer needed for matching.
		this.buffer = "";
	}

	private onDialogWindowElapsed(): void {
		this.dialogTimer = undefined;
		if (this.state === "scanning") {
			this.state = "closed-no-dialog";
			this.buffer = "";
		}
	}

	private onHardTimeoutElapsed(): void {
		this.hardTimer = undefined;
		if (this.state === "transcript-seen" || this.state === "failed") return;
		// We reach failure ONLY if the transcript never appeared. Note that
		// "answered" + no transcript is also a failure — the dialog was
		// dismissed but `claude` never actually started; same surface.
		const reason =
			this.state === "answered"
				? `trust-scanner: ${this.hardTimeoutMs}ms elapsed; dialog was answered but transcript never appeared`
				: this.state === "closed-no-dialog"
					? `trust-scanner: ${this.hardTimeoutMs}ms elapsed; no dialog detected and transcript never appeared`
					: `trust-scanner: ${this.hardTimeoutMs}ms elapsed with neither dialog detection nor transcript creation`;
		this.state = "failed";
		this.clearAllTimers();
		try {
			this.opts.onFailure(reason);
		} catch {
			// As above — callback errors are not the scanner's problem.
		}
	}

	private clearAllTimers(): void {
		if (this.dialogTimer !== undefined) {
			this.clearTimerFn(this.dialogTimer);
			this.dialogTimer = undefined;
		}
		if (this.hardTimer !== undefined) {
			this.clearTimerFn(this.hardTimer);
			this.hardTimer = undefined;
		}
	}
}
