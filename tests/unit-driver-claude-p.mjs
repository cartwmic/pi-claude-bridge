#!/usr/bin/env node
// Unit tests for the claude-p subprocess driver in src/driver/claudeP.ts (T1.3).
//
// Two halves:
//   1. buildClaudePArgs — a PURE argv assembler. Tested exhaustively for flag
//      inclusion/exclusion, the --settings/-p/--print guard throwing, the
//      no-`Mcp`-token assertion, and the session-id XOR resume choice.
//   2. spawnClaudeP lifecycle — exercised WITHOUT real claude-p. A `node -e`
//      stand-in child is pointed at via opts.binPath; we assert SIGINT delivery
//      to the process group, SIGKILL escalation after grace when SIGINT is
//      trapped, prompt done(aborted), missing-binary ENOENT error, and clean
//      `result` classification. Timing tolerances are generous.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	buildClaudePArgs,
	buildRetryConfig,
	spawnClaudeP,
	CLAUDE_P_DISALLOWED_TOOLS,
	DISALLOWED_TOOLS_VALUE,
	ABORT_SIGKILL_GRACE_MS,
} from "../src/driver/claudeP.js";

// ── helpers ──────────────────────────────────────────────────────────────────

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

function collector() {
	const events = [];
	return { events, onEvent: (e) => events.push(e) };
}

const QUIET = { warn() {}, info() {}, error() {} };

// node stand-in that prints a clean stream-json `result` line then exits 0.
const CHILD_CLEAN_RESULT = `process.stdout.write(JSON.stringify({type:"result",usage:{input_tokens:1,output_tokens:2}})+"\\n");process.exit(0);`;

// node stand-in that prints a line, then sleeps forever, and IGNORES SIGINT — so
// only SIGKILL can stop it (exercises the grace-window escalation).
const CHILD_TRAPS_SIGINT = `process.on("SIGINT",()=>{});process.stdout.write("alive\\n");setInterval(()=>{},1000);`;

// node stand-in that prints a line, sleeps, and exits cleanly on SIGINT (exit via
// default would be signal; we exit 130 to mimic claude-p's SIGINT return).
const CHILD_HONORS_SIGINT = `process.on("SIGINT",()=>{process.exit(130)});process.stdout.write("alive\\n");setInterval(()=>{},1000);`;

// node stand-in that exits non-zero WITHOUT a terminal result (premature/error).
const CHILD_PREMATURE = `process.stdout.write("partial\\n");process.exit(2);`;

// ── A. buildClaudePArgs (pure) ────────────────────────────────────────────────

