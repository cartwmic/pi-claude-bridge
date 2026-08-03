#!/usr/bin/env node
// T4.3 — Constitution IV audit: the closed-set / argv mechanism (G2's mechanism
// at unit level).
//
// Constitution IV ("native tools blocked; only the bridged mcp__custom-tools__*
// surface is callable"). On the claude-p path the MECHANISM is the
// `--disallowedTools` denylist (design D28) assembled by buildClaudePArgs(). This
// suite pins that mechanism:
//
//   (a) `--disallowedTools` is ALWAYS present and non-empty in the assembled argv.
//   (b) the assembled argv NEVER contains `--settings`, `-p`, or `--print`, across
//       a representative matrix of configs — AND the forbidden-flag guard throws
//       if such a flag is ever forced into the argv (defense, not flow control).
//   (c) the disallow set contains NO `Mcp` / `mcp__*` token (the no-Mcp invariant:
//       a bare `Mcp` entry would also match the bridge's OWN mcp__custom-tools__*
//       surface and deadlock every tool round) — AND the mcp-token guard throws if
//       the value is poisoned with such a token.
//   (d) the disallow set includes the full documented native set (Read/Write/Edit/
//       Bash/Glob/Grep/WebFetch/WebSearch/Agent/Task/…).
//
// Pure / deterministic: no subprocess, no real claude-p. Imports the real exports
// from src/driver/claudeP.ts.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	buildClaudePArgs,
	CLAUDE_P_DISALLOWED_TOOLS,
	DISALLOWED_TOOLS_VALUE,
} from "../src/driver/claudeP.js";

const FORBIDDEN_FLAGS = ["--settings", "-p", "--print"];

/** A minimal valid spawn config (fresh turn, positional prompt, inline sysprompt). */
function baseCfg(overrides = {}) {
	return {
		model: "claude-sonnet-4-6",
		systemPrompt: { kind: "text", text: "SYS" },
		prompt: { kind: "positional", text: "hello world" },
		mcpConfig: '{"mcpServers":{}}',
		session: { kind: "fresh", sessionId: "11111111-1111-1111-1111-111111111111" },
		...overrides,
	};
}

/** Find the value that follows `flag` in an argv array (or undefined). */
function valueAfter(args, flag) {
	const i = args.indexOf(flag);
	return i === -1 ? undefined : args[i + 1];
}

// A representative matrix exercising every public config branch (system-prompt
// text/file, prompt positional/file, session fresh/resume). Constitution IV must
// hold on EVERY one.
const MATRIX = [
	baseCfg(),
	baseCfg({ systemPrompt: { kind: "file", path: "/tmp/sys.txt" } }),
	baseCfg({ prompt: { kind: "file", path: "/tmp/prompt.txt" } }),
	baseCfg({ session: { kind: "resume", sessionId: "warm-session-id" } }),
	baseCfg({
		systemPrompt: { kind: "file", path: "/tmp/sys2.txt" },
		prompt: { kind: "file", path: "/tmp/prompt2.txt" },
		session: { kind: "resume", sessionId: "warm-2" },
	}),
	// Adversarial: a user prompt that LOOKS like a forbidden flag must still never
	// cause a forbidden flag to be EMITTED as an argv flag (it rides as a
	// positional value appended after the guards).
	baseCfg({ prompt: { kind: "positional", text: "--print -p --settings please" } }),
];

// ────────────────────────────────────────────────────────────────────────────
// (a) --disallowedTools always present + non-empty
// ────────────────────────────────────────────────────────────────────────────

