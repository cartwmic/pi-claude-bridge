#!/usr/bin/env node
// T2.3 — capture-mode happy path: model emits valid call to capture tool
// matching schema; bridge returns synthesized toolCall content block.

import assert from "node:assert/strict";
import { runCaptureQueryPty } from "../src/capture.js";
import { newAssistantMessageEventStream } from "@mariozechner/pi-ai";

const stream = runCaptureQueryPty(
	{ id: "claude-sonnet-4-6", baseUrl: "claude-bridge", api: "anthropic-messages" },
	{
		messages: [{ role: "user", content: "Extract the answer to '2+2' using the extract tool." }],
		systemPrompt: "Use the extract tool to give your numeric answer.",
		tools: [{
			name: "extract",
			description: "Records the structured answer.",
			parameters: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } },
		}],
	},
	undefined,
	{
		captureTool: { name: "extract", description: "Records the structured answer.", parameters: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } } },
		cleanedSchema: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } },
		makeStream: newAssistantMessageEventStream,
	},
);

const events = [];
stream.subscribe((e) => events.push(e));
await new Promise((r) => stream.subscribe((e) => { if (e.type === "done" || e.type === "error") r(); }));

const done = events.find((e) => e.type === "done");
assert.ok(done, `expected done; got: ${events.map((e) => e.type).join(",")}`);
assert.equal(done.reason, "toolUse");
const tc = done.message.content[0];
assert.equal(tc.type, "toolCall");
assert.equal(tc.name, "extract");
assert.equal(tc.arguments.answer, 4);
console.log("PASS T2.3");
