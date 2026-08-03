#!/usr/bin/env node
// Context continuity test for pi-claude-bridge provider.
// Verifies that switching away and back delivers missed messages through the
// warm delta, and that caller abort preserves the same resumable driver session.
//
// Requires: pi CLI and selected Claude subprocess driver.
// Requires: CLAUDE_BRIDGE_TESTING_ALT_PROVIDER (e.g. "minimax")
// Requires: CLAUDE_BRIDGE_TESTING_ALT_MODEL (e.g. "MiniMax-M2.7-highspeed")

console.log("=== session-resume-test.mjs ===");

import { readFileSync } from "node:fs";
import { createRpcHarness, requireEnv } from "./lib/rpc-harness.mjs";

const OTHER_PROVIDER = requireEnv("CLAUDE_BRIDGE_TESTING_ALT_PROVIDER");
const OTHER_MODEL = requireEnv("CLAUDE_BRIDGE_TESTING_ALT_MODEL");

const TIMEOUT = 180_000;
const BRIDGE_MODEL = "claude-bridge/claude-haiku-4-5";

// Random words to avoid Claude memorizing test values across runs
const WORD_A = `alpha${Math.random().toString(36).slice(2, 6)}`;
const WORD_B = `beta${Math.random().toString(36).slice(2, 6)}`;
const WORD_C = `gamma${Math.random().toString(36).slice(2, 6)}`;

// Use harness but with custom args - start on non-provider model
const harness = createRpcHarness({
	name: "session-resume",
	args: ["--model", `${OTHER_PROVIDER}/${OTHER_MODEL}`],
	defaultTimeout: TIMEOUT,
});

const { DIR, start, stop, send, addListener, collectText, DEBUG_LOG, RPC_LOG } = harness;

function waitForIdle(timeout = TIMEOUT) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("Timeout waiting for idle")), timeout);
		const remove = addListener((msg) => {
			if (msg.type === "agent_end") {
				clearTimeout(timer);
				remove();
				resolve(msg);
			}
		});
	});
}

async function promptAndWait(message) {
	const collector = collectText();
	await send({ type: "prompt", message });
	await waitForIdle();
	return collector.stop();
}

async function finish(code, msg) {
	console.log(msg);
	if (code !== 0) console.log(`  Log: ${RPC_LOG}`);
	await stop();
	process.exitCode = code;
}

// Start pi
harness.start();
await new Promise((r) => setTimeout(r, 2000));

