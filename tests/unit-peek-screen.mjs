// Unit tests: src/peek/screen.ts + src/peek/follower.ts — peek screen model.
// ACs under test:
//   claude-peek-overlay.live-screen-during-main-provider-turn
//   claude-peek-overlay.explicit-idle-and-error-states
//   claude-peek-overlay.peek-failures-never-affect-the-inference-turn
//   claude-peek-overlay.fixed-session-geometry-rendering
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PeekScreen, PEEK_COLS, PEEK_ROWS, cropRow } from "../src/peek/screen.js";
import { MirrorFollower } from "../src/peek/follower.js";

const FIXTURE = new URL("./fixtures/peek-full-turn.raw", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("PeekScreen (claude-peek-overlay.fixed-session-geometry-rendering)", () => {
	it("replays the spike full-turn capture to a faithful final grid", async () => {
		const screen = new PeekScreen();
		await screen.feed(readFileSync(FIXTURE));
		const rows = screen.snapshotRows();
		const text = rows.join("\n");
		assert.equal(rows.length, PEEK_ROWS);
		// Known frame content from the captured turn (137*24 → 3288).
		assert.ok(text.includes("3288"), "final answer visible in grid");
		assert.ok(text.includes("Claude Code"), "welcome header visible in grid");
		screen.dispose();
	});

	it("mid-stream feed produces a coherent grid (incremental parsing)", async () => {
		const raw = readFileSync(FIXTURE);
		const screen = new PeekScreen();
		for (let i = 0; i < raw.length; i += 512) {
			await screen.feed(raw.subarray(i, Math.min(i + 512, raw.length)));
		}
		assert.ok(screen.snapshotRows().join("\n").includes("3288"));
		screen.dispose();
	});

	it("reset clears prior content (retarget semantics)", async () => {
		const screen = new PeekScreen();
		await screen.feed("HELLO-STALE-CONTENT");
		screen.reset();
		assert.ok(!screen.snapshotRows().join("\n").includes("HELLO-STALE-CONTENT"));
		screen.dispose();
	});

	it("cropRow crops to width with h-scroll offset; grid is 120 cols", () => {
		const row = "x".repeat(PEEK_COLS);
		assert.equal(cropRow(row, 40).length, 40);
		assert.equal(cropRow(row, 40, 100).length, PEEK_COLS - 100);
		assert.equal(cropRow(row, 0), "");
	});
});

describe("MirrorFollower states + coalescing", () => {
	it("idle → live → idle transitions on retarget (claude-peek-overlay.explicit-idle-and-error-states)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "peek-follow-"));
		const p = join(dir, "m.raw");
		writeFileSync(p, "hello");
		const states = [];
		const f = new MirrorFollower({ pollMs: 10, coalesceMs: 10, onState: (s) => states.push(s) });
		assert.equal(f.state, "idle");
		f.retarget(p);
		await sleep(60);
		assert.equal(f.state, "live");
		assert.ok(f.rows().join("\n").includes("hello"));
		f.retarget(null);
		assert.equal(f.state, "idle");
		assert.deepEqual(states, ["live", "idle"]);
		f.dispose();
		rmSync(dir, { recursive: true, force: true });
	});

	it("live-updates as the mirror grows (claude-peek-overlay.live-screen-during-main-provider-turn)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "peek-follow-"));
		const p = join(dir, "m.raw");
		writeFileSync(p, "first ");
		let frames = 0;
		const f = new MirrorFollower({ pollMs: 10, coalesceMs: 10, onFrame: () => frames++ });
		f.retarget(p);
		await sleep(50);
		appendFileSync(p, "second");
		await sleep(80);
		assert.ok(f.rows().join("\n").includes("first second"));
		assert.ok(frames >= 2, `expected ≥2 coalesced frames, got ${frames}`);
		f.dispose();
		rmSync(dir, { recursive: true, force: true });
	});

	it("coalesces bursts to the bounded rate", async () => {
		const dir = mkdtempSync(join(tmpdir(), "peek-follow-"));
		const p = join(dir, "m.raw");
		writeFileSync(p, "");
		let frames = 0;
		const f = new MirrorFollower({ pollMs: 5, coalesceMs: 100, onFrame: () => frames++ });
		f.retarget(p);
		for (let i = 0; i < 20; i++) {
			appendFileSync(p, `chunk${i} `);
			await sleep(10);
		}
		await sleep(150);
		// 20 appends over ~200ms with 100ms coalescing → far fewer notifications than appends.
		assert.ok(frames <= 5, `expected ≤5 coalesced frames for 20 bursts, got ${frames}`);
		assert.ok(frames >= 1);
		f.dispose();
		rmSync(dir, { recursive: true, force: true });
	});

	it("missing mirror file → explicit error state after the lazy-creation grace, no throw (claude-peek-overlay.peek-failures-never-affect-the-inference-turn)", async () => {
		const warns = [];
		const f = new MirrorFollower({ pollMs: 10, graceMs: 30, log: { warn: (o, m) => warns.push(m) } });
		assert.doesNotThrow(() => f.retarget("/nonexistent-peek-dir/m.raw"));
		await sleep(15);
		assert.equal(f.state, "live", "ENOENT tolerated during the grace window (claude-p creates the file lazily)");
		await sleep(60);
		assert.equal(f.state, "error");
		assert.equal(warns.length, 1);
		f.dispose();
	});

	it("mirror file appearing AFTER retarget goes live (claude-p lazy creation race)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "peek-follow-"));
		const p = join(dir, "late.raw");
		const f = new MirrorFollower({ pollMs: 10, coalesceMs: 10, graceMs: 5000 });
		f.retarget(p); // file does not exist yet
		await sleep(40);
		assert.equal(f.state, "live", "still live while waiting for lazy creation");
		writeFileSync(p, "late-content");
		await sleep(60);
		assert.ok(f.rows().join("\n").includes("late-content"), "content picked up after late creation");
		f.dispose();
		rmSync(dir, { recursive: true, force: true });
	});

	it("truncation under a live follow resets and replays (retry re-created the mirror; code-review r1)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "peek-follow-"));
		const p = join(dir, "m.raw");
		writeFileSync(p, "attempt-one content padding padding");
		const f = new MirrorFollower({ pollMs: 10, coalesceMs: 10 });
		f.retarget(p);
		await sleep(50);
		assert.ok(f.rows().join("\n").includes("attempt-one"));
		writeFileSync(p, "retry-two"); // truncate + rewrite (shorter than prior offset)
		await sleep(80);
		const text = f.rows().join("\n");
		assert.ok(text.includes("retry-two"), "follower replayed the truncated file");
		assert.ok(!text.includes("attempt-one"), "stale attempt content cleared");
		assert.equal(f.state, "live");
		f.dispose();
		rmSync(dir, { recursive: true, force: true });
	});

	it("forceError surfaces an external peek failure as the explicit error state (code-review r3)", () => {
		const warns = [];
		const states = [];
		const f = new MirrorFollower({ pollMs: 10, log: { warn: (o, m) => warns.push(m) }, onState: (s) => states.push(s) });
		f.forceError("mirror preparation failed");
		assert.equal(f.state, "error");
		assert.deepEqual(states, ["error"]);
		assert.equal(warns.length, 1);
		// recoverable: a later retarget goes live again
		f.retarget(null);
		assert.equal(f.state, "idle");
		f.dispose();
	});

	it("retarget replays the new file from byte 0", async () => {
		const dir = mkdtempSync(join(tmpdir(), "peek-follow-"));
		const a = join(dir, "a.raw");
		const b = join(dir, "b.raw");
		writeFileSync(a, "AAAA-ONLY");
		writeFileSync(b, "BBBB-ONLY");
		const f = new MirrorFollower({ pollMs: 10, coalesceMs: 10 });
		f.retarget(a);
		await sleep(50);
		assert.ok(f.rows().join("\n").includes("AAAA-ONLY"));
		f.retarget(b);
		await sleep(50);
		const text = f.rows().join("\n");
		assert.ok(text.includes("BBBB-ONLY"));
		assert.ok(!text.includes("AAAA-ONLY"), "old spawn content cleared on retarget");
		f.dispose();
		rmSync(dir, { recursive: true, force: true });
	});
});