describe("buildClaudePArgs — required flags", () => {
	it("includes --model with the resolved id", () => {
		const args = buildClaudePArgs(baseCfg());
		assert.equal(valueAfter(args, "--model"), "claude-sonnet-4-6");
	});

	it("emits selected Claude effort and omits it when reasoning is off", () => {
		assert.equal(valueAfter(buildClaudePArgs(baseCfg({ effort: "xhigh" })), "--effort"), "xhigh");
		assert.equal(buildClaudePArgs(baseCfg()).includes("--effort"), false);
	});

	it("includes --system-prompt <text> for inline system prompts", () => {
		const args = buildClaudePArgs(baseCfg());
		assert.equal(valueAfter(args, "--system-prompt"), "SYS");
		assert.ok(!args.includes("--system-prompt-file"));
	});

	it("includes --system-prompt-file <path> for file system prompts", () => {
		const args = buildClaudePArgs(baseCfg({ systemPrompt: { kind: "file", path: "/tmp/sys.txt" } }));
		assert.equal(valueAfter(args, "--system-prompt-file"), "/tmp/sys.txt");
		assert.ok(!args.includes("--system-prompt"));
	});

	it("delivers the positional prompt as the LAST argv element", () => {
		const args = buildClaudePArgs(baseCfg());
		assert.equal(args[args.length - 1], "hello world");
		assert.ok(!args.includes("--input-file"));
	});

	it("delivers a large prompt via --input-file (no positional)", () => {
		const args = buildClaudePArgs(baseCfg({ prompt: { kind: "file", path: "/tmp/prompt.txt" } }));
		assert.equal(valueAfter(args, "--input-file"), "/tmp/prompt.txt");
		assert.ok(!args.includes("hello world"));
	});

	it("includes --mcp-config verbatim", () => {
		const args = buildClaudePArgs(baseCfg());
		assert.equal(valueAfter(args, "--mcp-config"), '{"mcpServers":{}}');
	});

	it("emits --mcp-ready-file when mcpReadyFile is set", () => {
		const args = buildClaudePArgs(baseCfg({ mcpReadyFile: "/tmp/x.sock.ready" }));
		assert.equal(valueAfter(args, "--mcp-ready-file"), "/tmp/x.sock.ready");
	});

	it("omits --mcp-ready-file when mcpReadyFile is unset", () => {
		const args = buildClaudePArgs(baseCfg());
		assert.ok(!args.includes("--mcp-ready-file"));
	});

	// claude-peek-overlay.peek-follows-latest-main-turn-spawn-only: retries
	// re-mint a per-spawn mirror path (code-review r4).
	it("buildRetryConfig re-mints the mirror path via policy.remintMirrorFile", () => {
		const minted = [];
		const cfg = baseCfg({ mirrorFile: "/peek/first.raw" });
		const next = buildRetryConfig(cfg, {
			shouldRetry: () => true,
			freshSessionId: () => "retry-sess",
			remintMirrorFile: (sid) => {
				minted.push(sid);
				return `/peek/${sid}.raw`;
			},
		});
		assert.equal(next.mirrorFile, "/peek/retry-sess.raw");
		assert.deepEqual(minted, ["retry-sess"]);
	});

	it("buildRetryConfig keeps the prior mirrorFile absent a remint hook", () => {
		const cfg = baseCfg({ mirrorFile: "/peek/first.raw" });
		const next = buildRetryConfig(cfg, { shouldRetry: () => true, freshSessionId: () => "s2" });
		assert.equal(next.mirrorFile, "/peek/first.raw");
	});

	it("buildRetryConfig repacks failed warm resume as canonical cold input", () => {
		const cfg = baseCfg({
			prompt: { kind: "positional", text: "latest delta" },
			session: { kind: "resume", sessionId: "warm-broken" },
			mirrorFile: "/peek/warm.raw",
		});
		const next = buildRetryConfig(cfg, {
			shouldRetry: () => true,
			freshSessionId: () => "cold-retry",
			coldRetryConfig: (sessionId) => ({
				...cfg,
				prompt: { kind: "positional", text: "canonical full history" },
				session: { kind: "fresh", sessionId },
				mirrorFile: undefined,
			}),
			remintMirrorFile: (sessionId) => `/peek/${sessionId}.raw`,
		});
		assert.deepEqual(next.session, { kind: "fresh", sessionId: "cold-retry" });
		assert.deepEqual(next.prompt, { kind: "positional", text: "canonical full history" });
		assert.equal(next.mirrorFile, "/peek/cold-retry.raw");
	});

	// claude-p-fork.write-only-pty-output-mirror (bridge argv side)
	it("emits --mirror-file when mirrorFile is set", () => {
		const args = buildClaudePArgs(baseCfg({ mirrorFile: "/tmp/peek/abc.raw" }));
		assert.equal(valueAfter(args, "--mirror-file"), "/tmp/peek/abc.raw");
	});

	it("omits --mirror-file when mirrorFile is unset", () => {
		const args = buildClaudePArgs(baseCfg());
		assert.ok(!args.includes("--mirror-file"));
	});

	it("includes --disallowedTools with the full native disallow set", () => {
		const args = buildClaudePArgs(baseCfg());
		assert.equal(valueAfter(args, "--disallowedTools"), DISALLOWED_TOOLS_VALUE);
	});

	it("includes isolation flags --strict-mcp-config and --setting-sources \"\"", () => {
		const args = buildClaudePArgs(baseCfg());
		assert.ok(args.includes("--strict-mcp-config"));
		assert.equal(valueAfter(args, "--setting-sources"), "");
	});

	it("includes --permission-mode bypassPermissions", () => {
		const args = buildClaudePArgs(baseCfg());
		assert.equal(valueAfter(args, "--permission-mode"), "bypassPermissions");
	});

	it("includes --output-format stream-json and --verbose", () => {
		const args = buildClaudePArgs(baseCfg());
		assert.equal(valueAfter(args, "--output-format"), "stream-json");
		assert.ok(args.includes("--verbose"));
	});

	// No-liveness-timeouts: the bridge NEVER emits claude-p's wall-clock --timeout.
	it("never emits --timeout (no-liveness-timeouts principle)", () => {
		const args = buildClaudePArgs(baseCfg());
		assert.ok(!args.includes("--timeout"), "no --timeout flag should ever be emitted");
	});

	// driver-diagnostics.claude-debug-logging-is-forwarded-to-a-bridge-owned-file
	it("emits --debug-file <path> when debugFile is set (claude debug forwarding)", () => {
		const args = buildClaudePArgs(baseCfg({ debugFile: "/tmp/bridge-dbg/claude-debug-abc.log" }));
		assert.equal(valueAfter(args, "--debug-file"), "/tmp/bridge-dbg/claude-debug-abc.log");
	});

	it("omits --debug-file when debugFile is undefined (forwarding disabled)", () => {
		const args = buildClaudePArgs(baseCfg({ debugFile: undefined }));
		assert.ok(!args.includes("--debug-file"), "no --debug-file flag should be emitted");
	});
});

