#!/usr/bin/env node
// Unit tests for the claude-p runtime version-skew check (task T4.7) in
// src/driver/claudeP.ts: checkClaudePVersionsOnce().
//
// The check runs on the FIRST spawn, cached once per process, and warns (via the
// structured logger) when the observed `claude` CLI version or `claude-p` package
// version differs from the README-pinned tested range (claude 2.1.159,
// claude-p 0.1.0). It is an observability guard, not a gate — a skew never blocks.
//
// HARD CONSTRAINT exercised here (spec "MUST NOT fail to load if either binary is
// absent"): importing the module must not throw even when the real binaries are
// missing, and the version check itself must not throw when its readers return
// null (a missing/unreadable binary collapses to null — surfaced as a real error
// at first TURN by the spawn ENOENT path, NOT a load-time crash).
//
// Isolation: the readers are INJECTED, so no real `claude`/`claude-p` is spawned.
// __resetVersionCheckForTests() clears the process-wide cached-once guard between
// cases so each case starts from a clean slate. The cases run serially.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// The import below is the load-time-safety assertion: if module evaluation read a
// binary eagerly (and one were missing), THIS import would throw and the suite
// would never start. It must succeed regardless of whether claude/claude-p exist.
import {
	checkClaudePVersionsOnce,
	__resetVersionCheckForTests,
	TESTED_CLAUDE_VERSION,
	TESTED_CLAUDE_P_VERSION,
	EXPECTED_CLAUDE_P_PATCH,
} from "../src/driver/claudeP.js";

// ── helpers ────────────────────────────────────────────────────────────────────

/** A logger stub that records every warn() call's structured fields + message. */
function recordingLogger() {
	const warns = [];
	return {
		warns,
		warn(fields, msg) {
			warns.push({ fields, msg });
		},
		info() {},
		error() {},
	};
}

/** Build an injectable VersionReaders from fixed return values. Patch defaults to
 *  the expected fork marker so version-skew cases don't also trip the patch warn. */
