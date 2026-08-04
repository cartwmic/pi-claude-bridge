#!/usr/bin/env node

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mapPiReasoningToClaudeEffort } from "../src/driver/effort.js";

describe("Pi reasoning to Claude CLI effort", () => {
	it("clamps minimal to Claude's lowest effort and preserves named levels", () => {
		assert.equal(mapPiReasoningToClaudeEffort("minimal"), "low");
		assert.equal(mapPiReasoningToClaudeEffort("low"), "low");
		assert.equal(mapPiReasoningToClaudeEffort("medium"), "medium");
		assert.equal(mapPiReasoningToClaudeEffort("high"), "high");
		assert.equal(mapPiReasoningToClaudeEffort("xhigh"), "xhigh");
	});

	it("accepts newer Pi max and omits effort when reasoning is off", () => {
		assert.equal(mapPiReasoningToClaudeEffort("max"), "max");
		assert.equal(mapPiReasoningToClaudeEffort(undefined), undefined);
	});
});