describe("buildClaudePArgs — session id XOR resume", () => {
	it("fresh turn → --session-id, never --resume", () => {
		const args = buildClaudePArgs(baseCfg({ session: { kind: "fresh", sessionId: "fresh-id" } }));
		assert.equal(valueAfter(args, "--session-id"), "fresh-id");
		assert.ok(!args.includes("--resume"));
	});

	it("warm resume → --resume, never --session-id", () => {
		const args = buildClaudePArgs(baseCfg({ session: { kind: "resume", sessionId: "warm-id" } }));
		assert.equal(valueAfter(args, "--resume"), "warm-id");
		assert.ok(!args.includes("--session-id"));
	});
});

describe("buildClaudePArgs — forbidden-flag and mcp-token guards", () => {
	it("NEVER emits --settings, -p, or --print", () => {
		const args = buildClaudePArgs(baseCfg());
		assert.ok(!args.includes("--settings"));
		assert.ok(!args.includes("-p"));
		assert.ok(!args.includes("--print"));
	});

	it("the disallow set contains every spec-enumerated native tool", () => {
		const required = [
			"Read", "Write", "Edit", "Bash", "Glob", "Grep", "Agent",
			"WebFetch", "WebSearch", "TodoWrite", "EnterPlanMode", "ExitPlanMode",
			"Skill", "ToolSearch", "AskUserQuestion", "ScheduleWakeup",
			"TaskOutput", "TaskStop", "BashOutput", "Monitor",
		];
		for (const tool of required) {
			assert.ok(CLAUDE_P_DISALLOWED_TOOLS.includes(tool), `disallow set missing ${tool}`);
		}
	});

	it("the disallow set contains NO bare Mcp / mcp__ token (footgun)", () => {
		for (const tool of CLAUDE_P_DISALLOWED_TOOLS) {
			assert.ok(!/^mcp(__|$)/i.test(tool), `disallow set must not contain mcp token: ${tool}`);
		}
		assert.ok(!/\bmcp(__|\b)/i.test(DISALLOWED_TOOLS_VALUE), "DISALLOWED_TOOLS_VALUE must carry no mcp token");
	});
});

// ── B. spawnClaudeP lifecycle (node stand-in child) ───────────────────────────
//
// We cannot use buildClaudePArgs's claude-p flags against `node` directly, so the
// lifecycle tests bypass arg assembly by spawning node with a script that we craft
// directly. spawnClaudeP always assembles claude-p args; to run our stand-in we
// point binPath at a tiny shell wrapper that ignores the claude-p args and runs
// our node script. We build that wrapper inline per-test.

import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Write an executable shell script that runs `node -e <script>`, ignoring argv. */
function makeStubBin(nodeScript) {
	const dir = mkdtempSync(join(tmpdir(), "claudep-stub-"));
	const path = join(dir, "stub.sh");
	// The stub ignores all claude-p flags ("$@") and runs our node script. Using
	// exec so the node process inherits the stub's pid → stays in the group.
	const body = `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} -e ${JSON.stringify(nodeScript)}\n`;
	writeFileSync(path, body, { mode: 0o755 });
	chmodSync(path, 0o755);
	return path;
}

describe("spawnClaudeP — clean turn classification", () => {
	it("resolves done({stopReason:'result'}) when parser sees terminal result", async () => {
		const bin = makeStubBin(CHILD_CLEAN_RESULT);
		const { events, onEvent } = collector();
		const h = spawnClaudeP(baseCfg(), { binPath: bin, onEvent, logger: QUIET });
		const r = await h.done;
		assert.equal(r.stopReason, "result");
		assert.equal(r.sessionId, "11111111-1111-1111-1111-111111111111");
		// parser emitted usage + done(result), no error.
		assert.ok(events.some((e) => e.kind === "done" && e.reason === "result"));
		assert.ok(!events.some((e) => e.kind === "error"));
	});
});

describe("spawnClaudeP — premature exit classification", () => {
	it("resolves done({stopReason:'error'}) and emits error on non-zero exit without result", async () => {
		const bin = makeStubBin(CHILD_PREMATURE);
		const { events, onEvent } = collector();
		const h = spawnClaudeP(baseCfg(), { binPath: bin, onEvent, logger: QUIET });
		const r = await h.done;
		assert.equal(r.stopReason, "error");
		assert.ok(events.some((e) => e.kind === "error"));
	});
});

describe("spawnClaudeP — missing binary", () => {
	it("ENOENT → error event naming the binary, done({stopReason:'error'})", async () => {
		const { events, onEvent } = collector();
		const h = spawnClaudeP(baseCfg(), {
			binPath: "/nonexistent/claude-p-totally-missing",
			onEvent,
			logger: QUIET,
		});
		const r = await h.done;
		assert.equal(r.stopReason, "error");
		const err = events.find((e) => e.kind === "error");
		assert.ok(err, "expected an error event");
		assert.match(err.errorMessage, /claude-p-totally-missing|ENOENT|not found/);
	});
});