function readers(claude, claudeP, patch = EXPECTED_CLAUDE_P_PATCH) {
	return {
		readClaudeVersion: () => claude,
		readClaudePVersion: () => claudeP,
		readClaudePPatch: () => patch,
	};
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("checkClaudePVersionsOnce (T4.7 runtime version-skew check)", () => {
	it("does NOT warn when both versions are exactly the pinned tested range", () => {
		__resetVersionCheckForTests();
		const log = recordingLogger();
		const observed = checkClaudePVersionsOnce(
			log,
			readers(TESTED_CLAUDE_VERSION, TESTED_CLAUDE_P_VERSION),
		);
		assert.deepEqual(observed, {
			claude: TESTED_CLAUDE_VERSION,
			claudeP: TESTED_CLAUDE_P_VERSION,
			claudePPatch: EXPECTED_CLAUDE_P_PATCH,
		});
		assert.equal(log.warns.length, 0, "in-range versions + patched fork must not warn");
	});

	it("warns once when the claude CLI version is skewed", () => {
		__resetVersionCheckForTests();
		const log = recordingLogger();
		checkClaudePVersionsOnce(log, readers("2.2.0", TESTED_CLAUDE_P_VERSION));
		assert.equal(log.warns.length, 1, "a skewed claude version must warn");
		const w = log.warns[0];
		assert.equal(w.fields.event, "claudeP.version.skew");
		assert.equal(w.fields.claude.observed, "2.2.0");
		assert.equal(w.fields.claude.tested, TESTED_CLAUDE_VERSION);
		assert.equal(w.fields.claude.skew, true);
		assert.equal(w.fields.claudeP.skew, false, "claude-p in range → not flagged skewed");
		assert.match(w.msg, /outside its tested version range/);
	});

	it("warns when the claude-p package version is skewed", () => {
		__resetVersionCheckForTests();
		const log = recordingLogger();
		checkClaudePVersionsOnce(log, readers(TESTED_CLAUDE_VERSION, "0.2.0"));
		assert.equal(log.warns.length, 1);
		assert.equal(log.warns[0].fields.claudeP.observed, "0.2.0");
		assert.equal(log.warns[0].fields.claudeP.skew, true);
		assert.equal(log.warns[0].fields.claude.skew, false);
	});

	it("warns when BOTH versions are skewed (single combined warn)", () => {
		__resetVersionCheckForTests();
		const log = recordingLogger();
		checkClaudePVersionsOnce(log, readers("9.9.9", "9.9.9"));
		assert.equal(log.warns.length, 1, "skew is reported in a single combined warn");
		assert.equal(log.warns[0].fields.claude.skew, true);
		assert.equal(log.warns[0].fields.claudeP.skew, true);
	});

	it("is cached-once: a second call does no work and returns null", () => {
		__resetVersionCheckForTests();
		const log = recordingLogger();
		const first = checkClaudePVersionsOnce(log, readers("9.9.9", "9.9.9"));
		assert.notEqual(first, null, "first call returns the observed versions");
		assert.equal(log.warns.length, 1);

		// A second call — even with a DIFFERENT skewed reader — must be a no-op.
		const log2 = recordingLogger();
		const second = checkClaudePVersionsOnce(log2, readers("8.8.8", "8.8.8"));
		assert.equal(second, null, "second call returns null (already ran this process)");
		assert.equal(log2.warns.length, 0, "cached-once: no second warn");
	});

	it("does NOT warn (and does not throw) when a reader returns null — missing/unreadable binary", () => {
		__resetVersionCheckForTests();
		const log = recordingLogger();
		// null = couldn't read. A missing binary becomes a real error at first TURN
		// (the spawn ENOENT path), NOT a skew warning here, and NOT a throw.
		const observed = checkClaudePVersionsOnce(log, readers(null, null));
		assert.deepEqual(observed, { claude: null, claudeP: null, claudePPatch: EXPECTED_CLAUDE_P_PATCH });
		assert.equal(log.warns.length, 0, "null versions must not be treated as skew");
	});

	it("treats one-null / one-skewed independently (null is not skew; the read one is)", () => {
		__resetVersionCheckForTests();
		const log = recordingLogger();
		checkClaudePVersionsOnce(log, readers(null, "0.2.0"));
		assert.equal(log.warns.length, 1);
		assert.equal(log.warns[0].fields.claude.observed, null);
		assert.equal(log.warns[0].fields.claude.skew, false, "null claude → not skew");
		assert.equal(log.warns[0].fields.claudeP.skew, true, "read+different claude-p → skew");
	});

	it("does not throw when given no logger (defaults to a silent noop)", () => {
		__resetVersionCheckForTests();
		// Skewed readers + undefined logger must still not throw.
		assert.doesNotThrow(() => checkClaudePVersionsOnce(undefined, readers("9.9.9", "9.9.9")));
	});

	it("default readers do not throw even if the real binaries are absent", () => {
		__resetVersionCheckForTests();
		const log = recordingLogger();
		// No injected readers → the DEFAULT real probes run (execFileSync claude
		// --version + require claude-p/package.json). On this machine claude-p is a
		// dep so it reads 0.1.0; claude may or may not be present. EITHER WAY the
		// call must not throw — that is the load-safety guarantee.
		assert.doesNotThrow(() => {
			const observed = checkClaudePVersionsOnce(log);
			// Whatever it observed, each field is a string or null (never undefined,
			// never a throw bubbling up from a missing binary).
			assert.ok(observed === null || typeof observed === "object");
			if (observed) {
				assert.ok(observed.claude === null || typeof observed.claude === "string");
				assert.ok(observed.claudeP === null || typeof observed.claudeP === "string");
				assert.ok(observed.claudePPatch === null || typeof observed.claudePPatch === "string");
			}
		});
	});
});

// AC: claude-p-driver.driver-runs-the-patched-claude-p-binary — the bridge must be
// able to confirm the resolved binary carries the echo-confirm patch, and warn
// (not silently proceed) when it resolved STOCK upstream claude-p.
describe("patched-binary identity check (claude-p-driver.driver-runs-the-patched-claude-p-binary)", () => {
	it("does NOT warn when the expected fork patch marker is present", () => {
		__resetVersionCheckForTests();
		const log = recordingLogger();
		const observed = checkClaudePVersionsOnce(
			log,
			readers(TESTED_CLAUDE_VERSION, TESTED_CLAUDE_P_VERSION, EXPECTED_CLAUDE_P_PATCH),
		);
		assert.equal(observed.claudePPatch, EXPECTED_CLAUDE_P_PATCH);
		assert.equal(log.warns.length, 0, "the patched fork must not warn");
	});

	it("warns when the patch marker is ABSENT (stock upstream claude-p resolved)", () => {
		__resetVersionCheckForTests();
		const log = recordingLogger();
		checkClaudePVersionsOnce(log, readers(TESTED_CLAUDE_VERSION, TESTED_CLAUDE_P_VERSION, null));
		const patchWarns = log.warns.filter((w) => w.fields.event === "claudeP.patch.missing");
		assert.equal(patchWarns.length, 1, "a stock binary must trigger the patch-missing warn");
		assert.equal(patchWarns[0].fields.observed, null);
		assert.equal(patchWarns[0].fields.expected, EXPECTED_CLAUDE_P_PATCH);
		assert.match(patchWarns[0].msg, /NOT the expected patched fork/);
		assert.match(patchWarns[0].msg, /re-exposed/);
	});

	it("warns when the patch marker is a DIFFERENT/stale value", () => {
		__resetVersionCheckForTests();
		const log = recordingLogger();
		checkClaudePVersionsOnce(log, readers(TESTED_CLAUDE_VERSION, TESTED_CLAUDE_P_VERSION, "some-other-patch"));
		const patchWarns = log.warns.filter((w) => w.fields.event === "claudeP.patch.missing");
		assert.equal(patchWarns.length, 1);
		assert.equal(patchWarns[0].fields.observed, "some-other-patch");
	});

	it("patch-missing and version-skew warns co-occur independently (two warns)", () => {
		__resetVersionCheckForTests();
		const log = recordingLogger();
		checkClaudePVersionsOnce(log, readers("9.9.9", TESTED_CLAUDE_P_VERSION, null));
		const events = log.warns.map((w) => w.fields.event).sort();
		assert.deepEqual(events, ["claudeP.patch.missing", "claudeP.version.skew"]);
	});
});
