#!/usr/bin/env node
// T4.11 — Trust-dialog scanner failure surface: PTY stream with neither
// dialog nor transcript fires onFailure within hard timeout (D25 / R18).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TrustDialogScanner } from "../src/driver/pty.js";

function makeClock() {
	let now = 0, next = 1;
	const timers = new Map();
	return {
		setTimer(cb, ms) { const id = next++; timers.set(id, { fireAt: now + ms, cb }); return id; },
		clearTimer(id) { timers.delete(id); },
		tick(ms) {
			const target = now + ms;
			while (true) {
				let due = null;
				for (const [id, t] of timers) if (t.fireAt <= target && (due === null || t.fireAt < due.fireAt)) due = { id, ...t };
				if (!due) break;
				now = due.fireAt; timers.delete(due.id); due.cb();
			}
			now = target;
		},
	};
}

describe("TrustDialogScanner — failure surface (T4.11 / D25)", () => {
	it("emits onFailure after hard timeout with neither dialog nor transcript", () => {
		const clock = makeClock();
		const failures = [];
		const sc = new TrustDialogScanner({
			onAnswer: () => { throw new Error("should not be called"); },
			onFailure: (msg) => failures.push(msg),
			dialogTimeoutMs: 100,
			hardTimeoutMs: 500,
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
		});
		sc.start();
		// Feed noise but no triggers
		sc.feed("\x1b[31msome boot output...\x1b[0m");
		clock.tick(100); // dialog window closes
		clock.tick(400); // hard timer fires
		assert.equal(sc.getState(), "failed");
		assert.equal(failures.length, 1);
		assert.match(failures[0], /elapsed/);
	});
});
