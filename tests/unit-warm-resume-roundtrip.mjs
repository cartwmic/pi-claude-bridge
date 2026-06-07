#!/usr/bin/env node
// Composition test for the bridge's warm-resume seam: it exercises the exact
// store+gate flow index.ts performs across a restart, deterministically and
// without a real pi/claude:
//
//   turn N  (finalize): writeSidecar(cwd, sid, { chain over context.messages
//                       at turn start, claudeSessionId, version })
//   restart
//   turn N+1 (startFreshQuery): readSidecar(cwd, sid) -> validateWarmResume over
//                       pi's freshly-loaded history
//
// This guards against a mismatch between how the bridge computes the persisted
// chain (frame.sha256Chain at turn start, over context.messages) and how the
// gate validates it on resume — the one thing the separate store/gate unit tests
// can't catch on their own.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeSha256Chain, writeSidecar, readSidecar, validateWarmResume, invalidateSidecar } from "../src/resume-store.js";

const CWD = "/Volumes/Workshop/git/pi-claude-bridge";
const SID = "0123abcd-1111-2222-3333-444455556666";
const VER = "2.1.159";

let dir;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pcb-warm-roundtrip-"));
	process.env.CLAUDE_BRIDGE_RESUME_DIR = dir;
});
afterEach(() => {
	delete process.env.CLAUDE_BRIDGE_RESUME_DIR;
	try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const U = (t) => ({ role: "user", text: t });
const A = (t) => ({ role: "assistant", text: t });
const TR = (t) => ({ role: "toolResult", text: t });

// Mirror the bridge: at turn start it stashes frame.sha256Chain over the messages
// it received, then persists that on a successful main-turn finalize.
function persistTurn(messagesAtTurnStart, claudeSessionId) {
	writeSidecar(CWD, SID, {
		claudeSessionId,
		piSessionId: SID,
		historyHashChain: computeSha256Chain(messagesAtTurnStart),
		claudeVersion: VER,
	});
}

// Mirror the bridge's first-post-resume decision.
function resumeDecision(loadedHistory, installedVersion = VER) {
	const sidecar = readSidecar(CWD, SID);
	return { sidecar, ...validateWarmResume({ sidecar, currentMessages: loadedHistory, currentClaudeVersion: installedVersion }) };
}

describe("warm-resume roundtrip: persist turn N -> resume turn N+1", () => {
	it("a clean single-turn session warm-resumes with the recorded session id", () => {
		persistTurn([U("q1")], "sess-aaaa");
		// restart; pi reloads [q1, r1, q2]
		const d = resumeDecision([U("q1"), A("r1"), U("q2")]);
		assert.equal(d.warm, true, "warm");
		assert.equal(d.sidecar.claudeSessionId, "sess-aaaa", "resumes the recorded claude session");
	});

	it("a multi-round tool turn then resume is warm (claude's own output is not a foreign turn)", () => {
		persistTurn([U("q1")], "sess-bbbb");
		const d = resumeDecision([U("q1"), A("call"), TR("out"), A("done"), U("q2")]);
		assert.equal(d.warm, true);
	});

	it("the second in-process turn re-persists; a later resume validates against the newest chain", () => {
		// turn 1 finalize
		persistTurn([U("q1")], "sess-1");
		// turn 2 starts with [q1, r1, q2]; bridge re-persists over THAT
		persistTurn([U("q1"), A("r1"), U("q2")], "sess-1");
		// restart; pi reloads [q1, r1, q2, r2, q3]
		const d = resumeDecision([U("q1"), A("r1"), U("q2"), A("r2"), U("q3")]);
		assert.equal(d.warm, true);
	});

	it("a cross-provider turn between persist and resume forces COLD (Risk R7)", () => {
		persistTurn([U("q1")], "sess-cccc");
		// user switched to another provider mid-session, then back
		const d = resumeDecision([U("q1"), A("r1"), U("ask-codex"), A("codex-said"), U("q2")]);
		assert.equal(d.warm, false);
		assert.equal(d.reason, "unseen-intervening-messages");
	});

	it("a /compact between sessions forces COLD (history divergence)", () => {
		persistTurn([U("q1"), A("r1"), U("q2")], "sess-dddd");
		// /compact rewrote the early history; position 0 changed
		const d = resumeDecision([U("[summary of q1..q2]"), U("q3")]);
		assert.equal(d.warm, false);
		assert.equal(d.reason, "history-divergence");
	});

	it("a claude upgrade between sessions forces COLD (version skew)", () => {
		persistTurn([U("q1")], "sess-eeee");
		const d = resumeDecision([U("q1"), A("r1"), U("q2")], "2.2.0");
		assert.equal(d.warm, false);
		assert.equal(d.reason, "version-skew");
	});

	it("a turn error invalidates the sidecar so the next resume cold-starts", () => {
		persistTurn([U("q1")], "sess-ffff");
		invalidateSidecar(CWD, SID); // D7 error path
		const d = resumeDecision([U("q1"), A("r1"), U("q2")]);
		assert.equal(d.warm, false);
		assert.equal(d.reason, "no-sidecar");
	});
});
