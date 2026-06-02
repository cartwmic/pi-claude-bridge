#!/usr/bin/env node
// T1.14 — late tool-result after abort, through real pi + real claude-p.
//
// Abort mid-tool-round (SlowTool held). If pi delivers the real tool_result
// shortly after via the NEXT streamSimple() (Case-1 late-delivery capture in
// index.ts ~L1033), the bridge must:
//   - capture it for the aborted frame (resolver fires / pendingResults set)
//     and close the pi stream with an aborted-error WITHOUT hanging,
//   - NOT crash (no stack trace in the bridge log),
//   - let the NEXT user turn proceed as a fresh dispatch.
//
// pi may instead simply finalize the aborted turn (the slow-tool fixture
// rejects on its abort signal, so a real late tool_result is not guaranteed).
// Either way the invariants are: no crash, no orphan, next turn works. When the
// late-delivery path IS taken we additionally observe the Case-1 log marker.
//
// Concurrency 1. Does NOT override CLAUDE_CONFIG_DIR/HOME. Retries flaky turns.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const TEST_TIMEOUT = 150_000;

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = `${REPO}/node_modules/.bin`;
const cleanPath = process.env.PATH.split(":").filter((p) => !p.includes("node_modules")).join(":");
const PATH_WITH_CLAUDE_P = `${BIN}:${cleanPath}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const harness = createRpcHarness({
	name: "claude-p-abort-late-tool-result",
	args: ["-e", "./tests/fixtures/slow-tool-extension.ts", "--model", "claude-bridge/claude-haiku-4-5"],
	env: { CLAUDE_BRIDGE_DRIVER: "claude-p", PATH: PATH_WITH_CLAUDE_P },
	defaultTimeout: TEST_TIMEOUT,
});

async function sendFreshPrompt(message, tries = 25) {
	for (let i = 0; i < tries; i++) {
		try {
			await harness.send({ type: "prompt", message });
			return;
		} catch (err) {
			if (/already processing/i.test(err.message) && i < tries - 1) {
				await sleep(500);
				continue;
			}
			throw err;
		}
	}
}

describe("claude-p late tool-result after abort (T1.14)", () => {
	const { RPC_LOG, DEBUG_LOG } = harness;

	before(async () => {
		harness.start();
		await sleep(2000);
	});

	after(async () => {
		await harness.stop();
		console.log(`  RPC log: ${RPC_LOG}`);
		console.log(`  Debug log: ${DEBUG_LOG}`);
	});

	it("abort mid-tool-round: capture path doesn't crash, next turn is a fresh dispatch", { timeout: TEST_TIMEOUT }, async () => {
		const { send, waitForEvent, addListener, collectText } = harness;
		const baseline = liveClaudeProcs();

		// Warm-up text turn to clear cold-start MCP latency.
		{
			const c = collectText();
			await sendFreshPrompt("Reply with the single word READY.");
			await waitForEvent("agent_end", 90_000);
			c.stop();
		}

		// Drive the held-tool abort, retrying until SlowTool actually executes.
		let toolAborted = false;
		let lastErr = null;
		for (let attempt = 1; attempt <= 3 && !toolAborted; attempt++) {
			let sawToolExec = false;
			const removeExec = addListener((m) => {
				if (m.type === "tool_execution_start") sawToolExec = true;
			});
			try {
				await sendFreshPrompt("Call SlowTool with seconds=15. Just call the tool, say nothing first.");
				await waitForEvent("tool_execution_start", 40_000);
				await sleep(700); // tool held; abort while parked
				const idle = waitForEvent("agent_end", 30_000);
				await send({ type: "abort" });
				await idle;
				if (sawToolExec) toolAborted = true;
				else lastErr = new Error(`SlowTool did not execute (attempt ${attempt})`);
			} catch (err) {
				lastErr = err;
			} finally {
				removeExec();
			}
			if (!toolAborted) await sleep(800);
		}
		assert.ok(toolAborted, `could not abort a held SlowTool round after 3 attempts: ${lastErr?.message}`);

		// Give pi a beat to deliver any late tool_result via the next streamSimple
		// (Case-1 capture). The slow-tool fixture rejects on its abort signal, so a
		// late delivery may or may not materialize — either path must not crash.
		await sleep(1500);

		// Next user turn MUST proceed as a fresh dispatch and produce a marker.
		let marker = null;
		for (let attempt = 1; attempt <= 3 && !marker; attempt++) {
			const c = collectText();
			try {
				await sendFreshPrompt("Reply with exactly the word PINEAPPLE-1714 and nothing else.");
				await waitForEvent("agent_end", 60_000);
				const text = c.stop();
				if (/pineapple-?1714/i.test(text)) marker = text;
				else lastErr = new Error(`no marker (attempt ${attempt}): ${JSON.stringify(text.slice(-120))}`);
			} catch (err) {
				c.stop();
				lastErr = err;
			}
			if (!marker) await sleep(800);
		}
		assert.ok(marker, `next turn after abort did not produce marker: ${lastErr?.message}`);

		// Invariant: no bridge crash (no stack trace in the debug log).
		const dbg = readFileSync(DEBUG_LOG, "utf8");
		assert.ok(!/\n\s+at .*\(.*:\d+:\d+\)/.test(dbg), "bridge debug log contains a stack trace (crash)");
		assert.match(dbg, /claudeP\.lifecycle\.abort|onAbort\[claude-p\]/, "expected claude-p abort lifecycle");

		// Observe whether the Case-1 late-delivery path was exercised (informational).
		const lateDelivery = /tool-result delivery: matched aborted-frame|tool-result delivery to aborted frame|Operation aborted by user \(real tool result captured/.test(dbg);
		console.log(`  Case-1 late-tool-result delivery path exercised: ${lateDelivery}`);

		// No orphan claude-p/claude/sleep process.
		let orphans = [];
		for (let i = 0; i < 20; i++) {
			orphans = liveClaudeProcs().filter((l) => !baseline.includes(l));
			if (orphans.length === 0) break;
			await sleep(500);
		}
		assert.equal(orphans.length, 0, `orphan process(es) survived:\n${orphans.join("\n")}`);

		console.log(`  T1.14 PASS — capture path did not crash; next turn fresh-dispatched (marker observed); no orphan`);
	});
});
