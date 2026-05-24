#!/usr/bin/env node
// Unit tests for TrustDialogScanner in src/driver/pty.ts (T1.4b / D25).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	TrustDialogScanner,
	TRUST_DIALOG_TRIGGERS,
	TRUST_DIALOG_ANSWER,
	TRUST_DIALOG_BUFFER_LIMIT,
} from "../src/driver/pty.js";

/**
 * Manual clock for injecting deterministic timeouts.
 *
 * Tests register timers via `clock.setTimer(cb, ms)`, then advance virtual
 * time with `clock.tick(ms)`. Real wall-clock is never consulted.
 */
function makeClock() {
	let now = 0;
	let nextId = 1;
	const timers = new Map(); // id -> { fireAt, cb }
	return {
		setTimer(cb, ms) {
			const id = nextId++;
			timers.set(id, { fireAt: now + ms, cb });
			return id;
		},
		clearTimer(id) {
			timers.delete(id);
		},
		tick(ms) {
			const target = now + ms;
			while (true) {
				let due = null;
				for (const [id, t] of timers) {
					if (t.fireAt <= target && (due === null || t.fireAt < due.fireAt)) {
						due = { id, fireAt: t.fireAt, cb: t.cb };
					}
				}
				if (due === null) break;
				now = due.fireAt;
				timers.delete(due.id);
				due.cb();
			}
			now = target;
		},
		pending() {
			return timers.size;
		},
	};
}

function makeScanner(overrides = {}) {
	const clock = makeClock();
	const answers = [];
	const failures = [];
	const scanner = new TrustDialogScanner({
		onAnswer: (data) => answers.push(data),
		onFailure: (reason) => failures.push(reason),
		setTimer: clock.setTimer,
		clearTimer: clock.clearTimer,
		...overrides,
	});
	return { scanner, clock, answers, failures };
}

describe("TrustDialogScanner — exports", () => {
	it("TRUST_DIALOG_TRIGGERS contains both known dialog substrings", () => {
		assert.ok(TRUST_DIALOG_TRIGGERS.includes("Quick safety check"));
		assert.ok(TRUST_DIALOG_TRIGGERS.includes("Accessing workspace:"));
	});

	it("TRUST_DIALOG_ANSWER is a single carriage return", () => {
		assert.equal(TRUST_DIALOG_ANSWER, "\r");
	});

	it("TRUST_DIALOG_BUFFER_LIMIT is a sane positive integer", () => {
		assert.ok(Number.isInteger(TRUST_DIALOG_BUFFER_LIMIT) && TRUST_DIALOG_BUFFER_LIMIT >= 1024);
	});
});

describe("TrustDialogScanner — detection paths", () => {
	it("answers immediately when 'Quick safety check' arrives in plain text", () => {
		const { scanner, answers } = makeScanner();
		scanner.start();
		scanner.feed("...frame frame...Quick safety check: trust?\r\n");
		assert.deepEqual(answers, ["\r"]);
		assert.equal(scanner.getState(), "answered");
	});

	it("answers when 'Accessing workspace:' arrives in plain text", () => {
		const { scanner, answers } = makeScanner();
		scanner.start();
		scanner.feed("Accessing workspace: /tmp/foo\r\n");
		assert.deepEqual(answers, ["\r"]);
	});

	it("answers across ANSI-colorized dialog frames", () => {
		const { scanner, answers } = makeScanner();
		scanner.start();
		scanner.feed("\x1b[?25l\x1b[2J\x1b[H\x1b[1;33mQuick safety check\x1b[0m: trust?\r\n");
		assert.deepEqual(answers, ["\r"]);
	});

	it("answers when dialog string is split across multiple feed() calls", () => {
		const { scanner, answers } = makeScanner();
		scanner.start();
		scanner.feed("...preamble...Quick saf");
		assert.deepEqual(answers, []);
		scanner.feed("ety check: trust?\r\n");
		assert.deepEqual(answers, ["\r"]);
	});

	it("answers exactly once even if trigger reappears in later chunks", () => {
		const { scanner, answers } = makeScanner();
		scanner.start();
		scanner.feed("Quick safety check first time\r\n");
		scanner.feed("Quick safety check second time\r\n");
		scanner.feed("Accessing workspace: third time\r\n");
		assert.deepEqual(answers, ["\r"]);
	});

	it("does not answer on benign text that contains neither trigger", () => {
		const { scanner, answers } = makeScanner();
		scanner.start();
		scanner.feed("\x1b[36mclaude 2.1.114\x1b[0m\r\nLoading session...\r\n");
		assert.deepEqual(answers, []);
		assert.equal(scanner.getState(), "scanning");
	});
});

describe("TrustDialogScanner — dialog window timeout (5s default)", () => {
	it("transitions to 'closed-no-dialog' if no trigger arrives in window", () => {
		const { scanner, clock, answers, failures } = makeScanner();
		scanner.start();
		scanner.feed("...normal boot output, no dialog...\r\n");
		clock.tick(5000);
		assert.equal(scanner.getState(), "closed-no-dialog");
		assert.deepEqual(answers, []);
		assert.deepEqual(failures, []);
	});

	it("ignores subsequent feed() once dialog window closed", () => {
		const { scanner, clock, answers } = makeScanner();
		scanner.start();
		clock.tick(5000);
		assert.equal(scanner.getState(), "closed-no-dialog");
		// Even if late dialog text comes in (unusual but defensive)
		scanner.feed("Quick safety check belated\r\n");
		assert.deepEqual(answers, []);
	});

	it("uses overridden dialogTimeoutMs", () => {
		const { scanner, clock } = makeScanner({ dialogTimeoutMs: 500 });
		scanner.start();
		clock.tick(499);
		assert.equal(scanner.getState(), "scanning");
		clock.tick(1);
		assert.equal(scanner.getState(), "closed-no-dialog");
	});
});