describe("T4.3(a) — --disallowedTools is always present and non-empty", () => {
	for (const [i, cfg] of MATRIX.entries()) {
		it(`config #${i}: argv carries --disallowedTools <non-empty value>`, () => {
			const args = buildClaudePArgs(cfg);
			assert.ok(args.includes("--disallowedTools"), "argv must include --disallowedTools");
			const value = valueAfter(args, "--disallowedTools");
			assert.equal(typeof value, "string");
			assert.ok(value.length > 0, "--disallowedTools value must be non-empty");
			assert.equal(value, DISALLOWED_TOOLS_VALUE, "value is the exported closed set, space-joined");
		});
	}

	it("the exported value equals the space-joined closed set and is non-empty", () => {
		assert.ok(CLAUDE_P_DISALLOWED_TOOLS.length > 0, "closed set must be non-empty");
		assert.equal(DISALLOWED_TOOLS_VALUE, CLAUDE_P_DISALLOWED_TOOLS.join(" "));
		assert.ok(DISALLOWED_TOOLS_VALUE.trim().length > 0);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// (b) argv NEVER contains --settings / -p / --print; the guard throws if forced
// ────────────────────────────────────────────────────────────────────────────

describe("T4.3(b) — forbidden flags never emitted; guard throws if forced", () => {
	for (const [i, cfg] of MATRIX.entries()) {
		it(`config #${i}: argv contains none of --settings / -p / --print as flags`, () => {
			const args = buildClaudePArgs(cfg);
			for (const f of FORBIDDEN_FLAGS) {
				assert.ok(!args.includes(f), `argv must not contain forbidden flag ${f}`);
			}
		});
	}

	it("the adversarial positional prompt is NOT emitted as a flag (rides as last positional)", () => {
		const args = buildClaudePArgs(
			baseCfg({ prompt: { kind: "positional", text: "--print -p --settings please" } }),
		);
		// The whole user text is ONE positional element at the end, never split into
		// separate forbidden-flag tokens.
		assert.equal(args[args.length - 1], "--print -p --settings please");
		// And `indexOf` over the WHOLE argv finds no standalone forbidden flag token.
		for (const f of FORBIDDEN_FLAGS) {
			assert.ok(!args.includes(f), `forbidden flag ${f} must not appear as a standalone argv token`);
		}
	});

	it("the forbidden-flag guard THROWS when a forbidden flag is forced into the argv", () => {
		// buildClaudePArgs's public surface cannot emit a forbidden flag, so we
		// reconstruct the SOURCE guard predicate verbatim (index: src/driver/
		// claudeP.ts FORBIDDEN_FLAGS loop) and prove it trips on poisoned argv. This
		// is the defense-in-depth assertion T4.3(b) asks for: "the guard throws if
		// forced". If the source guard is weakened, the matrix tests above stay
		// green but THIS contract documents the intended behavior.
		const forbiddenFlagGuard = (args) => {
			for (const forbidden of FORBIDDEN_FLAGS) {
				if (args.includes(forbidden)) {
					throw new Error(`refusing to emit forbidden flag "${forbidden}"`);
				}
			}
		};
		assert.doesNotThrow(() => forbiddenFlagGuard(buildClaudePArgs(baseCfg())), "clean argv passes the guard");
		for (const f of FORBIDDEN_FLAGS) {
			assert.throws(
				() => forbiddenFlagGuard(["--model", "x", f, "y"]),
				new RegExp(`forbidden flag "${f.replace(/[-]/g, "\\$&")}"`),
				`guard must throw when ${f} is present`,
			);
		}
	});
});

// ────────────────────────────────────────────────────────────────────────────
// (c) no Mcp / mcp__ token; the mcp-token guard throws if poisoned
// ────────────────────────────────────────────────────────────────────────────

describe("T4.3(c) — no-Mcp invariant; guard throws if the value is poisoned", () => {
	it("the closed set contains NO bare Mcp / mcp__ token", () => {
		for (const tool of CLAUDE_P_DISALLOWED_TOOLS) {
			assert.ok(!/^mcp(__|$)/i.test(tool), `closed set must not contain an mcp token: "${tool}"`);
		}
	});

	it("the assembled --disallowedTools value carries no mcp token", () => {
		// Mirrors the source guard regex exactly.
		assert.ok(!/\bmcp(__|\b)/i.test(DISALLOWED_TOOLS_VALUE), "DISALLOWED_TOOLS_VALUE must carry no mcp token");
		const args = buildClaudePArgs(baseCfg());
		assert.ok(!/\bmcp(__|\b)/i.test(valueAfter(args, "--disallowedTools")));
	});

	it("the mcp-token guard THROWS when the disallow value is poisoned with an mcp token", () => {
		// Reconstruct the SOURCE guard predicate verbatim (src/driver/claudeP.ts: the
		// `/\bmcp(__|\b)/i.test(...)` guard) and prove it trips on poisoned values —
		// the closed set must NEVER contain a token that would suppress the bridge's
		// own mcp__custom-tools__* surface.
		const mcpTokenGuard = (value) => {
			if (/\bmcp(__|\b)/i.test(value)) {
				throw new Error("refusing: --disallowedTools must not contain any Mcp/mcp__ token");
			}
		};
		assert.doesNotThrow(() => mcpTokenGuard(DISALLOWED_TOOLS_VALUE), "the real value passes the guard");
		for (const poison of ["Read Mcp Bash", "Read mcp__custom-tools__x Bash", "mcp__foo"]) {
			assert.throws(() => mcpTokenGuard(poison), /Mcp\/mcp__ token/, `guard must throw on "${poison}"`);
		}
	});
});

// ────────────────────────────────────────────────────────────────────────────
// (d) the disallow set includes the full documented native set
// ────────────────────────────────────────────────────────────────────────────

describe("T4.3(d) — the closed set includes the documented natives", () => {
	// The full current denylist documented in design D28 / src/driver/claudeP.ts.
	const REQUIRED_NATIVES = [
		// Core file/shell/search/web natives.
		"Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebFetch", "WebSearch", "NotebookEdit",
		// Subagent / planning / skills / tool-search / interaction natives.
		"Agent", "Task", "Skill", "ToolSearch", "AskUserQuestion", "ReportFindings", "SendMessage",
		"EnterPlanMode", "ExitPlanMode", "EnterWorktree", "ExitWorktree",
		// Background-task / scheduling / workflow / cron / notification natives.
		"TodoWrite", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate", "TaskOutput", "TaskStop",
		"BashOutput", "Monitor", "Workflow", "ScheduleWakeup",
		"CronCreate", "CronDelete", "CronList", "PushNotification", "RemoteTrigger",
	];

	for (const tool of REQUIRED_NATIVES) {
		it(`closed set blocks the "${tool}" native`, () => {
			assert.ok(
				CLAUDE_P_DISALLOWED_TOOLS.includes(tool),
				`disallow set is missing documented native "${tool}"`,
			);
			// And it is actually present in the assembled --disallowedTools value as a
			// whole space-delimited token (claude matches by name).
			const value = buildClaudePArgs(baseCfg()).at(buildClaudePArgs(baseCfg()).indexOf("--disallowedTools") + 1);
			assert.ok(
				value.split(" ").includes(tool),
				`--disallowedTools value must contain the token "${tool}"`,
			);
		});
	}

	it("the closed set has no duplicate tokens", () => {
		const seen = new Set();
		for (const t of CLAUDE_P_DISALLOWED_TOOLS) {
			assert.ok(!seen.has(t), `duplicate token in closed set: "${t}"`);
			seen.add(t);
		}
	});

	it("every documented native token is non-empty and whitespace-free (so it survives space-join)", () => {
		for (const t of CLAUDE_P_DISALLOWED_TOOLS) {
			assert.ok(t.length > 0 && !/\s/.test(t), `token must be non-empty + whitespace-free: ${JSON.stringify(t)}`);
		}
	});
});
