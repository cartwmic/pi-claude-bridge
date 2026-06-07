#!/usr/bin/env node
// Regression test for the context-window usage stat on multi-round turns.
//
// pi's calculateContextTokens(usage) (pi-coding-agent compaction.js) computes the
// context-window indicator as `usage.totalTokens || input+output+cacheRead+cacheWrite`
// — i.e. it READS usage.totalTokens. So whatever the bridge stuffs into
// totalTokens IS pi's context bar.
//
// BUG (this guards): updateUsageFromDriver set
//   totalTokens = context.input + context.cacheRead + context.cacheWrite + BILLING.output
// where billing.output is claude-p's CUMULATIVE per-turn output (the sum across
// every tool round). On a heavy multi-round turn the cumulative output is huge
// (observed 126k–168k on opus), so totalTokens — and therefore pi's context bar —
// re-inflated, the same class of bug ca7937d fixed for cacheRead.
//
// CORRECT: the context window holds the LAST call's input-side tokens plus the
// LAST call's output (what was just appended to context) — NOT the summed output
// of every round. So totalTokens must use context.output (last call), while the
// `output` field stays CUMULATIVE (true turn output + cost basis).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeReportedUsageFields } from "../index.js";

describe("usage: context-window totalTokens excludes cumulative output (multi-round)", () => {
	it("totalTokens uses the LAST-call output, not the cumulative billing output", () => {
		// A real-shaped opus multi-round turn: last call is small, cumulative is huge.
		const context = { input: 2, output: 2000, cacheRead: 0, cacheWrite: 11468, totalTokens: 13470 };
		const billing = { input: 2, output: 155610, cacheRead: 0, cacheWrite: 11468, totalTokens: 167080 };
		const r = computeReportedUsageFields(context, billing);
		assert.equal(r.totalTokens, 2 + 0 + 11468 + 2000, "context occupancy = last-call input-side + last-call output");
		assert.notEqual(r.totalTokens, 167080, "must NOT fold in cumulative output");
		assert.ok(r.totalTokens < billing.output, "context bar is bounded, far below cumulative output");
	});

	it("input/cacheRead/cacheWrite are the LAST-call (context) values, not cumulative", () => {
		const context = { input: 2, output: 320, cacheRead: 8256, cacheWrite: 3260, totalTokens: 11838 };
		const billing = { input: 2, output: 4000, cacheRead: 16512, cacheWrite: 3260, totalTokens: 23774 };
		const r = computeReportedUsageFields(context, billing);
		assert.equal(r.input, 2);
		assert.equal(r.cacheRead, 8256, "last-call cacheRead, not cumulative 16512");
		assert.equal(r.cacheWrite, 3260);
	});

	it("output stays CUMULATIVE (true turn total / cost basis)", () => {
		const context = { input: 2, output: 2000, cacheRead: 0, cacheWrite: 100, totalTokens: 2102 };
		const billing = { input: 2, output: 155610, cacheRead: 0, cacheWrite: 100, totalTokens: 155712 };
		const r = computeReportedUsageFields(context, billing);
		assert.equal(r.output, 155610, "output = cumulative turn total (pi sums per-turn for session total + cost)");
	});

	it("single-call turn (context === billing): totalTokens is the plain sum", () => {
		const u = { input: 10, output: 300, cacheRead: 8000, cacheWrite: 200, totalTokens: 8510 };
		const r = computeReportedUsageFields(u, u);
		assert.equal(r.totalTokens, 10 + 8000 + 200 + 300);
		assert.equal(r.output, 300);
	});

	it("no billing arg → falls back to context for output (single-shot)", () => {
		const context = { input: 5, output: 50, cacheRead: 100, cacheWrite: 0, totalTokens: 155 };
		const r = computeReportedUsageFields(context);
		assert.equal(r.output, 50);
		assert.equal(r.totalTokens, 5 + 100 + 0 + 50);
	});
});
