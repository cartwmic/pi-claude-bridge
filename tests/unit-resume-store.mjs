#!/usr/bin/env node
// Unit tests for the warm-pi-resume content-free sidecar store
// (src/resume-store.ts), covering change `enable-warm-pi-resume`:
//
//   - warm-pi-resume.resume-sidecar-persisted-on-successful-turn
//       write/read round-trip of { claudeSessionId, piSessionId,
//       historyHashChain, claudeVersion } — NO lastNumTurns, NO spawnCwd.
//   - warm-pi-resume.sidecar-stores-no-conversation-content
//       the persisted chain is an opaque one-way sha256 digest, NOT the
//       in-memory hashMessage value; the serialized sidecar contains NO
//       substring of any input message (sentinel fixture, Principle I).
//   - warm-pi-resume.warm-path-performs-no-new-claude-config-access
//       the resolved sidecar path is under ~/.pi/agent/, never ~/.claude/.
//   - key derivation: the LITERAL cwd (NOT realpath) — a symlink-alias path and
//       its real target map to DISTINCT keys (claude fragments transcripts by
//       literal cwd; --resume cannot cross it, C1); the FULL sessionId — two ids
//       sharing an 8-char prefix get DISTINCT keys (C3b; getPiSessionId truncates).
//   - corrupt/torn/malformed file -> null; atomic (temp+rename) write; prune
//       on read drops over-TTL files (Risk R5).
//
// Isolation: CLAUDE_BRIDGE_RESUME_DIR points the store at a fresh mkdtemp dir per
// case; nothing under the real ~/.pi or ~/.claude is touched.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, utimesSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

import {
	computeSha256Chain,
	deriveResumeKey,
	resumeStoreDir,
	readSidecar,
	writeSidecar,
	invalidateSidecar,
} from "../src/resume-store.js";

