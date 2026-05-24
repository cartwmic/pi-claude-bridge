#!/usr/bin/env node
// T4.8 — Capture-mode termination latency benchmark.
//
// Goal: catch regressions where the model emits the capture tool call but
// then keeps streaming "I'll think about this..." prose for many tokens
// before end_turn. The intended capture-mode behavior is: tool call →
// immediate end_turn. Excess prose post-tool-call wastes tokens and stalls
// downstream pi turns waiting for the captured value.
//
// What we measure (N capture runs):
//   - tokensAfterToolCall: number of assistant-text characters emitted
//     between the toolCall event and the done event. 0 == "end_turn
//     immediately after the call" (the goal). Larger == regression.
//
// What we report:
//   - median + p99 across N runs
//   - PASS if median <= MEDIAN_BUDGET (default 5 chars)
//   - WARN if median in (MEDIAN_BUDGET, MEDIAN_BUDGET * 4]
//   - FAIL if median > 4 * MEDIAN_BUDGET
//
// Tuning: set BRIDGE_BENCH_RUNS (default 3, the minimum for a usable
// median; CI can override to 5 for more signal).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runCaptureQueryPty } from "../src/capture.js";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";

const RUNS = Number(process.env.BRIDGE_BENCH_RUNS ?? 3);
const MEDIAN_BUDGET = 5;       // chars of post-tool-call text we'll tolerate
const HARD_FAIL_FACTOR = 4;    // FAIL if median > 4 * MEDIAN_BUDGET

function percentile(sorted, p) {
	if (sorted.length === 0) return 0;
	const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(p / 100 * sorted.length)));
	return sorted[idx];
}

async function oneRun() {
	const captureTool = {
		name: "answer",
		description: "Records a single numeric answer.",
		parameters: { type: "object", required: ["n"], properties: { n: { type: "number" } } },
	};
	const stream = runCaptureQueryPty(
		{ id: "claude-sonnet-4-6", baseUrl: "claude-bridge", api: "anthropic-messages" },
		{
			messages: [{ role: "user", content: "Compute 2+2. Call the answer tool with n=4 and stop. Do not add any prose after the tool call." }],
			systemPrompt: "Use the answer tool. End the turn immediately after the tool call.",
			tools: [captureTool],
		},
		undefined,
		{
			captureTool,
			cleanedSchema: captureTool.parameters,
			makeStream: createAssistantMessageEventStream,
		},
	);

	let sawToolCall = false;
	let textAfter = 0;

	const timer = setTimeout(() => { /* hard cap 60s — caller breaks below */ }, 60_000);
	try {
		for await (const e of stream) {
			if (!e || typeof e !== "object") continue;
			// toolCallStart / toolCall / textDelta / done shapes
			const t = e.type;
			if (t === "done" || t === "error") break;
			// Detect tool call completion. pi-ai emits a "toolCall" event when
			// the call's JSON is fully formed.
			if (t === "toolCall" || t === "toolCallStart" || (t === "delta" && e?.delta?.type === "toolCallStart")) {
				sawToolCall = true;
				continue;
			}
			// Count text after tool call.
			if (sawToolCall) {
				const text = (typeof e?.text === "string" ? e.text : "") ||
					(typeof e?.delta?.text === "string" ? e.delta.text : "");
				if (text) textAfter += text.length;
			}
		}
	} catch (err) {
		// Non-fatal — record the partial result.
		console.error(`  run errored: ${err?.message ?? err}`);
	} finally {
		clearTimeout(timer);
	}

	return { sawToolCall, textAfter };
}

describe("Capture-mode termination latency benchmark", () => {
	it(`median post-tool-call text <= ${MEDIAN_BUDGET} chars across ${RUNS} runs`, async () => {
		const results = [];
		for (let i = 0; i < RUNS; i++) {
			console.log(`  bench run ${i + 1}/${RUNS}...`);
			const r = await oneRun();
			results.push(r);
			console.log(`    sawToolCall=${r.sawToolCall} textAfter=${r.textAfter}`);
		}

		const withCalls = results.filter((r) => r.sawToolCall);
		if (withCalls.length === 0) {
			console.error("WARN: no run produced a toolCall event (auth / spawn issue?); skipping bench assertion");
			return;
		}

		const sorted = withCalls.map((r) => r.textAfter).sort((a, b) => a - b);
		const median = percentile(sorted, 50);
		const p99 = percentile(sorted, 99);

		console.log(`  ---`);
		console.log(`  runs with toolCall: ${withCalls.length}/${RUNS}`);
		console.log(`  median post-tool-call chars: ${median}`);
		console.log(`  p99 post-tool-call chars:    ${p99}`);
		console.log(`  budget: median <= ${MEDIAN_BUDGET} (PASS), <= ${MEDIAN_BUDGET * HARD_FAIL_FACTOR} (WARN), > ${MEDIAN_BUDGET * HARD_FAIL_FACTOR} (FAIL)`);

		if (median <= MEDIAN_BUDGET) {
			console.log(`  PASS — capture-mode terminates promptly`);
		} else if (median <= MEDIAN_BUDGET * HARD_FAIL_FACTOR) {
			console.log(`  WARN — capture-mode lingering past budget; investigate`);
		} else {
			assert.fail(`capture-mode regression: median ${median} > ${MEDIAN_BUDGET * HARD_FAIL_FACTOR}`);
		}
	});
});
