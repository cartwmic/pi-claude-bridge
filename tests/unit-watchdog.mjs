#!/usr/bin/env node
// Unit tests for the held-round-aware idle watchdog (Layer 2 of the hung-turn
// fix) in index.ts: makeWatchdog().
//
// Invariants:
//   - poke() resets the idle countdown (frequent pokes never fire).
//   - silence for idleMs with NO tool parked → onWedge() fires.
//   - while a tool is parked (isHeldRound() true) it NEVER fires — it re-arms
//     and defers entirely to the tool's own (pi-enforced) timeout.
//   - after the held round ends (isHeldRound() flips false) it fires again.
//   - stop() halts it permanently.
//   - idleMs <= 0 disables it.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { __makeWatchdogForTests as makeWatchdog } from "../index.js";

const QUIET = { warn() {}, info() {}, error() {}, debug() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const IDLE = 30; // ms — small so tests are fast but well above scheduler jitter

describe("makeWatchdog — fires on silence with no tool parked", () => {
	it("onWedge fires once after idleMs of silence", async () => {
		let wedges = 0;
		const wd = makeWatchdog({ idleMs: IDLE, isHeldRound: () => false, onWedge: () => { wedges++; }, log: QUIET });
		wd.poke();
		await sleep(IDLE * 3);
		assert.ok(wedges >= 1, `expected a wedge after silence; got ${wedges}`);
		wd.stop();
	});
});

describe("makeWatchdog — poke resets the countdown", () => {
	it("frequent pokes keep it from firing", async () => {
		let wedges = 0;
		const wd = makeWatchdog({ idleMs: IDLE, isHeldRound: () => false, onWedge: () => { wedges++; }, log: QUIET });
		// Poke every IDLE/2 for ~3 windows — never let a full idle window elapse.
		for (let i = 0; i < 6; i++) { wd.poke(); await sleep(IDLE / 2); }
		assert.equal(wedges, 0, "frequent pokes must prevent any wedge");
		wd.stop();
	});
});

describe("makeWatchdog — held round defers entirely", () => {
	it("never fires while a tool is parked, even across many idle windows", async () => {
		let wedges = 0;
		let parked = true;
		const wd = makeWatchdog({ idleMs: IDLE, isHeldRound: () => parked, onWedge: () => { wedges++; }, log: QUIET });
		wd.poke();
		await sleep(IDLE * 4); // multiple windows elapse with NO pokes — but parked
		assert.equal(wedges, 0, "a parked (held) round must never be declared wedged");

		// Held round ends — now silence IS a wedge.
		parked = false;
		await sleep(IDLE * 3);
		assert.ok(wedges >= 1, "after the held round ends, silence fires the watchdog");
		wd.stop();
	});
});

describe("makeWatchdog — stop() halts it", () => {
	it("no wedge fires after stop()", async () => {
		let wedges = 0;
		const wd = makeWatchdog({ idleMs: IDLE, isHeldRound: () => false, onWedge: () => { wedges++; }, log: QUIET });
		wd.poke();
		wd.stop();
		await sleep(IDLE * 3);
		assert.equal(wedges, 0, "stop() must prevent any further wedge");
	});
});

describe("makeWatchdog — idleMs <= 0 disables", () => {
	it("never fires when idleMs is 0", async () => {
		let wedges = 0;
		const wd = makeWatchdog({ idleMs: 0, isHeldRound: () => false, onWedge: () => { wedges++; }, log: QUIET });
		wd.poke();
		await sleep(60);
		assert.equal(wedges, 0, "idleMs=0 disables the watchdog");
		wd.stop();
	});
});
