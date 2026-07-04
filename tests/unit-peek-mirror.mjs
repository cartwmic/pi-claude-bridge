// Unit tests: src/peek/mirror.ts — mirror-file lifecycle for the peek overlay.
// ACs under test:
//   claude-peek-overlay.mirror-files-confined-to-bridge-owned-storage
//   claude-peek-overlay.peek-follows-latest-main-turn-spawn-only
//   claude-peek-overlay.peek-failures-never-affect-the-inference-turn
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync, rmSync, utimesSync, mkdirSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
	publishMirrorError,
	hasCurrentMirrorError,
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

	// Constitution III guard (code-review r1): override under ~/.claude rejected.
	it("resolvePeekDir rejects an override under ~/.claude", () => {
		const warns = [];
		const log = { warn: (o, m) => warns.push(m) };
		const d = resolvePeekDir({ [PEEK_DIR_ENV]: join(homedir(), ".claude", "evil") }, log);
		assert.ok(d.startsWith(tmpdir()), "fell back to the bridge-owned default");
		assert.equal(warns.length, 1);
	});

	// Constitution III guard (code-review r2): SYMLINKED override into ~/.claude rejected.
	it("resolvePeekDir rejects a symlink override whose target is under ~/.claude", () => {
		const fakeHome = mkdtempSync(join(tmpdir(), "peek-home-"));
		const claudeTarget = join(fakeHome, ".claude", "sneaky");
		mkdirSync(claudeTarget, { recursive: true });
		const link = join(dir, "innocent-link");
		symlinkSync(claudeTarget, link);
		const warns = [];
		const log = { warn: (o, m) => warns.push(m) };
		const d = resolvePeekDir({ [PEEK_DIR_ENV]: link }, log, fakeHome);
		assert.ok(d.startsWith(tmpdir()) && !d.includes("sneaky"), "fell back to default, not the symlink target");
		assert.equal(warns.length, 1);
		// non-existing tail through the symlink is also caught (physicalPath walk)
		const warns2 = [];
		const d2 = resolvePeekDir({ [PEEK_DIR_ENV]: join(link, "deeper", "still") }, { warn: (o, m) => warns2.push(m) }, fakeHome);
		assert.ok(!d2.includes("sneaky"));
		assert.equal(warns2.length, 1);
		rmSync(fakeHome, { recursive: true, force: true });
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

	// code-review r1: after a spawn's (lazily created) file appears, at most
	// KEEP_LAST_N remain — prepareMirrorForSpawn trims to N-1 beforehand.
	it("prepareMirrorForSpawn leaves at most KEEP_LAST_N including the new file", () => {
		const env = { [PEEK_DIR_ENV]: dir };
		for (let i = 0; i < KEEP_LAST_N; i++) {
			const p = join(dir, `old${i}-${i}.raw`);
			writeFileSync(p, "x");
			const t = new Date(2026, 0, 1 + i);
			utimesSync(p, t, t);
		}
		const minted = prepareMirrorForSpawn("newsess", undefined, env);
		writeFileSync(minted, "lazy-created"); // simulate claude-p creating it
		const raws = readdirSync(dir).filter((f) => f.endsWith(".raw"));
		assert.ok(raws.length <= KEEP_LAST_N, `expected ≤${KEEP_LAST_N}, got ${raws.length}`);
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
	// + claude-peek-overlay.explicit-idle-and-error-states (code-review r3):
	// preparation failure publishes an explicit mirror-error to the overlay.
	it("prepareMirrorForSpawn returns undefined (never throws) on unusable dir and publishes error", () => {
		const file = join(dir, "not-a-dir");
		writeFileSync(file, "x"); // mkdir over a file → EEXIST/ENOTDIR
		const warns = [];
		const events = [];
		const off = onCurrentMirrorChange((p, err) => events.push([p, !!err]));
		const log = { warn: (o, m) => warns.push(m ?? String(o)) };
		const p = prepareMirrorForSpawn("sess", log, { [PEEK_DIR_ENV]: join(file, "child") });
		assert.equal(p, undefined);
		assert.equal(warns.length, 1);
		assert.deepEqual(events, [[null, true]], "mirror-error published to overlay listeners");
		assert.ok(hasCurrentMirrorError());
		// turn-end publish clears the error back to idle
		setCurrentMirror(null);
		assert.ok(!hasCurrentMirrorError());
		off();
	});

	// Constitution III is unconditional (code-review r4): even the tmpdir()
	// FALLBACK is guarded when TMPDIR points under ~/.claude.
	it("resolvePeekDir escalates to ~/.cache when the tmpdir fallback is under ~/.claude", () => {
		const fakeHome = mkdtempSync(join(tmpdir(), "peek-home-"));
		// Simulate TMPDIR under ~/.claude by symlinking a tmp-adjacent dir there:
		// easier deterministic route — fake home whose .claude CONTAINS tmpdir?
		// tmpdir() can't be faked per-call, so exercise the branch via a home that
		// makes the real tmpdir fall under <home>/.claude using a symlink.
		const claudeDir = join(fakeHome, ".claude");
		mkdirSync(claudeDir, { recursive: true });
		// point <home>/.claude/tmplink at the REAL tmpdir parent so that
		// physicalPath(tmpdir fallback) === physicalPath(<home>/.claude/tmplink/...)
		// — covered indirectly: instead assert the pure guard by calling with a
		// home equal to the tmpdir itself: fallback <tmpdir>/claude-bridge-peek
		// sits under <home>/.claude only when home/.claude === tmpdir — construct:
		const homeAtTmp = { home: fakeHome };
		void homeAtTmp;
		const warns = [];
		const log = { warn: (o, m) => warns.push(m) };
		// home := parent such that <home>/.claude == tmpdir() ⇒ fallback is inside it.
		const tmpAsClaudeHome = join(fakeHome, "root");
		mkdirSync(tmpAsClaudeHome, { recursive: true });
		symlinkSync(tmpdir(), join(tmpAsClaudeHome, ".claude"));
		const d = resolvePeekDir({}, log, tmpAsClaudeHome);
		assert.equal(d, join(tmpAsClaudeHome, ".cache", "claude-bridge-peek"));
		assert.equal(warns.length, 1);
		rmSync(fakeHome, { recursive: true, force: true });
	});

	it("publishMirrorError notifies with error flag; next setCurrentMirror clears it", () => {
		const events = [];
		const off = onCurrentMirrorChange((p, err) => events.push([p, !!err]));
		publishMirrorError();
		setCurrentMirror("/a.raw");
		assert.deepEqual(events, [[null, true], ["/a.raw", false]]);
		assert.ok(!hasCurrentMirrorError());
		off();
	});

	it("listener exceptions never propagate to the publisher (spawn path safety)", () => {
		const off = onCurrentMirrorChange(() => {
			throw new Error("boom");
		});
		assert.doesNotThrow(() => setCurrentMirror("/c.raw"));
		off();
	});
});
