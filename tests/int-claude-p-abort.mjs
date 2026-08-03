#!/usr/bin/env node
// Authenticated abort-mid-turn contract through real pi and selected driver.
//
// Drives pi (RPC mode, CLAUDE_BRIDGE_DRIVER=claude-p|claude-print, model
// claude-bridge/claude-haiku-4-5), parks a turn on a HELD TOOL, then aborts
// mid-turn via the RPC `abort` command (pi's app.interrupt → AbortSignal →
// bridge onAbort[claude-p] → claudeHandle.abort() → SIGINT to the claude-p
// process group).
//
// WHY A HELD TOOL (not text streaming): claude-p (`--print --output-format
// stream-json`) buffers turn text PER-BLOCK — a "count 1..100" turn is usually
// emitted as ONE text block → ONE text_delta at turn-END, with no incremental
// mid-stream. So "waitForMatch(text_delta) → sleep → abort" has no live window
// to abort into: the turn finishes (~3s) before/as the abort lands, leaving
// nothing to interrupt and a post-abort agent_end wait that times out. The
// DETERMINISTIC mid-turn window on claude-p is a HELD TOOL CALL: pi parks on
// SlowTool's promise for the full duration, so the abort reliably lands while
// the turn is genuinely in-flight (mirrors the reliable S8 sub-test in
// int-claude-p-abort-coherence.mjs and "abort during tool execution recovers
// cleanly" in int-tool-message.mjs). The abort MECHANICS being asserted are
// identical — only the trigger changed from text-streaming to a held tool.
//
// ASSERTIONS:
//   1. The driver SIGINTs the claude-p subprocess — bridge debug log shows
//      `claudeP.lifecycle.abort` (SIGINT to group).
//   2. The pi turn resolves PROMPTLY as aborted: an agent_end arrives shortly
//      after the abort WITHOUT waiting for a terminal claude-p `result`. We
//      bound the resolve latency well under the 600s claude-p timeout.
//   3. No orphan claude-p / claude process survives: after the turn ends, no
//      claude-p (or its child `claude`) process spawned by THIS pi remains.
//   4. A following turn warm-resumes the pre-abort session, repairs/closes the
//      dangling held call, and returns a live answer.
//
// Concurrency 1. Does NOT override CLAUDE_CONFIG_DIR/HOME. Retries flaky turns.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const TEST_TIMEOUT = 120_000;
const DRIVER = process.env.CLAUDE_BRIDGE_DRIVER ?? "claude-print";
const MODEL = process.env.CLAUDE_BRIDGE_INTEGRATION_MODEL ?? "claude-sonnet-4-6";
assert.match(DRIVER, /^(claude-p|claude-print)$/);

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = `${REPO}/node_modules/.bin`;
const cleanPath = process.env.PATH.split(":").filter((p) => !p.includes("node_modules")).join(":");
const PATH_WITH_CLAUDE_P = `${BIN}:${cleanPath}`;

const harness = createRpcHarness({
	name: `${DRIVER}-abort`,
	// Load the slow-tool extension so we can park a turn on a held tool — the
	// deterministic mid-turn abort window on claude-p (see header note).
	args: ["-e", "./tests/fixtures/slow-tool-extension.ts", "--model", `claude-bridge/${MODEL}`],
	env: { CLAUDE_BRIDGE_DRIVER: DRIVER, PATH: PATH_WITH_CLAUDE_P },
	defaultTimeout: TEST_TIMEOUT,
});

async function waitForDebugLog(pattern, timeoutMs = 3000) {
	const deadline = Date.now() + timeoutMs;
	let contents = "";
	while (Date.now() < deadline) {
		contents = readFileSync(harness.DEBUG_LOG, "utf8");
		if (pattern.test(contents)) return contents;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return contents;
}

function processTable() {
	try {
		return execSync("ps -axo pid=,ppid=,command=", { encoding: "utf8" })
			.split("\n")
			.map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/))
			.filter(Boolean)
			.map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }));
	} catch {
		return [];
	}
}

// Snapshot only driver descendants owned by this harness. A global process-name
// diff is unsafe: another live pi session may start Claude while this test runs.
function ownedClaudeDescendants(rootPid) {
	const rows = processTable();
	const descendants = new Set([rootPid]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const row of rows) {
			if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
				descendants.add(row.pid);
				changed = true;
			}
		}
	}
	return rows.filter((row) =>
		descendants.has(row.pid)
		&& /\b(claude-p\b|node .*\bclaude-p\b|\/claude\b|\bclaude\s+(-p|--print|--output-format))/.test(row.command)
	);
}

