#!/usr/bin/env node
// G5 warm-resume RE-ECHO fix — end-to-end verification through real pi + claude-p.
//
// Turn 1 (fresh) establishes a fact with a UNIQUE sentinel word. Turn 2 (warm
// --resume) asks a different question. ASSERTION: pi's turn-2 assistant message
// must contain ONLY the turn-2 answer, NOT turn-1's sentinel re-echoed. Before the
// fix, claude-p replayed turn-1's assistant text and the parser re-emitted it, so
// turn-2's message began with turn-1's text. After the fix, the replayed prefix is
// suppressed (priorUserPromptCount) and only the live turn surfaces.
//
// Run: node .spike-notes/claude-p-gate/g5-warmresume-verify.mjs
// Concurrency 1. Does NOT override CLAUDE_CONFIG_DIR/HOME.

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRpcHarness } from "../../tests/lib/rpc-harness.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = `${REPO}/node_modules/.bin`;
const cleanPath = process.env.PATH.split(":").filter((p) => !p.includes("node_modules")).join(":");
const PATH_WITH_CLAUDE_P = `${BIN}:${cleanPath}`;

const SENTINEL = "ZEBRAFISH-4242";

async function main() {
	const h = createRpcHarness({
		name: "g5-warmresume-verify",
		args: ["--model", "claude-bridge/claude-haiku-4-5"],
		env: { CLAUDE_BRIDGE_DRIVER: "claude-p", PATH: PATH_WITH_CLAUDE_P },
		defaultTimeout: 120_000,
	});
	h.start();
	await new Promise((r) => setTimeout(r, 2500));

	let failed = false;
	try {
		// Turn 1 (fresh): establish the sentinel.
		const t1 = await h.promptAndWait(
			`Remember this code word exactly: ${SENTINEL}. Reply with just the word "stored".`,
			120_000,
		);
		console.log(`TURN 1 text: ${JSON.stringify(t1.trim().slice(0, 200))}`);

		// Turn 2 (warm --resume): a DIFFERENT question whose answer must NOT contain
		// the sentinel. If the re-echo bug is present, turn-1's reply (and possibly
		// the sentinel from the model's turn-1 echo) leaks into turn-2's message.
		const t2 = await h.promptAndWait(
			`Ignore the code word for now. What is 7 plus 6? Reply with just the number.`,
			120_000,
		);
		const t2trim = t2.trim();
		console.log(`TURN 2 text: ${JSON.stringify(t2trim.slice(0, 300))}`);

		// ── ASSERTIONS ──
		// (a) turn-2 message must contain the live answer "13".
		const hasAnswer = /\b13\b/.test(t2trim);
		// (b) turn-2 message must NOT re-echo turn-1's literal reply "stored".
		const reEchoedStored = /\bstored\b/i.test(t2trim);
		// (c) turn-2 message must NOT begin with / contain turn-1's full text as a
		//     prefix (the classic re-echo signature).
		const t1core = t1.trim().toLowerCase();
		const reEchoedT1 = t1core.length > 0 && t2trim.toLowerCase().includes(t1core) && t1core !== t2trim.toLowerCase();

		console.log(`\n  hasAnswer(13)=${hasAnswer}  reEchoedStored=${reEchoedStored}  reEchoedT1Prefix=${reEchoedT1}`);

		if (!hasAnswer) { console.error("FAIL: turn-2 did not contain the live answer 13"); failed = true; }
		if (reEchoedStored) { console.error('FAIL: turn-2 re-echoed turn-1 reply "stored" (RE-ECHO bug present)'); failed = true; }
		if (reEchoedT1) { console.error("FAIL: turn-2 contains turn-1 full text as substring (RE-ECHO bug present)"); failed = true; }

		if (!failed) {
			console.log("\nPASS: turn-2 assistant message = ONLY the live turn (no turn-1 re-echo).");
		}
	} catch (err) {
		console.error("ERROR:", err?.message ?? err);
		failed = true;
	} finally {
		console.log(`\nDebug log: ${h.DEBUG_LOG}`);
		await h.stop();
	}
	process.exit(failed ? 1 : 0);
}

main();
