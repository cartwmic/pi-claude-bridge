#!/usr/bin/env node
// T2.6 — capture path honors AbortSignal: abort mid-flight resolves the
// stream with stopReason: aborted before the model finishes.

import assert from "node:assert/strict";
import { runCaptureQueryPty } from "../src/capture.js";
import { newAssistantMessageEventStream } from "@mariozechner/pi-ai";

const ctrl = new AbortController();
setTimeout(() => ctrl.abort(), 1500);

const stream = runCaptureQueryPty(
	{ id: "claude-sonnet-4-6", baseUrl: "claude-bridge", api: "anthropic-messages" },
	{
		messages: [{ role: "user", content: "Slowly think through a complex math problem before calling the extract tool." }],
		systemPrompt: "Reason carefully.",
		tools: [{ name: "extract", parameters: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } } }],
	},
	{ signal: ctrl.signal },
	{
		captureTool: { name: "extract", parameters: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } } },
		cleanedSchema: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } },
		makeStream: newAssistantMessageEventStream,
	},
);
const events = [];
await new Promise((r) => stream.subscribe((e) => { events.push(e); if (e.type === "done" || e.type === "error") r(); }));
const final = events[events.length - 1];
assert.equal(final.type, "error");
assert.equal(final.reason, "aborted");
console.log("PASS T2.6");
