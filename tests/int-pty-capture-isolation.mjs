#!/usr/bin/env node
// T2.4 — capture mid-conversation isolation: a capture call running while
// a user turn is active must NOT mutate the active frame's state (stack,
// pendingResolvers, cachedSessionId, etc.). Per output-capture.capture-path-isolation.
//
// Quick sanity: run two capture calls concurrently; each must complete
// independently without disturbing the other's router state.

import assert from "node:assert/strict";
import { runCaptureQueryPty } from "../src/capture.js";
import { newAssistantMessageEventStream } from "@mariozechner/pi-ai";

function run(label, answer) {
	return new Promise((resolve) => {
		const events = [];
		const stream = runCaptureQueryPty(
			{ id: "claude-sonnet-4-6", baseUrl: "claude-bridge", api: "anthropic-messages" },
			{
				messages: [{ role: "user", content: `Use the extract tool with answer=${answer}.` }],
				systemPrompt: "Use the extract tool.",
				tools: [{ name: "extract", parameters: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } } }],
			},
			undefined,
			{
				captureTool: { name: "extract", parameters: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } } },
				cleanedSchema: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } },
				makeStream: newAssistantMessageEventStream,
			},
		);
		stream.subscribe((e) => {
			events.push(e);
			if (e.type === "done" || e.type === "error") resolve({ label, events });
		});
	});
}

const [a, b] = await Promise.all([run("A", 1), run("B", 2)]);
const aDone = a.events.find((e) => e.type === "done");
const bDone = b.events.find((e) => e.type === "done");
assert.ok(aDone && bDone, "both runs should complete");
assert.equal(aDone.message.content[0].arguments.answer, 1, "A captures 1");
assert.equal(bDone.message.content[0].arguments.answer, 2, "B captures 2");
console.log("PASS T2.4");
