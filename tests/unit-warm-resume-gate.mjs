#!/usr/bin/env node
// Unit tests for the PURE pre-spawn warm/cold validation gate
// (validateWarmResume in src/resume-store.ts), covering:
//
//   - warm-pi-resume.validated-warm-resume-on-pi-resume
//   - warm-pi-resume.cold-start-when-validation-does-not-pass
//   - warm-pi-resume.cold-start-on-unreadable-or-malformed-sidecar
//   - warm-pi-resume.aborted-mid-tool-sessions-remain-resumable
//
// The gate is a pure function (no I/O, no spawn). There is NO staleness logic:
// the claude-p fork's transcript-growth gate guarantees a live --resume result,
// so the bridge has no staleSuspected input. The R7 invariant ("claude saw every
// prefix message; no unseen intervening turn") is enforced by requiring the
// segment appended beyond the recorded chain to contain exactly ONE user-role
// message (the new prompt), last — claude's own response is assistant/toolResult
// roles, a foreign provider turn injects an extra user message.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { computeSha256Chain, validateWarmResume } from "../src/resume-store.js";

const VERSION = "2.1.159";

function sidecarOver(messages, version = VERSION) {
	return {
		claudeSessionId: "cccccccc-0000-0000-0000-000000000000",
		piSessionId: "0123abcd-1111-2222-3333-444455556666",
		historyHashChain: computeSha256Chain(messages),
		claudeVersion: version,
	};
}

const U = (text) => ({ role: "user", text });
const A = (text) => ({ role: "assistant", text });
const TR = (text) => ({ role: "toolResult", text });

describe("warm-resume gate: warm (validated-warm-resume-on-pi-resume)", () => {
	it("prefix-extension + version match + only the new user turn appended -> warm", () => {
		const seen = [U("q1"), A("r1")];
		const current = [U("q1"), A("r1"), U("q2")]; // appended: [U q2]
		const d = validateWarmResume({ sidecar: sidecarOver(seen), currentMessages: current, currentClaudeVersion: VERSION });
		assert.deepEqual(d, { warm: true, reason: "ok" });
	});

	it("claude's own multi-round response (assistant+toolResult) then one new prompt -> warm", () => {
		const seen = [U("q1")];
		const current = [U("q1"), A("call"), TR("result"), A("answer"), U("q2")]; // appended has no foreign user
		const d = validateWarmResume({ sidecar: sidecarOver(seen), currentMessages: current, currentClaudeVersion: VERSION });
		assert.equal(d.warm, true);
	});
});

describe("warm-resume gate: aborted-mid-tool-sessions-remain-resumable (R7 requirement / D6)", () => {
	it("a dangling tool call in the recorded turn does NOT block warm resume", () => {
		const seen = [U("q1")];
		// prior turn aborted mid-tool: assistant tool call + (synthetic) toolResult, no foreign user
		const current = [U("q1"), A("partial tool call"), TR("[interrupted]"), U("q2")];
		const d = validateWarmResume({ sidecar: sidecarOver(seen), currentMessages: current, currentClaudeVersion: VERSION });
		assert.equal(d.warm, true, "dangling tool call is not a cold trigger");
	});
});

describe("warm-resume gate: unseen intervening messages force cold (Risk R7)", () => {
	it("a foreign provider turn between persist and resume -> cold", () => {
		const seen = [U("q1"), A("r1")];
		// user switched to another provider (foreign user+assistant) then back
		const current = [U("q1"), A("r1"), U("ask-codex"), A("codex-answer"), U("q2")];
		const d = validateWarmResume({ sidecar: sidecarOver(seen), currentMessages: current, currentClaudeVersion: VERSION });
		assert.deepEqual(d, { warm: false, reason: "unseen-intervening-messages" });
	});

	it("two new user messages appended (no claude turn between) -> cold", () => {
		const seen = [U("q1"), A("r1")];
		const current = [U("q1"), A("r1"), U("q2"), U("q3")];
		const d = validateWarmResume({ sidecar: sidecarOver(seen), currentMessages: current, currentClaudeVersion: VERSION });
		assert.equal(d.warm, false);
		assert.equal(d.reason, "unseen-intervening-messages");
	});
});

describe("warm-resume gate: cold-start-when-validation-does-not-pass", () => {
	it("no sidecar -> cold (normal turn)", () => {
		const d = validateWarmResume({ sidecar: null, currentMessages: [U("q1")], currentClaudeVersion: VERSION });
		assert.deepEqual(d, { warm: false, reason: "no-sidecar" });
	});

	it("history divergence (a prior position changed, e.g. /compact) -> cold", () => {
		const seen = [U("q1"), A("r1")];
		const current = [U("DIFFERENT q1"), A("r1"), U("q2")];
		const d = validateWarmResume({ sidecar: sidecarOver(seen), currentMessages: current, currentClaudeVersion: VERSION });
		assert.deepEqual(d, { warm: false, reason: "history-divergence" });
	});

	it("history truncated shorter than the recorded chain -> cold", () => {
		const seen = [U("q1"), A("r1"), U("q2")];
		const current = [U("q1")];
		const d = validateWarmResume({ sidecar: sidecarOver(seen), currentMessages: current, currentClaudeVersion: VERSION });
		assert.equal(d.reason, "history-divergence");
	});

	it("version skew -> cold", () => {
		const seen = [U("q1")];
		const current = [U("q1"), A("r1"), U("q2")];
		const d = validateWarmResume({ sidecar: sidecarOver(seen, "2.1.159"), currentMessages: current, currentClaudeVersion: "2.2.0" });
		assert.deepEqual(d, { warm: false, reason: "version-skew" });
	});

	it("unreadable installed version (null) -> cold (conservative)", () => {
		const seen = [U("q1")];
		const current = [U("q1"), A("r1"), U("q2")];
		const d = validateWarmResume({ sidecar: sidecarOver(seen, "2.1.159"), currentMessages: current, currentClaudeVersion: null });
		assert.equal(d.reason, "version-skew");
	});

	it("no new turn appended (history unchanged) -> cold", () => {
		const seen = [U("q1"), A("r1")];
		const current = [U("q1"), A("r1")];
		const d = validateWarmResume({ sidecar: sidecarOver(seen), currentMessages: current, currentClaudeVersion: VERSION });
		assert.equal(d.reason, "no-new-turn");
	});
});

describe("warm-resume gate: cold-start-on-unreadable-or-malformed-sidecar", () => {
	it("a corrupt/malformed sidecar (readSidecar already returned null) -> cold", () => {
		// readSidecar collapses corrupt/torn/malformed files to null (tested in
		// unit-resume-store); the gate sees null and cold-starts.
		const d = validateWarmResume({ sidecar: null, currentMessages: [U("q1"), A("r1"), U("q2")], currentClaudeVersion: VERSION });
		assert.deepEqual(d, { warm: false, reason: "no-sidecar" });
	});
});
