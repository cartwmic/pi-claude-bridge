#!/usr/bin/env node
// T1.13 — abort mid-turn (mechanics) through real pi + real claude-p.
//
// Drives pi (RPC mode, CLAUDE_BRIDGE_DRIVER=claude-p, model
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

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = `${REPO}/node_modules/.bin`;
const cleanPath = process.env.PATH.split(":").filter((p) => !p.includes("node_modules")).join(":");
const PATH_WITH_CLAUDE_P = `${BIN}:${cleanPath}`;

const harness = createRpcHarness({
	name: "claude-p-abort",
	// Load the slow-tool extension so we can park a turn on a held tool — the
	// deterministic mid-turn abort window on claude-p (see header note).
	args: ["-e", "./tests/fixtures/slow-tool-extension.ts", "--model", "claude-bridge/claude-haiku-4-5"],
	env: { CLAUDE_BRIDGE_DRIVER: "claude-p", PATH: PATH_WITH_CLAUDE_P },
	defaultTimeout: TEST_TIMEOUT,
});

// Count live claude-p / claude processes. Best-effort: any matching process is
// a candidate orphan once our turn has ended (we run concurrency 1, so there
// should be none between turns).
function liveClaudeProcs() {
	try {
		const out = execSync("ps -axo pid,command", { encoding: "utf8" });
		return out
			.split("\n")
			.filter((l) => /\b(claude-p\b|node .*\bclaude-p\b|\/claude\b|\bclaude\s+(-p|--print|--output-format))/.test(l))
			.filter((l) => !/int-claude-p-abort|node --test|rpc-harness|grep|ps -axo/.test(l))
			.map((l) => l.trim());
	} catch {
		return [];
	}
}

describe("claude-p abort mid-turn mechanics (T1.13)", () => {
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

		const baseline = liveClaudeProcs();

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

		// (1) driver SIGINTed the claude-p subprocess.
		const dbg = readFileSync(DEBUG_LOG, "utf8");
		assert.match(
			dbg,
			/claudeP\.lifecycle\.abort|aborting claude-p \(SIGINT to group\)/,
			"bridge debug log must show claude-p SIGINT-on-abort",
		);

		// (3) No orphan claude-p / claude process. Allow a grace window for the
		// SIGINT → exit → reapGroup cleanup to complete.
		let orphans = [];
		for (let i = 0; i < 20; i++) {
			orphans = liveClaudeProcs().filter((l) => !baseline.includes(l));
			if (orphans.length === 0) break;
			await new Promise((r) => setTimeout(r, 500));
		}
		assert.equal(
			orphans.length,
			0,
			`orphan claude-p/claude process(es) survived abort:\n${orphans.join("\n")}`,
		);
		console.log(`  no orphan claude-p/claude processes after abort`);
	});
});
