#!/usr/bin/env node
// T4.3 — audit DISALLOWED_BUILTIN_TOOLS matches the spec's documented
// minimum set per `claude-tui-driver.native-tool-emission-is-blocked-at-driver-configuration`.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DISALLOWED_BUILTIN_TOOLS } from "../src/driver/settings.js";

describe("DISALLOWED_BUILTIN_TOOLS — spec compliance", () => {
	it("includes every name from the spec's documented set", () => {
		// Verbatim from claude-tui-driver.native-tool-emission-is-blocked-at-driver-configuration:
		const required = [
			"Read", "Write", "Edit", "Bash", "Glob", "Grep", "Agent",
			"WebFetch", "WebSearch", "TodoWrite",
			"EnterPlanMode", "ExitPlanMode",
			"Skill", "ToolSearch", "AskUserQuestion",
			"ScheduleWakeup", "TaskOutput", "TaskStop", "BashOutput", "Monitor", "Mcp",
		];
		for (const t of required) {
			assert.ok(DISALLOWED_BUILTIN_TOOLS.includes(t), `spec-required tool '${t}' missing from DISALLOWED_BUILTIN_TOOLS`);
		}
	});

	it("does NOT include --bare (that's a flag, not a tool — but the driver MUST never emit --bare)", () => {
		// Sanity check: --bare is incompatible with hooks (per D9). The
		// driver never invokes --bare. This is enforced at the spawn site
		// in src/driver/pty.ts (no --bare in argv). Confirm here that the
		// disallow list does not accidentally include something nonsensical.
		assert.ok(!DISALLOWED_BUILTIN_TOOLS.includes("--bare"));
	});
});