try {
  // Turn 1: Non-provider prompt — establishes context before our provider is used
  console.log("Turn 1: Non-provider prompt (establish context)...");
  const text1 = await promptAndWait(`The secret word is '${WORD_A}'. Acknowledge and be very brief.`);
  if (!text1) throw new Error("Turn 1 produced no text");
  console.log(`  Response: ${text1.slice(0, 80)}`);

  // Switch to provider — first provider turn with prior history (Case 2)
  const [bridgeProvider, bridgeModelId] = BRIDGE_MODEL.split("/");
  console.log(`Switching to ${BRIDGE_MODEL}...`);
  await send({ type: "set_model", provider: bridgeProvider, modelId: bridgeModelId });


  // Turn 2: First provider turn — should see WORD_A from prior non-provider history
  console.log("Turn 2: First provider turn with prior history (Case 2)...");
  const text2 = await promptAndWait(
    `The backup word is '${WORD_B}'. Also, what was the secret word? Reply with both words separated by a comma.`
  );
  console.log(`  Response: ${text2.slice(0, 80)}`);
  const lower2 = text2.toLowerCase();
  if (!lower2.includes(WORD_A)) throw new Error(`Turn 2 response missing '${WORD_A}': ${text2}`);
  if (!lower2.includes(WORD_B)) throw new Error(`Turn 2 response missing '${WORD_B}': ${text2}`);

  // Switch to other model — creates missed messages
  console.log(`Switching to ${OTHER_PROVIDER}/${OTHER_MODEL}...`);
  await send({ type: "set_model", provider: OTHER_PROVIDER, modelId: OTHER_MODEL });

  // Turn 3: Non-provider prompt — adds context that provider must see on switch-back
  console.log("Turn 3: Non-provider prompt (creates missed messages)...");
  const text3 = await promptAndWait(`The third word is '${WORD_C}'. Acknowledge briefly.`);
  if (!text3) throw new Error("Turn 3 produced no text");
  console.log(`  Response: ${text3.slice(0, 80)}`);

  // Switch back to provider — context includes all prior turns (Case 4)
  console.log(`Switching back to ${BRIDGE_MODEL}...`);
  await send({ type: "set_model", provider: bridgeProvider, modelId: bridgeModelId });


  // Turn 4: Provider resumes with missed messages (Case 4)
  console.log("Turn 4: Provider resume with missed messages (Case 4)...");
  const text4 = await promptAndWait(
    "What were all three words? Reply with just the three words separated by commas."
  );
  console.log(`  Response: ${text4.slice(0, 80)}`);
  const lower4 = text4.toLowerCase();
  if (!lower4.includes(WORD_A)) throw new Error(`Turn 4 response missing '${WORD_A}': ${text4}`);
  if (!lower4.includes(WORD_B)) throw new Error(`Turn 4 response missing '${WORD_B}': ${text4}`);
  if (!lower4.includes(WORD_C)) throw new Error(`Turn 4 response missing '${WORD_C}': ${text4}`);

  // Turn 5: Abort mid-stream — session should be invalidated, next turn should recover
  console.log("Turn 5: Abort mid-stream (session recovery)...");
  await send({ type: "prompt", message: "Write a detailed 500-word essay about the history of timekeeping." });
  // Set up idle listener before abort so we don't miss agent_end
  const idle5 = waitForIdle();
  await new Promise((r) => setTimeout(r, 2000));
  await send({ type: "abort" });
  await idle5;


  // Turn 6: Provider turn after abort — should NOT get "conversation not found"
  console.log("Turn 6: Provider turn after abort (should recover)...");
  const text6 = await promptAndWait(
    "What were all three words from earlier? Reply with just the three words separated by commas."
  );
  console.log(`  Response: ${text6.slice(0, 80)}`);
  const lower6 = text6.toLowerCase();
  if (!lower6.includes(WORD_A)) throw new Error(`Turn 6 response missing '${WORD_A}': ${text6}`);
  if (!lower6.includes(WORD_B)) throw new Error(`Turn 6 response missing '${WORD_B}': ${text6}`);
  if (!lower6.includes(WORD_C)) throw new Error(`Turn 6 response missing '${WORD_C}': ${text6}`);

  // Current subprocess architecture keeps one selected-driver session through
  // provider switches and caller abort. Missed messages ride the warm delta;
  // abort finalization retains the typed session hint instead of rotating it.
  const debugLog = readFileSync(DEBUG_LOG, "utf8");
  const spawns = [...debugLog.matchAll(/streamSimple\[(claude-p|claude-print)\]: fresh spawn[^\n]*resume=(no|[a-f0-9-]+)/g)];
  const coldSpawns = spawns.filter((match) => match[2] === "no");
  const resumedIds = spawns.filter((match) => match[2] !== "no").map((match) => match[2]);
  const uniqueResumedIds = new Set(resumedIds);
  if (coldSpawns.length !== 1) throw new Error(`expected exactly one cold selected-driver spawn, got ${coldSpawns.length}`);
  if (resumedIds.length < 3) throw new Error(`expected at least three warm selected-driver spawns, got ${resumedIds.length}`);
  if (uniqueResumedIds.size !== 1) throw new Error(`expected one stable resumed session id, got: ${[...uniqueResumedIds].join(", ")}`);
  if (!/finalizeClaudePFrame: caching session=[a-f0-9-]+ \(aborted\)/.test(debugLog)) {
    throw new Error("aborted turn did not preserve its selected-driver session hint");
  }
  console.log(`  selected-driver session remained stable across switch + abort: ${[...uniqueResumedIds][0]}`);

  await finish(0, "PASS");
} catch (e) {
  await finish(1, `FAIL: ${e.message}`);
}

