#!/usr/bin/env node
// Reproduce the warm-resume STALE-RESULT race (real session 019e* / production log
// 2026-06-03 c13c32: a --resume turn delivered the PRIOR turn's byte-identical result
// instead of running the live turn; re-prompting worked).
//
// Hypothesis: under concurrent-boot CPU contention, claude-p on --resume latches the
// REPLAYED terminal state (the prior turn's assistant + stop_hook_summary) and emits a
// `result` reflecting that, before the live prompt's turn runs. The bridge delivers it
// as a (stale) completed turn.
//
// Method: one pi session → every turn after the first is a --resume turn. Fire many
// uniquely-tokened prompts under sustained CPU load. A turn is STALE if its answer
// contains an EARLIER turn's token instead of its own. CLAUDE_P_RAW_DUMP captures the
// raw interactive-fork stream so a caught stale turn can be dissected.
//
// Run: CLAUDE_P_RAW_DUMP=/tmp/foo node .spike-notes/claude-p-gate/resume-stale-repro.mjs [turns] [loadprocs]

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createRpcHarness } from "../../tests/lib/rpc-harness.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = `${REPO}/node_modules/.bin`;
const cleanPath = process.env.PATH.split(":").filter((p) => !p.includes("node_modules")).join(":");
const PATH_WITH_CLAUDE_P = `${BIN}:${cleanPath}`;

const TURNS = Number(process.argv[2] || 24);
const LOAD = Number(process.argv[3] || 6);
const MODEL = process.env.REPRO_MODEL || "claude-haiku-4-5";

// Distinctive tokens the model must echo back verbatim, one per turn.
const tokens = Array.from({ length: TURNS }, (_, i) => `KX${1000 + i}ZQ`);

function startLoad(n) {
	const procs = [];
	for (let i = 0; i < n; i++) {
		// Busy CPU loop — starves the next claude/zmux boot to widen the resume race.
		procs.push(spawn(process.execPath, ["-e", "const e=Date.now()+1e9;while(Date.now()<e){Math.sqrt(Math.random())}"], { stdio: "ignore" }));
	}
	return () => procs.forEach((p) => { try { p.kill("SIGKILL"); } catch {} });
}

async function main() {
	const stopLoad = startLoad(LOAD);
	const h = createRpcHarness({
		name: "resume-stale-repro",
		args: ["--model", `claude-bridge/${MODEL}`],
		env: { CLAUDE_BRIDGE_DRIVER: "claude-p", PATH: PATH_WITH_CLAUDE_P, CLAUDE_P_RAW_DUMP: process.env.CLAUDE_P_RAW_DUMP || "" },
		defaultTimeout: 120_000,
	});
	h.start();
	await new Promise((r) => setTimeout(r, 2500));

	const results = [];
	let staleCount = 0;
	try {
		for (let i = 0; i < TURNS; i++) {
			const tok = tokens[i];
			const text = (await h.promptAndWait(
				`This is turn ${i}. Reply with EXACTLY this token and nothing else: ${tok}`,
				120_000,
			)).trim();
			const ownOk = text.includes(tok);
			// stale if it echoes any EARLIER turn's token
			const staleOf = tokens.slice(0, i).find((t) => text.includes(t));
			const isStale = !ownOk && !!staleOf;
			if (isStale) staleCount++;
			results.push({ i, tok, ownOk, staleOf: staleOf || null, isStale, text: text.slice(0, 60) });
			const tag = isStale ? `  <<< STALE (got ${staleOf}, expected ${tok})` : ownOk ? "" : "  <?? neither>";
			console.log(`turn ${String(i).padStart(2)} resume=${i > 0}  ownOk=${ownOk}  text=${JSON.stringify(text.slice(0, 40))}${tag}`);
		}
	} catch (err) {
		console.error("ERROR:", err?.message ?? err);
	} finally {
		stopLoad();
		console.log(`\nSTALE turns: ${staleCount}/${TURNS - 1} resume turns`);
		console.log(`Debug log: ${h.DEBUG_LOG}`);
		console.log(`Raw dumps: ${process.env.CLAUDE_P_RAW_DUMP}`);
		await h.stop();
	}
	process.exit(staleCount > 0 ? 0 : 3); // exit 3 = could not reproduce
}

main();