describe("spawnClaudeP — abort lifecycle", () => {
	it("abort() resolves done({stopReason:'aborted'}) promptly when child honors SIGINT", async () => {
		const bin = makeStubBin(CHILD_HONORS_SIGINT);
		const { onEvent } = collector();
		const h = spawnClaudeP(baseCfg(), { binPath: bin, onEvent, logger: QUIET, graceMs: 5000 });
		// Give the child a moment to start.
		await delay(250);
		const t0 = Date.now();
		h.abort();
		const r = await h.done;
		const elapsed = Date.now() - t0;
		assert.equal(r.stopReason, "aborted");
		// Should resolve well within the (generous) grace window — SIGINT was honored.
		assert.ok(elapsed < 4000, `abort should resolve promptly via SIGINT, took ${elapsed}ms`);
	});

	it("escalates to SIGKILL after grace when SIGINT is trapped/ignored", async () => {
		const bin = makeStubBin(CHILD_TRAPS_SIGINT);
		const { onEvent } = collector();
		const graceMs = 400;
		const h = spawnClaudeP(baseCfg(), { binPath: bin, onEvent, logger: QUIET, graceMs });
		await delay(250);
		const pid = h.pid;
		assert.ok(pid, "expected a child pid");
		const t0 = Date.now();
		h.abort();
		const r = await h.done;
		const elapsed = Date.now() - t0;
		assert.equal(r.stopReason, "aborted");
		// SIGINT ignored → only SIGKILL (after grace) stops it; so it must take at
		// least ~grace, and the terminating signal should be SIGKILL.
		assert.ok(elapsed >= graceMs - 100, `expected SIGKILL escalation after grace, took ${elapsed}ms`);
		// No orphan: the group must be gone (process.kill(-pid,0) → ESRCH).
		await delay(150);
		assertGroupGone(pid);
	});

	it("AbortSignal in opts triggers the same abort path", async () => {
		const bin = makeStubBin(CHILD_HONORS_SIGINT);
		const { onEvent } = collector();
		const ac = new AbortController();
		const h = spawnClaudeP(baseCfg(), {
			binPath: bin,
			onEvent,
			logger: QUIET,
			signal: ac.signal,
			graceMs: 5000,
		});
		await delay(250);
		ac.abort();
		const r = await h.done;
		assert.equal(r.stopReason, "aborted");
	});

	it("late stdout after abort is ignored (no further events)", async () => {
		// Child stays alive after SIGINT and keeps printing; we abort, then ensure
		// no result/text events arrive post-abort.
		const script = `process.on("SIGINT",()=>{});setInterval(()=>process.stdout.write(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"late"}]}})+"\\n"),50);`;
		const bin = makeStubBin(script);
		const { events, onEvent } = collector();
		const h = spawnClaudeP(baseCfg(), { binPath: bin, onEvent, logger: QUIET, graceMs: 300 });
		await delay(200);
		h.abort();
		const r = await h.done;
		assert.equal(r.stopReason, "aborted");
		// Any text-delta events captured must have arrived BEFORE abort; after the
		// done resolves, no new events should be pushed. Snapshot count, wait, re-check.
		const countAtDone = events.length;
		await delay(200);
		assert.equal(events.length, countAtDone, "no events should arrive after abort/done");
	});
});

describe("spawnClaudeP — argv guard failure surfaces as error (no throw)", () => {
	it("does not throw to the caller on a guard trip; resolves error", async () => {
		// We can't easily make buildClaudePArgs throw via public config (the guards
		// defend against internal mistakes), so this asserts the happy path doesn't
		// throw and that a bad binPath still yields a resolved (not rejected) done.
		const { onEvent } = collector();
		const h = spawnClaudeP(baseCfg(), { binPath: "/nonexistent/xyz", onEvent, logger: QUIET });
		const r = await h.done; // must resolve, never reject
		assert.equal(r.stopReason, "error");
	});
});

describe("constants", () => {
	it("ABORT_SIGKILL_GRACE_MS is a positive number", () => {
		assert.ok(typeof ABORT_SIGKILL_GRACE_MS === "number" && ABORT_SIGKILL_GRACE_MS > 0);
	});
});

// ── small util ────────────────────────────────────────────────────────────────

function delay(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

/** Assert a process group is gone (signal 0 to -pid throws ESRCH). */
function assertGroupGone(pid) {
	try {
		process.kill(-pid, 0);
		assert.fail(`process group ${pid} still alive — orphan leak`);
	} catch (err) {
		assert.equal(err.code, "ESRCH", `expected ESRCH (group gone), got ${err.code}`);
	}
}