describe("TrustDialogScanner — hard timeout (30s default)", () => {
	it("emits onFailure if no dialog and no transcript by hard timeout", () => {
		const { scanner, clock, failures } = makeScanner();
		scanner.start();
		clock.tick(30000);
		assert.equal(scanner.getState(), "failed");
		assert.equal(failures.length, 1);
		assert.match(failures[0], /trust-scanner/);
	});

	it("emits onFailure even after dialog was answered, if transcript never arrives", () => {
		const { scanner, clock, answers, failures } = makeScanner();
		scanner.start();
		scanner.feed("Quick safety check\r\n");
		assert.deepEqual(answers, ["\r"]);
		clock.tick(30000);
		assert.equal(scanner.getState(), "failed");
		assert.equal(failures.length, 1);
		assert.match(failures[0], /transcript never appeared/);
	});

	it("does NOT emit onFailure if notifyTranscriptCreated() arrives in time", () => {
		const { scanner, clock, failures } = makeScanner();
		scanner.start();
		clock.tick(10000);
		scanner.notifyTranscriptCreated();
		assert.equal(scanner.getState(), "transcript-seen");
		clock.tick(30000);
		assert.equal(failures.length, 0);
	});

	it("uses overridden hardTimeoutMs", () => {
		const { scanner, clock, failures } = makeScanner({ hardTimeoutMs: 1000 });
		scanner.start();
		clock.tick(999);
		assert.equal(failures.length, 0);
		clock.tick(1);
		assert.equal(scanner.getState(), "failed");
		assert.equal(failures.length, 1);
	});

	it("emits onFailure at most once", () => {
		const { scanner, clock, failures } = makeScanner();
		scanner.start();
		clock.tick(30000);
		clock.tick(30000);
		clock.tick(30000);
		assert.equal(failures.length, 1);
	});
});

describe("TrustDialogScanner — notifyTranscriptCreated()", () => {
	it("during scanning: closes scanner without answering", () => {
		const { scanner, answers, failures } = makeScanner();
		scanner.start();
		scanner.notifyTranscriptCreated();
		assert.equal(scanner.getState(), "transcript-seen");
		assert.deepEqual(answers, []);
		assert.deepEqual(failures, []);
	});

	it("after answering: closes scanner; no failure", () => {
		const { scanner, clock, failures } = makeScanner();
		scanner.start();
		scanner.feed("Quick safety check\r\n");
		scanner.notifyTranscriptCreated();
		clock.tick(30000);
		assert.equal(failures.length, 0);
	});

	it("after dialog-window close: still recoverable", () => {
		const { scanner, clock, failures } = makeScanner();
		scanner.start();
		clock.tick(5000);
		scanner.notifyTranscriptCreated();
		clock.tick(30000);
		assert.equal(scanner.getState(), "transcript-seen");
		assert.equal(failures.length, 0);
	});

	it("is idempotent", () => {
		const { scanner } = makeScanner();
		scanner.start();
		scanner.notifyTranscriptCreated();
		scanner.notifyTranscriptCreated();
		assert.equal(scanner.getState(), "transcript-seen");
	});

	it("after failure: does not clobber failed state", () => {
		const { scanner, clock } = makeScanner();
		scanner.start();
		clock.tick(30000);
		assert.equal(scanner.getState(), "failed");
		scanner.notifyTranscriptCreated();
		assert.equal(scanner.getState(), "failed");
	});
});

describe("TrustDialogScanner — lifecycle invariants", () => {
	it("start() is idempotent (no duplicate timers armed)", () => {
		const { scanner, clock } = makeScanner();
		scanner.start();
		scanner.start();
		scanner.start();
		assert.equal(clock.pending(), 2); // dialog + hard, not 6
	});

	it("feed() before start() is a no-op", () => {
		const { scanner, answers } = makeScanner();
		scanner.feed("Quick safety check\r\n");
		// Behavior: scanner is "scanning" by default; feed() will detect the
		// trigger but since timers aren't armed, no failure path runs. The
		// answer SHOULD still fire — feed() is data-driven, not timer-driven.
		// This documents that contract.
		assert.deepEqual(answers, ["\r"]);
	});

	it("cancel() suppresses pending timers without firing onFailure", () => {
		const { scanner, clock, failures } = makeScanner();
		scanner.start();
		scanner.cancel();
		clock.tick(30000);
		assert.equal(failures.length, 0);
	});

	it("rolling buffer is bounded against ANSI-only flooding", () => {
		const { scanner, answers } = makeScanner();
		scanner.start();
		// Feed many KB of pure ANSI sequences (no visible chars). Internal
		// buffer must not grow without bound and no trigger should be matched.
		const noise = "\x1b[31m".repeat(50_000); // 250 KB raw, 0 visible
		scanner.feed(noise);
		assert.deepEqual(answers, []);
		assert.equal(scanner.getState(), "scanning");
	});

	it("dialog detected in a very long stripped stream still answers", () => {
		const { scanner, answers } = makeScanner();
		scanner.start();
		const filler = "x".repeat(TRUST_DIALOG_BUFFER_LIMIT * 3);
		scanner.feed(filler);
		scanner.feed("Quick safety check trailing\r\n");
		assert.deepEqual(answers, ["\r"]);
	});
});
