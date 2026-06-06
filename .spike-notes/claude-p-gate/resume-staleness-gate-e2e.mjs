#!/usr/bin/env node
// SPIKE e2e for the source-level resume-staleness gate (fork branch
// spike/resume-staleness-gate). Drives the LOCALLY-BUILT fork binary through a
// fresh turn then several --resume turns under CPU load, and asserts every
// resume turn's RESULT envelope carries the LIVE answer — never a replayed prior
// answer. The gate (transcript num_turns must grow past the pre-submit baseline)
// is what guarantees this at the source, replacing the bridge-side staleSuspected
// detect+discard.
//
// Run: node --import tsx .spike-notes/claude-p-gate/resume-staleness-gate-e2e.mjs
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { buildClaudePArgs } from "../../src/driver/claudeP.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..", "..");
const FORK_BIN = process.env.FORK_BIN ?? "/Volumes/Workshop/git/claude-p/zig-out/bin/claude-p";
const MODEL = process.env.MODEL ?? "claude-haiku-4-5";
const WORK = "/tmp/resume-staleness-e2e-cwd";
const RESUME_TURNS = Number(process.argv[2] ?? 4);
const LOAD = Number(process.argv[3] ?? 6);

import { rmSync, mkdirSync } from "node:fs";
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

function startLoad(n) {
	const procs = [];
	for (let i = 0; i < n; i++) procs.push(spawn(process.execPath, ["-e", "const e=Date.now()+1e9;while(Date.now()<e){Math.sqrt(Math.random())}"], { stdio: "ignore" }));
	return () => procs.forEach((p) => { try { p.kill("SIGKILL"); } catch {} });
}

// Pull the final answer out of the stream-json `result` envelope (what claude-p
// emits at turn end; its `.result` is the gated final_text). Falls back to the
// last assistant text event. NOT a raw scan — we must read the RESULT, because
// the raw stream on a resume also contains the REPLAYED prior turn's text.
function extractResult(rawOut) {
	let result = null, lastAssistant = null;
	for (const line of rawOut.split("\n")) {
		const s = line.trim();
		if (!s.startsWith("{")) continue;
		let o; try { o = JSON.parse(s); } catch { continue; }
		if (o.type === "result" && typeof o.result === "string") result = o.result;
		if (o.type === "assistant" && o.message?.content) {
			const t = o.message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
			if (t) lastAssistant = t;
		}
	}
	return result ?? lastAssistant ?? "";
}

async function runTurn({ session, prompt }) {
	const cfg = {
		model: MODEL,
		systemPrompt: { kind: "text", text: "You are a terse test agent. Follow instructions exactly." },
		prompt: { kind: "positional", text: prompt },
		mcpConfig: JSON.stringify({ mcpServers: {} }),
		session,
		timeoutSeconds: 120,
	};
	const args = buildClaudePArgs(cfg);
	const child = spawn(FORK_BIN, [...args, "--debug"], { cwd: WORK, detached: true, stdio: ["ignore", "pipe", "pipe"] });
	let out = "", err = "";
	child.stdout.setEncoding("utf8"); child.stdout.on("data", (c) => (out += c));
	child.stderr.setEncoding("utf8"); child.stderr.on("data", (c) => (err += c));
	const exit = await new Promise((res) => { child.on("close", (code, signal) => res({ code, signal })); child.on("error", () => res({ code: null, signal: null })); });
	return { exit, answer: extractResult(out).trim(), staleGuardFired: /resume-staleness guard: transcript never grew/.test(err) };
}

async function main() {
	console.log(`SPIKE: resume-staleness gate e2e — fork=${FORK_BIN}`);
	console.log(`model=${MODEL} cwd=${WORK} resumeTurns=${RESUME_TURNS} load=${LOAD}`);
	const stopLoad = startLoad(LOAD);
	const session = randomUUID();
	const rid = Math.floor(Date.now() % 100000);
	const results = [];
	let staleEmits = 0;
	try {
		// Fresh turn establishes the session + a distinctive prior answer.
		const t0 = `FRESHTOK_${rid}_0`;
		const r0 = await runTurn({ session: { kind: "fresh", sessionId: session }, prompt: `Reply with EXACTLY this token and nothing else: ${t0}` });
		const fresh_ok = r0.answer.includes(t0);
		console.log(`turn 0 (fresh)  exit=${JSON.stringify(r0.exit)} ok=${fresh_ok} answer=${JSON.stringify(r0.answer.slice(0, 40))}`);
		results.push({ i: 0, kind: "fresh", ok: fresh_ok, answer: r0.answer.slice(0, 40) });
		let prevTok = t0;

		// Each subsequent turn is a --resume turn with a fresh unique token. A
		// STALE result would echo an EARLIER turn's token instead of its own.
		for (let i = 1; i <= RESUME_TURNS; i++) {
			const tok = `LIVETOK_${rid}_${i}`;
			const r = await runTurn({ session: { kind: "resume", sessionId: session }, prompt: `Reply with EXACTLY this token and nothing else: ${tok}` });
			const ownOk = r.answer.includes(tok);
			const stale = !ownOk && r.answer.includes(prevTok); // echoed the PRIOR token = stale
			if (stale) staleEmits++;
			const tag = stale ? `  <<< STALE (echoed prior ${prevTok})` : ownOk ? "" : "  <?? neither token>";
			console.log(`turn ${i} (resume) exit=${JSON.stringify(r.exit)} ownOk=${ownOk}${r.staleGuardFired ? " [gate fired→cold]" : ""} answer=${JSON.stringify(r.answer.slice(0, 40))}${tag}`);
			results.push({ i, kind: "resume", ok: ownOk, stale, guardFired: r.staleGuardFired, answer: r.answer.slice(0, 40) });
			prevTok = tok;
		}
	} finally {
		stopLoad();
	}
	const resumeTurns = results.filter((r) => r.kind === "resume");
	const allOwn = resumeTurns.every((r) => r.ok);
	console.log(`\n=== SUMMARY ===`);
	console.log(`resume turns: ${resumeTurns.length}, own-answer-correct: ${resumeTurns.filter((r) => r.ok).length}, STALE emits: ${staleEmits}`);
	console.log(staleEmits === 0 && allOwn
		? "✅ PASS — every resume turn returned its OWN live answer; no stale prior-turn result emitted."
		: `❌ FAIL — ${staleEmits} stale emit(s) / ${resumeTurns.filter((r) => !r.ok).length} non-own answer(s).`);
	process.exit(staleEmits === 0 && allOwn ? 0 : 1);
}
main();
