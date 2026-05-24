#!/usr/bin/env node
// T2.5 — capture error path: model never calls the capture tool (e.g.
// answers with text instead). Bridge must surface as stopReason:"error"
// per output-capture.surface-absent-capture-tool-call-as-error.

import assert from "node:assert/strict";
import { runCaptureQueryPty } from "../src/capture.js";
import { newAssistantMessageEventStream } from "@mariozechner/pi-ai";

const stream = runCaptureQueryPty(
	{ id: "claude-sonnet-4-6", baseUrl: "claude-bridge", api: "anthropic-messages" },
	{
		messages: [{ role: "user", content: "Just reply with the word OK. Do not use any tools." }],
		systemPrompt: "Follow user instructions exactly. Do not use tools when told not to.",
		tools: [{ name: "neverCalled", parameters: { type: "object", required: ["x"], properties: { x: { type: "string" } } } }],
	},
	undefined,
	{
		captureTool: { name: "neverCalled", parameters: { type: "object", required: ["x"], properties: { x: { type: "string" } } } },
		cleanedSchema: { type: "object", required: ["x"], properties: { x: { type: "string" } } },
		makeStream: newAssistantMessageEventStream,
	},
);

const events = [];
await new Promise((r) => stream.subscribe((e) => { events.push(e); if (e.type === "done" || e.type === "error") r(); }));

const err = events.find((e) => e.type === "error");
assert.ok(err, `expected error event; got: ${events.map((e) => e.type).join(",")}`);
assert.match(err.error.errorMessage, /no valid call|never called/i);
console.log("PASS T2.5");