let dir;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pcb-resume-test-"));
	process.env.CLAUDE_BRIDGE_RESUME_DIR = dir;
	delete process.env.CLAUDE_BRIDGE_RESUME_TTL_MS;
	delete process.env.CLAUDE_BRIDGE_RESUME_MAX;
});
afterEach(() => {
	delete process.env.CLAUDE_BRIDGE_RESUME_DIR;
	delete process.env.CLAUDE_BRIDGE_RESUME_TTL_MS;
	delete process.env.CLAUDE_BRIDGE_RESUME_MAX;
	try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const CWD = "/Volumes/Workshop/git/pi-claude-bridge";
const SID = "0123abcd-1111-2222-3333-444455556666";

function sidecarFixture(extra = {}) {
	return {
		claudeSessionId: "cccccccc-0000-0000-0000-000000000000",
		piSessionId: SID,
		historyHashChain: computeSha256Chain([
			{ role: "user", text: "hello" },
			{ role: "assistant", text: "hi there" },
		]),
		claudeVersion: "2.1.159",
		...extra,
	};
}

describe("resume-store: round-trip persistence (resume-sidecar-persisted-on-successful-turn)", () => {
	it("writeSidecar then readSidecar returns an equal record", () => {
		const sc = sidecarFixture();
		writeSidecar(CWD, SID, sc);
		const got = readSidecar(CWD, SID);
		assert.deepEqual(got, sc, "round-trip preserves the sidecar");
	});

	it("readSidecar returns null when no sidecar exists for the key", () => {
		assert.equal(readSidecar(CWD, SID), null);
	});

	it("does NOT persist lastNumTurns or spawnCwd (schema is content-free fingerprints only)", () => {
		writeSidecar(CWD, SID, sidecarFixture());
		const file = join(resumeStoreDir(), `${deriveResumeKey(CWD, SID)}.json`);
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		assert.deepEqual(
			Object.keys(parsed).sort(),
			["claudeSessionId", "claudeVersion", "historyHashChain", "piSessionId"],
			"only the four content-free fields are persisted",
		);
		assert.ok(!("lastNumTurns" in parsed), "no lastNumTurns");
		assert.ok(!("spawnCwd" in parsed), "no spawnCwd");
	});

	it("invalidateSidecar deletes the sidecar so a later read cold-starts", () => {
		writeSidecar(CWD, SID, sidecarFixture());
		assert.ok(readSidecar(CWD, SID), "present before invalidate");
		invalidateSidecar(CWD, SID);
		assert.equal(readSidecar(CWD, SID), null, "gone after invalidate");
	});

	it("invalidateSidecar on a missing key does not throw", () => {
		assert.doesNotThrow(() => invalidateSidecar(CWD, SID));
	});
});

describe("resume-store: content-free (sidecar-stores-no-conversation-content)", () => {
	it("the persisted file contains NO substring of any message (sentinel fixture)", () => {
		const SENTINEL = "ZZZ-SECRET-CONVERSATION-CONTENT-9F2A";
		const messages = [
			{ role: "user", text: `please remember the passphrase ${SENTINEL} for later` },
			{ role: "assistant", text: `noted, ${SENTINEL} is stored` },
		];
		writeSidecar(CWD, SID, {
			claudeSessionId: "cccccccc-0000-0000-0000-000000000000",
			piSessionId: SID,
			historyHashChain: computeSha256Chain(messages),
			claudeVersion: "2.1.159",
		});
		const raw = readFileSync(join(resumeStoreDir(), `${deriveResumeKey(CWD, SID)}.json`), "utf8");
		assert.ok(!raw.includes(SENTINEL), "sentinel/message plaintext MUST NOT appear in the sidecar");
		assert.ok(!raw.includes("passphrase"), "no message-body words appear");
	});

	it("computeSha256Chain emits opaque 64-hex digests, NOT hashMessage role:len:content", () => {
		const chain = computeSha256Chain([{ role: "user", text: "hello world content" }]);
		assert.equal(chain.length, 1);
		assert.match(chain[0], /^[0-9a-f]{64}$/, "a sha256 hex digest");
		assert.ok(!chain[0].includes("hello"), "no plaintext in the digest");
		assert.ok(!chain[0].includes("user:"), "not the hashMessage role:len:content shape");
	});

	it("computeSha256Chain is a prefix-extension: a longer history shares the same prefix digests", () => {
		const base = [{ role: "user", text: "a" }, { role: "assistant", text: "b" }];
		const extended = [...base, { role: "user", text: "c" }];
		const cBase = computeSha256Chain(base);
		const cExt = computeSha256Chain(extended);
		assert.deepEqual(cExt.slice(0, cBase.length), cBase, "prefix digests are stable across growth");
	});
});

describe("resume-store: location (warm-path-performs-no-new-claude-config-access)", () => {
	it("default store dir is under ~/.pi/agent/, never ~/.claude/", () => {
		delete process.env.CLAUDE_BRIDGE_RESUME_DIR;
		const d = resumeStoreDir();
		assert.ok(d.startsWith(join(homedir(), ".pi", "agent")), `under ~/.pi/agent (got ${d})`);
		assert.ok(!d.includes(".claude"), "never under ~/.claude");
		process.env.CLAUDE_BRIDGE_RESUME_DIR = dir;
	});

	it("the resolved sidecar path is under the store dir", () => {
		const file = join(resumeStoreDir(), `${deriveResumeKey(CWD, SID)}.json`);
		assert.ok(file.startsWith(resumeStoreDir()));
		assert.ok(!file.includes(".claude"));
	});
});

describe("resume-store: key derivation (literal cwd, full sessionId)", () => {
	it("a symlink-alias cwd and its real target map to DISTINCT keys (NO realpath)", () => {
		const aliasCwd = "/Users/cartwmic/git/pi-claude-bridge"; // symlink alias of CWD
		assert.notEqual(deriveResumeKey(aliasCwd, SID), deriveResumeKey(CWD, SID));
		// behavioral: writing under the real path is NOT found under the alias path
		writeSidecar(CWD, SID, sidecarFixture());
		assert.equal(readSidecar(aliasCwd, SID), null, "warm-resume misses across the literal-cwd alias");
	});

	it("two sessionIds sharing an 8-char prefix map to DISTINCT keys (FULL id, not truncated)", () => {
		const idA = "0123abcd-aaaa-bbbb-cccc-dddddddddddd";
		const idB = "0123abcd-eeee-ffff-0000-111111111111"; // same first 8 chars "0123abcd"
		assert.equal(idA.slice(0, 8), idB.slice(0, 8), "precondition: shared 8-char prefix");
		assert.notEqual(deriveResumeKey(CWD, idA), deriveResumeKey(CWD, idB));
		writeSidecar(CWD, idA, sidecarFixture({ piSessionId: idA }));
		assert.equal(readSidecar(CWD, idB), null, "no collision on the 8-char prefix");
	});
});

describe("resume-store: corrupt / torn / malformed -> null", () => {
	it("torn (invalid JSON) file -> null", () => {
		writeSidecar(CWD, SID, sidecarFixture());
		const file = join(resumeStoreDir(), `${deriveResumeKey(CWD, SID)}.json`);
		writeFileSync(file, '{"claudeSessionId": "abc", "historyHa'); // truncated write
		assert.equal(readSidecar(CWD, SID), null);
	});

	it("valid JSON but wrong shape -> null", () => {
		const file = join(resumeStoreDir(), `${deriveResumeKey(CWD, SID)}.json`);
		writeFileSync(file, JSON.stringify({ foo: "bar", historyHashChain: "not-an-array" }));
		assert.equal(readSidecar(CWD, SID), null);
	});

	it("atomic write leaves no .tmp file lingering and yields valid JSON", () => {
		writeSidecar(CWD, SID, sidecarFixture());
		const files = readdirSync(resumeStoreDir());
		assert.ok(files.every((f) => !f.includes(".tmp")), "no temp file remains after atomic rename");
		const file = join(resumeStoreDir(), `${deriveResumeKey(CWD, SID)}.json`);
		assert.doesNotThrow(() => JSON.parse(readFileSync(file, "utf8")), "final file is valid JSON");
	});
});

describe("resume-store: prune-on-read (Risk R5)", () => {
	it("readSidecar drops sidecars older than the TTL", () => {
		process.env.CLAUDE_BRIDGE_RESUME_TTL_MS = "1000";
		// A stale sidecar for some OTHER key.
		const otherId = "9999ffff-1111-2222-3333-444455556666";
		writeSidecar(CWD, otherId, sidecarFixture({ piSessionId: otherId }));
		const staleFile = join(resumeStoreDir(), `${deriveResumeKey(CWD, otherId)}.json`);
		const oldSecs = Date.now() / 1000 - 3600; // 1 hour ago, well past the 1s TTL
		utimesSync(staleFile, oldSecs, oldSecs);
		// A fresh sidecar + a read triggers prune-on-read.
		writeSidecar(CWD, SID, sidecarFixture());
		assert.ok(readSidecar(CWD, SID), "fresh sidecar still readable");
		assert.ok(!existsSync(staleFile), "stale sidecar pruned on read");
	});

	it("readSidecar enforces a max count cap, dropping the oldest", () => {
		process.env.CLAUDE_BRIDGE_RESUME_MAX = "2";
		const ids = ["aaaa1111-0000-0000-0000-000000000000", "bbbb2222-0000-0000-0000-000000000000", "cccc3333-0000-0000-0000-000000000000"];
		ids.forEach((id, i) => {
			writeSidecar(CWD, id, sidecarFixture({ piSessionId: id }));
			const f = join(resumeStoreDir(), `${deriveResumeKey(CWD, id)}.json`);
			const t = Date.now() / 1000 - (ids.length - i) * 100; // ascending mtime: ids[0] oldest
			utimesSync(f, t, t);
		});
		// A read triggers prune; cap=2 keeps the 2 newest.
		readSidecar(CWD, ids[2]);
		const remaining = readdirSync(resumeStoreDir()).filter((f) => f.endsWith(".json"));
		assert.equal(remaining.length, 2, "cap enforced");
		assert.ok(!existsSync(join(resumeStoreDir(), `${deriveResumeKey(CWD, ids[0])}.json`)), "oldest dropped");
	});
});