describe(`${DRIVER} abort mid-turn mechanics`, () => {
	const { RPC_LOG, DEBUG_LOG } = harness;

	before(async () => {
		harness.start();
		await new Promise((r) => setTimeout(r, 2000));
	});

	after(async () => {
		await harness.stop();
		console.log(`  RPC log: ${RPC_LOG}`);
		console.log(`  Debug log: ${DEBUG_LOG}`);
	});

	it("aborts mid-turn (held tool): SIGINT, prompt resolves aborted promptly, no orphan", { timeout: TEST_TIMEOUT }, async () => {
		const { send, waitForEvent, collectText, addListener } = harness;

		const ownedDriverPids = new Set();

		// Warm-up text turn to clear cold-start MCP latency (so SlowTool is
		// registered/surfaced before the held-abort attempt).
		{
			const c = collectText();
			await send({ type: "prompt", message: "Reply with the single word READY." });
			await waitForEvent("agent_end", 90_000);
			c.stop();
		}

		let lastErr = null;
		let ok = false;
		for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
			let aborted = false;
			let sawToolExec = false;
			const collector = collectText();
			// Mark whether an `error`/`done` reason reached pi as "aborted".
			let endReason = null;
			const removeEnd = addListener((msg) => {
				if (msg.type === "tool_execution_start") sawToolExec = true;
				if (msg.type === "message_update") {
					const ae = msg.assistantMessageEvent;
					if (ae?.type === "error" && ae.reason) endReason = ae.reason;
				}
				if (msg.type === "agent_end" && msg.reason) endReason = endReason ?? msg.reason;
			});
			try {
				// Park the turn on a long held tool (30s) — the deterministic
				// mid-turn abort window on claude-p (see header note). pi blocks on
				// SlowTool's promise, so the abort lands while the turn is genuinely
				// in-flight, NOT after a buffered text burst already finished it.
				await send({
					type: "prompt",
					message: "Call SlowTool with seconds=30. Just call the tool, say nothing first.",
				});
				// Wait for the tool to actually start executing (the deterministic
				// signal the turn is mid-flight and the tool is held) before aborting.
				await waitForEvent("tool_execution_start", 40_000);
				const piPid = harness.pi()?.pid;
				assert.ok(piPid, "RPC harness pi process has no pid");
				const owned = ownedClaudeDescendants(piPid);
				assert.ok(owned.length > 0, `no ${DRIVER} process found below harness pi pid ${piPid}`);
				for (const row of owned) ownedDriverPids.add(row.pid);
				// Let the tool sit held for a beat, then abort while it is parked.
				await new Promise((r) => setTimeout(r, 700));

				const idle = waitForEvent("agent_end", 30_000); // MUST resolve well under claude-p's 600s timeout
				const abortAt = Date.now();
				await send({ type: "abort" });
				await idle;
				const resolveMs = Date.now() - abortAt;
				aborted = true;

				assert.ok(sawToolExec, "expected SlowTool to reach execution (held) before abort");
				assert.ok(
					resolveMs < 25_000,
					`pi turn must resolve promptly after abort (no waiting for terminal result); took ${resolveMs}ms`,
				);
				ok = true;
				console.log(`  resolve-after-abort: ${resolveMs}ms; endReason=${endReason}`);
			} catch (err) {
				lastErr = err;
			} finally {
				collector.stop();
				removeEnd();
			}
			if (!ok && harness.pi()?.exitCode !== null) {
				harness.start();
				await new Promise((r) => setTimeout(r, 2000));
			}
			if (!aborted && !ok) {
				// give pi a moment to settle before retry
				await new Promise((r) => setTimeout(r, 1000));
			}
		}
		assert.ok(ok, `abort mid-turn did not complete cleanly after 3 attempts: ${lastErr?.message}`);

		// (1) selected driver interrupted its subprocess group.
		const abortPattern = DRIVER === "claude-print"
			? /claudePrint\.lifecycle\.abort|aborting claude-print/
			: /claudeP\.lifecycle\.abort|aborting claude-p \(SIGINT to group\)/;
		// Driver lifecycle logging is asynchronous; agent_end can arrive before
		// rotating-file-stream flushes the same-millisecond abort record.
		const dbg = await waitForDebugLog(abortPattern);
		assert.match(dbg, abortPattern, `bridge debug log must show ${DRIVER} abort`);

		// (3) No orphan claude-p / claude process. Allow a grace window for the
		// SIGINT → exit → reapGroup cleanup to complete.
		let orphans = [];
		for (let i = 0; i < 20; i++) {
			orphans = processTable().filter((row) => ownedDriverPids.has(row.pid));
			if (orphans.length === 0) break;
			await new Promise((r) => setTimeout(r, 500));
		}
		assert.equal(
			orphans.length,
			0,
			`owned driver process(es) survived abort:\n${orphans.map((row) => `${row.pid} ${row.command}`).join("\n")}`,
		);
		console.log(`  no orphan claude-p/claude processes after abort`);

		// (4) The warm-up established a resumable driver session before the held
		// call. Recovery must use that same-driver hint rather than silently cold
		// replaying after the dangling call left by abort.
		const debugBeforeRecovery = readFileSync(DEBUG_LOG, "utf8").length;
		const recovery = collectText();
		await send({ type: "prompt", message: "The prior SlowTool was interrupted. Do not call any tool. Reply with exactly RECOVERED." });
		await waitForEvent("agent_end", 90_000);
		const recoveryText = recovery.stop();
		assert.match(recoveryText, /\bRECOVERED\b/, `post-abort recovery turn failed: ${JSON.stringify(recoveryText)}`);
		const recoveryDebug = readFileSync(DEBUG_LOG, "utf8").slice(debugBeforeRecovery);
		assert.match(
			recoveryDebug,
			new RegExp(`streamSimple\\[${DRIVER}\\]: fresh spawn.*resume=[a-f0-9-]+`),
			"post-abort turn did not warm-resume the dangling selected-driver session",
		);
	});
});
