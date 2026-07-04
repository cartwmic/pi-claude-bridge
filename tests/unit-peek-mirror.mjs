// Unit tests: src/peek/mirror.ts — mirror-file lifecycle for the peek overlay.
// ACs under test:
//   claude-peek-overlay.mirror-files-confined-to-bridge-owned-storage
//   claude-peek-overlay.peek-follows-latest-main-turn-spawn-only
//   claude-peek-overlay.peek-failures-never-affect-the-inference-turn
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
	PEEK_DIR_ENV,
	KEEP_LAST_N,
	resolvePeekDir,
	mirrorPathFor,
	cleanupOldMirrors,
	prepareMirrorForSpawn,
	setCurrentMirror,
	getCurrentMirror,
	onCurrentMirrorChange,
} from "../src/peek/mirror.js";

describe("peek mirror lifecycle", () => {
	let dir;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "peek-mirror-test-"));
		setCurrentMirror(null);
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	// claude-peek-overlay.mirror-files-confined-to-bridge-owned-storage
	it("resolvePeekDir defaults under os.tmpdir(), never ~/.claude", () => {
		const d = resolvePeekDir({});
		assert.ok(d.startsWith(tmpdir()));
		assert.ok(!d.includes(`${sep}.claude${sep}`) && !d.endsWith(`${sep}.claude`));
	});

	it("resolvePeekDir honors the env override", () => {
		assert.equal(resolvePeekDir({ [PEEK_DIR_ENV]: "/x/peek" }), "/x/peek");
	});

	it("mirrorPathFor mints <sessionId>-<ts>.raw under the peek dir", () => {
		const p = mirrorPathFor("/x/peek", "abc123", 42);
		assert.equal(p, join("/x/peek", "abc123-42.raw"));
	});

	// claude-peek-overlay.mirror-files-confined-to-bridge-owned-storage (keep-last-N)
	it("cleanupOldMirrors retains the newest KEEP_LAST_N .raw files", () => {
		for (let i = 0; i < KEEP_LAST_N + 3; i++) {
			const p = join(dir, `s${i}-${i}.raw`);
			writeFileSync(p, "x");
			const t = new Date(2026, 0, 1 + i);
			utimesSync(p, t, t);
		}
		writeFileSync(join(dir, "unrelated.txt"), "keep me");
		cleanupOldMirrors(dir, KEEP_LAST_N);
		const raws = readdirSync(dir).filter((f) => f.endsWith(".raw")).sort();
		assert.equal(raws.length, KEEP_LAST_N);
		// newest (highest index) survive
		for (let i = 3; i < KEEP_LAST_N + 3; i++) assert.ok(raws.includes(`s${i}-${i}.raw`));
		assert.ok(readdirSync(dir).includes("unrelated.txt"));
	});

	it("cleanupOldMirrors on a missing dir is a non-fatal no-op", () => {
		assert.doesNotThrow(() => cleanupOldMirrors(join(dir, "nope"), KEEP_LAST_N));
	});

	// claude-peek-overlay.peek-follows-latest-main-turn-spawn-only
	it("prepareMirrorForSpawn mints a path, creates the dir, and publishes current", () => {
		const env = { [PEEK_DIR_ENV]: join(dir, "sub") };
		const p = prepareMirrorForSpawn("sess42", undefined, env);
		assert.ok(p, "expected a mirror path");
		assert.ok(p.startsWith(join(dir, "sub")));
		assert.ok(p.includes("sess42-"));
		assert.equal(getCurrentMirror(), p);
	});

	it("retarget notifies subscribers; unsubscribe stops notifications", () => {
		const seen = [];
		const off = onCurrentMirrorChange((p) => seen.push(p));
		setCurrentMirror("/a.raw");
		setCurrentMirror(null);
		off();
		setCurrentMirror("/b.raw");
		assert.deepEqual(seen, ["/a.raw", null]);
	});

	// claude-peek-overlay.peek-failures-never-affect-the-inference-turn
	it("prepareMirrorForSpawn returns undefined (never throws) on unusable dir", () => {
		const file = join(dir, "not-a-dir");
		writeFileSync(file, "x"); // mkdir over a file → EEXIST/ENOTDIR
		const warns = [];
		const log = { warn: (o, m) => warns.push(m ?? String(o)) };
		const p = prepareMirrorForSpawn("sess", log, { [PEEK_DIR_ENV]: join(file, "child") });
		assert.equal(p, undefined);
		assert.equal(warns.length, 1);
	});

	it("listener exceptions never propagate to the publisher (spawn path safety)", () => {
		const off = onCurrentMirrorChange(() => {
			throw new Error("boom");
		});
		assert.doesNotThrow(() => setCurrentMirror("/c.raw"));
		off();
	});
});
