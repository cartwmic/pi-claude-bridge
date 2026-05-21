#!/usr/bin/env node
// Unit tests for src/driver/settings.ts (T1.3).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	DISALLOWED_BUILTIN_TOOLS,
	ALLOWED_TOOL_GLOBS,
	buildSettingsJson,
	buildMcpConfigJson,
	buildAllowedToolsArg,
} from "../src/driver/settings.js";

describe("DISALLOWED_BUILTIN_TOOLS (constitution IV)", () => {
	it("includes documented minimum set (claude-tui-driver.native-tool-emission-is-blocked-at-driver-configuration)", () => {
		const required = [
			"Read", "Write", "Edit", "Bash", "Glob", "Grep", "Agent",
			"WebFetch", "WebSearch", "TodoWrite",
			"EnterPlanMode", "ExitPlanMode",
			"Skill", "ToolSearch", "AskUserQuestion",
			"ScheduleWakeup", "TaskOutput", "TaskStop", "BashOutput", "Monitor", "Mcp",
		];
		for (const tool of required) {
			assert.ok(DISALLOWED_BUILTIN_TOOLS.includes(tool), `missing required tool: ${tool}`);
		}
	});

	it("is frozen (defensive immutability)", () => {
		assert.ok(Object.isFrozen(DISALLOWED_BUILTIN_TOOLS));
	});
});

describe("ALLOWED_TOOL_GLOBS", () => {
	it("allows only mcp__custom-tools__* surface", () => {
		assert.deepEqual([...ALLOWED_TOOL_GLOBS], ["mcp__custom-tools__*"]);
	});

	it("buildAllowedToolsArg returns a comma-joined string", () => {
		assert.equal(buildAllowedToolsArg(), "mcp__custom-tools__*");
	});
});

describe("buildSettingsJson", () => {
	const opts = { shimPath: "/abs/path/to/shim.js", socketPath: "/tmp/sock.sock" };

	it("returns a valid JSON string", () => {
		const j = buildSettingsJson(opts);
		assert.doesNotThrow(() => JSON.parse(j));
	});

	it("registers SessionStart and Stop hooks by default", () => {
		const j = JSON.parse(buildSettingsJson(opts));
		assert.deepEqual(Object.keys(j.hooks).sort(), ["SessionStart", "Stop"]);
	});

	it("does NOT register PreToolUse or SessionEnd (D9 dropped them)", () => {
		const j = JSON.parse(buildSettingsJson(opts));
		assert.ok(!("PreToolUse" in j.hooks));
		assert.ok(!("SessionEnd" in j.hooks));
		assert.ok(!("UserPromptSubmit" in j.hooks));
	});

	it("each hook command invokes the shim binary with --mode hook + --event + --socket", () => {
		const j = JSON.parse(buildSettingsJson(opts));
		for (const ev of ["SessionStart", "Stop"]) {
			const entry = j.hooks[ev][0];
			assert.equal(entry.matcher, "*");
			const cmd = entry.hooks[0].command;
			assert.match(cmd, /--mode hook/);
			assert.match(cmd, new RegExp(`--event ${ev}`));
			assert.match(cmd, /--socket/);
			assert.ok(cmd.includes(opts.shimPath));
			assert.ok(cmd.includes(opts.socketPath));
		}
	});

	it("quotes shim path with spaces (D19 / Round-5 A.P2)", () => {
		const j = JSON.parse(buildSettingsJson({
			shimPath: "/Users/Some User/path/shim.js",
			socketPath: "/tmp/sock.sock",
		}));
		const cmd = j.hooks.SessionStart[0].hooks[0].command;
		assert.ok(cmd.includes("'/Users/Some User/path/shim.js'"),
			`expected single-quoted path in: ${cmd}`);
	});

	it("denies every tool in DISALLOWED_BUILTIN_TOOLS via permissions.deny", () => {
		const j = JSON.parse(buildSettingsJson(opts));
		assert.ok(Array.isArray(j.permissions.deny));
		// Bash gets the (*) sub-command matcher
		assert.ok(j.permissions.deny.includes("Bash(*)"));
		// Bare names for the rest
		assert.ok(j.permissions.deny.includes("Read"));
		assert.ok(j.permissions.deny.includes("TodoWrite"));
		assert.ok(j.permissions.deny.includes("ScheduleWakeup"));
		// Total entries match the source list
		assert.equal(j.permissions.deny.length, DISALLOWED_BUILTIN_TOOLS.length);
	});

	it("custom events option restricts to subset", () => {
		const j = JSON.parse(buildSettingsJson({ ...opts, events: ["SessionStart"] }));
		assert.deepEqual(Object.keys(j.hooks), ["SessionStart"]);
	});
});

describe("buildMcpConfigJson", () => {
	const opts = { shimPath: "/abs/path/to/shim.js", socketPath: "/tmp/sock.sock" };

	it("returns a valid JSON string", () => {
		assert.doesNotThrow(() => JSON.parse(buildMcpConfigJson(opts)));
	});

	it("declares exactly one mcpServers entry", () => {
		const j = JSON.parse(buildMcpConfigJson(opts));
		assert.equal(Object.keys(j.mcpServers).length, 1);
	});

	it("default server name is 'pi-bridge'", () => {
		const j = JSON.parse(buildMcpConfigJson(opts));
		assert.ok("pi-bridge" in j.mcpServers);
	});

	it("server entry uses stdio transport pointing at shim with --mode mcp + --socket", () => {
		const j = JSON.parse(buildMcpConfigJson(opts));
		const server = j.mcpServers["pi-bridge"];
		assert.equal(server.type, "stdio");
		assert.equal(server.command, opts.shimPath);
		assert.deepEqual(server.args, ["--mode", "mcp", "--socket", opts.socketPath]);
	});

	it("custom serverName option is honored", () => {
		const j = JSON.parse(buildMcpConfigJson({ ...opts, serverName: "custom-name" }));
		assert.ok("custom-name" in j.mcpServers);
	});
});

describe("settings + mcp-config integration", () => {
	it("both payloads reference the same socket path", () => {
		const shimPath = "/abs/shim.js";
		const socketPath = "/tmp/abc-def.sock";
		const s = JSON.parse(buildSettingsJson({ shimPath, socketPath }));
		const m = JSON.parse(buildMcpConfigJson({ shimPath, socketPath }));
		const settingsSocketRef = s.hooks.SessionStart[0].hooks[0].command;
		const mcpSocketRef = m.mcpServers["pi-bridge"].args.join(" ");
		assert.ok(settingsSocketRef.includes(socketPath));
		assert.ok(mcpSocketRef.includes(socketPath));
	});
});
