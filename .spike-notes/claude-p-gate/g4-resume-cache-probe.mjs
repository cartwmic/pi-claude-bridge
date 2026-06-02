#!/usr/bin/env node
// G4 — warm-resume cache-shape (cost+latency HARD GATE; blocks cut-over).
//
// THE QUESTION: the bridge resumes a claude-p session across process boundaries
// via `--resume <id>` (no `--session-id`), pinning a STABLE `--system-prompt`,
// and sending ONLY the new user message per turn. RISK: claude-p's per-spawn
// interactive injections (skill-listing/`attachment`, `ai-title`,
// `file-history-snapshot`, dynamic system-prompt sections) perturb the cached
// PREFIX → Anthropic cache MISS → `cache_creation` every turn instead of
// `cache_read`. That is a NOT-ACCEPTABLE cost/latency regression.
//
// G4 must measure whether `--resume` yields cache_read_input_tokens > 0 (warm)
// across >=6 sequential turns, NOT a full-prefix re-creation each spawn.
//
// METHOD (replicates the bridge's resume contract via the REAL driver):
//   - Turn 1 (cold/fresh): session={kind:"fresh", sessionId:UUID}, a PINNED
//     ~few-KB verbatim --system-prompt (NO dynamic/per-turn sections), and a
//     first user message establishing a memorable fact ("favorite number 4242").
//   - Turns 2-6 (warm): session={kind:"resume", sessionId: SAME UUID}, the SAME
//     pinned --system-prompt, ONLY a new small user message each turn.
//   - ONE claude-p process per turn. STRICTLY SEQUENTIAL (concurrency 1).
//   - Model claude-haiku-4-5. No MCP tools (plain text), but SAME isolation flags
//     the bridge uses (--strict-mcp-config, --setting-sources "", --disallowedTools)
//     so the measured prefix matches production. mcpConfig held CONSTANT.
//   - Build the EXACT production argv via buildClaudePArgs(); parse usage via
//     ClaudePStreamParser (cache_read->cacheRead, cache_creation->cacheWrite).
//
// ENVIRONMENT: do NOT override CLAUDE_CONFIG_DIR / HOME (G2 found claude-p times
// out when overridden). Run against the REAL environment with isolation FLAGS
// only — env is passed through verbatim (no delete, no set).
//
// Run: node --import tsx .spike-notes/claude-p-gate/g4-resume-cache-probe.mjs

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

import { buildClaudePArgs } from "../../src/driver/claudeP.js";
import { ClaudePStreamParser } from "../../src/driver/stream.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..", "..");
const CLAUDE_P_BIN = join(REPO, "node_modules", ".bin", "claude-p");
const NOTES_DIR = join(REPO, ".spike-notes", "claude-p-gate");
const RESULTS_MD = join(NOTES_DIR, "g4-cache-results.md");
const STREAM_OUT = join(NOTES_DIR, "g4-cache-stream.jsonl");

const MODEL = "claude-haiku-4-5";
const MAX_ATTEMPTS = 3;
const TIMEOUT_SECONDS = 180;
const nowIso = () => new Date().toISOString();

// A FIXED, reasonably-large verbatim system prompt: stable text, NO dynamic /
// per-turn sections. ~3.5KB so the prefix is large enough that a cache MISS vs
// HIT is unmistakable in the token counts.
const SYSTEM_PROMPT = (() => {
	const para =
		"You are a meticulous, terse assistant operating inside an automated bridge. " +
		"You follow instructions exactly, never speculate beyond what is asked, and keep replies short. " +
		"You preserve facts established earlier in the conversation with perfect fidelity. " +
		"When asked to recall a previously stated value, you state it precisely and do not hedge. " +
		"You do not invent tools, capabilities, or context that were not provided. ";
	// Repeat to ~3.5KB of STABLE, identical-every-turn text.
	let s = "BRIDGE SYSTEM CONTRACT (v1, stable). ";
	for (let i = 0; i < 12; i++) s += para;
	s += "End of contract.";
	return s;
})();

// The memorable fact + the per-turn warm follow-ups.
const FACT_NUMBER = "4242";
const TURN_PROMPTS = [
	`My favorite number is ${FACT_NUMBER}. Please acknowledge with a single short sentence.`, // turn 1 (fresh)
	`What is my favorite number? Reply with just the number.`, // turn 2 (warm) — coherence probe
	`Add 1 to my favorite number and give only the result.`, // turn 3
	`Is my favorite number even or odd? One word.`, // turn 4
	`Repeat my favorite number twice, space-separated.`, // turn 5
	`State my favorite number one more time, digits only.`, // turn 6
];

function runTurn({ turnIndex, sessionId, session, log }) {
	const promptText = TURN_PROMPTS[turnIndex];
	const cfg = {
		model: MODEL,
		systemPrompt: { kind: "text", text: SYSTEM_PROMPT }, // PINNED, identical every turn
		prompt: { kind: "positional", text: promptText },
		mcpConfig: JSON.stringify({ mcpServers: {} }), // CONSTANT across turns
		session, // fresh on turn 1, resume on 2-6
		timeoutSeconds: TIMEOUT_SECONDS,
	};
	let args;
	try {
		args = buildClaudePArgs(cfg);
	} catch (err) {
		log.push(`[t${turnIndex + 1}] buildClaudePArgs THREW: ${err?.message}`);
		return Promise.resolve({ argError: true, errMsg: err?.message });
	}

	const rawChunks = [];
	let assistantText = "";
	let usage = null;
	let sawResult = false;
	const parser = new ClaudePStreamParser({
		logger: { warn() {} },
		onEvent: (e) => {
			if (e.kind === "text-delta") assistantText += e.text;
			if (e.kind === "usage") usage = e.usage;
			if (e.kind === "done" && e.reason === "result") sawResult = true;
		},
	});

	// DO NOT override CLAUDE_CONFIG_DIR / HOME — pass the real env through verbatim.
	const env = { ...process.env };

	return new Promise((res) => {
		const child = spawn(CLAUDE_P_BIN, args, { detached: true, stdio: ["ignore", "pipe", "pipe"], env });
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (c) => { rawChunks.push(c); parser.write(c); });
		const stderrChunks = [];
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (c) => stderrChunks.push(c));
		child.on("close", (code, signal) => {
			parser.endOfStream({ aborted: false, exitInfo: { code, signal } });
			const raw = rawChunks.join("");
			const stderr = stderrChunks.join("");
			const argRejected = /unknown option|invalid|unexpected argument|error: unknown/i.test(stderr);
			log.push(`[t${turnIndex + 1}] EXIT code=${code} signal=${signal} sawResult=${sawResult} argRejected=${argRejected} ${usage ? `usage in=${usage.input} cw=${usage.cacheWrite} cr=${usage.cacheRead} out=${usage.output}` : "usage=NONE"}`);
			if (stderr.trim()) log.push(`[t${turnIndex + 1}] STDERR ${stderr.replace(/\n/g, " ").slice(0, 300)}`);
			res({
				exitCode: code, signal, sawResult, argError: false, argRejected,
				raw, assistantText, usage, stderr,
			});
		});
		child.on("error", (err) => res({ exitCode: null, signal: null, spawnErr: err?.message, raw: "", assistantText: "", usage: null }));
	});
}

function isFlake(r) {
	// A flake = no clean result and no usage, and NOT an arg error (arg error is a
	// real negative). SessionStart/StopTimeout boot flakes have no usable result.
	return !r.argError && !r.argRejected && (!r.sawResult || !r.usage);
}

// Run a single turn with bounded retry. Returns {result, attempts:[...]}.
async function runTurnWithRetry({ turnIndex, sessionId, session, log }) {
	const attempts = [];
	let last = null;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		log.push(`----- TURN ${turnIndex + 1} (${session.kind}) ATTEMPT ${attempt} ${nowIso()} -----`);
		const r = await runTurn({ turnIndex, sessionId, session, log });
		attempts.push({ attempt, exit: r.exitCode, sawResult: r.sawResult, hasUsage: !!r.usage, argRejected: r.argRejected, argError: r.argError });
		last = r;
		if (r.argError || r.argRejected) break;
		if (r.sawResult && r.usage) break;
		if (!isFlake(r)) break;
		log.push(`[t${turnIndex + 1}] FLAKE (sawResult=${r.sawResult} usage=${!!r.usage}) — retrying`);
	}
	return { result: last, attempts };
}

(async () => {
	mkdirSync(NOTES_DIR, { recursive: true });
	if (!existsSync(CLAUDE_P_BIN)) throw new Error(`claude-p binary missing at ${CLAUDE_P_BIN}`);

	const sessionId = randomUUID();
	const log = [];
	const turns = []; // per-turn record
	const allRaw = [];

	log.push(`===== G4 warm-resume cache-shape — sessionId=${sessionId} =====`);
	log.push(`system-prompt bytes=${Buffer.byteLength(SYSTEM_PROMPT, "utf8")} model=${MODEL}`);

	for (let i = 0; i < TURN_PROMPTS.length; i++) {
		const session = i === 0
			? { kind: "fresh", sessionId }
			: { kind: "resume", sessionId };
		const { result, attempts } = await runTurnWithRetry({ turnIndex: i, sessionId, session, log });
		allRaw.push(`\n===== TURN ${i + 1} (${session.kind}) sessionId=${sessionId} =====\n` + (result?.raw ?? ""));
		turns.push({
			turn: i + 1,
			kind: session.kind,
			prompt: TURN_PROMPTS[i],
			assistantText: (result?.assistantText ?? "").trim(),
			usage: result?.usage ?? null,
			sawResult: result?.sawResult ?? false,
			argRejected: result?.argRejected ?? false,
			argError: result?.argError ?? false,
			attempts,
		});
	}

	writeFileSync(STREAM_OUT, allRaw.join("\n"), "utf8");

	// ── Analysis ───────────────────────────────────────────────────────────────
	const warm = turns.filter((t) => t.kind === "resume");
	const warmWithUsage = warm.filter((t) => t.usage);
	const warmAllRead = warmWithUsage.length > 0 && warmWithUsage.every((t) => t.usage.cacheRead > 0);
	const turn1 = turns[0];
	const turn1Prefix = turn1.usage ? (turn1.usage.cacheWrite + turn1.usage.cacheRead) : 0; // approx stable-prefix size from cold turn

	// "delta-sized" = warm cache_creation is much smaller than the cold prefix.
	// We compare each warm cacheWrite against the cold-turn prefix size.
	const warmDeltaSized = warmWithUsage.length > 0 && warmWithUsage.every((t) => {
		if (turn1Prefix <= 0) return t.usage.cacheWrite < 2000; // fallback abs threshold
		return t.usage.cacheWrite < turn1Prefix * 0.5; // creation < half the cold prefix => delta, not full re-create
	});

	// Coherence: turn 2 recalls 4242.
	const turn2 = turns[1];
	const turn2Recalled = !!(turn2 && turn2.assistantText.includes(FACT_NUMBER));

	// Injection diagnosis — scan raw transcripts for the suspect per-spawn lines.
	const rawAll = allRaw.join("\n");
	const countType = (re) => (rawAll.match(re) || []).length;
	const injection = {
		attachment: countType(/"type"\s*:\s*"attachment"/g),
		aiTitle: countType(/"type"\s*:\s*"ai-title"/g),
		fileHistorySnapshot: countType(/"type"\s*:\s*"file-history-snapshot"/g),
		mode: countType(/"type"\s*:\s*"mode"/g),
		permissionMode: countType(/"type"\s*:\s*"permission-mode"/g),
	};

	const PASS = warmAllRead && warmDeltaSized && turn2Recalled
		&& warmWithUsage.length >= 5; // turns 2-6 all produced usage

	// ── Per-turn table ───────────────────────────────────────────────────────────
	const tableRows = turns.map((t) => {
		const u = t.usage;
		return `| ${t.turn} (${t.kind}) | ${u ? u.input : "—"} | ${u ? u.cacheWrite : "—"} | ${u ? u.cacheRead : "—"} | ${u ? u.output : "—"} | ${JSON.stringify(t.assistantText.slice(0, 40))} |`;
	});

	const lines = [];
	lines.push(`# G4 — warm-resume cache-shape (HARD GATE; cost+latency; blocks cut-over)`);
	lines.push("");
	lines.push(`**Date:** ${nowIso()} · claude-p 0.1.0 · claude 2.1.159 · model ${MODEL}`);
	lines.push(`**Session:** ${sessionId} (turn 1 fresh \`--session-id\`, turns 2-6 \`--resume\` same id)`);
	lines.push(`**System prompt:** PINNED ${Buffer.byteLength(SYSTEM_PROMPT, "utf8")} bytes, identical every turn, NO dynamic sections. mcpConfig constant. Isolation flags identical to production (\`--strict-mcp-config\`, \`--setting-sources ""\`, \`--disallowedTools …\`). Env passed through verbatim (CLAUDE_CONFIG_DIR / HOME NOT overridden).`);
	lines.push(`**Concurrency:** 1 (strictly sequential, one claude-p alive at a time).`);
	lines.push("");
	lines.push(`## VERDICT: ${PASS ? "PASS" : "FAIL"}`);
	lines.push("");
	if (!PASS) {
		lines.push(`Triggers the **T4.10 fork** (strip/pin the per-spawn injections) iff the FAIL is caused by injection-perturbed prefix (warm \`cache_read\`=0 or \`cache_creation\`≈full prefix every warm turn). If the FAIL is only flakiness/no-usage, re-run before concluding.`);
		lines.push("");
	}
	lines.push(`- warm turns (2-6) all have \`cache_read\` > 0: **${warmAllRead}**`);
	lines.push(`- warm \`cache_creation\` is delta-sized (< 50% of cold prefix ${turn1Prefix}): **${warmDeltaSized}**`);
	lines.push(`- turn 2 recalled "${FACT_NUMBER}" (coherence): **${turn2Recalled}**`);
	lines.push(`- warm turns producing usage: **${warmWithUsage.length}/5**`);
	lines.push("");
	lines.push(`## Per-turn usage`);
	lines.push("");
	lines.push(`| turn | input | cache_creation (write) | cache_read | output | assistant (truncated) |`);
	lines.push(`|------|-------|------------------------|------------|--------|------------------------|`);
	lines.push(...tableRows);
	lines.push("");
	lines.push(`## Coherence`);
	lines.push("");
	lines.push(`Turn 2 prompt: ${JSON.stringify(TURN_PROMPTS[1])}`);
	lines.push(`Turn 2 reply: ${JSON.stringify(turn2?.assistantText ?? "")}`);
	lines.push(`Recalled ${FACT_NUMBER}: **${turn2Recalled}** → \`--resume\` ${turn2Recalled ? "restored the conversation (not a blank session)" : "did NOT restore the prior turn"}.`);
	lines.push("");
	lines.push(`## Injection diagnosis (per-spawn line counts across all transcripts)`);
	lines.push("");
	lines.push("```json");
	lines.push(JSON.stringify(injection, null, 2));
	lines.push("```");
	lines.push(`Interpretation: these are the suspect per-spawn interactive injections. If warm cache_read is high and creation is delta-sized DESPITE these lines appearing, then they do NOT enter the cached prompt prefix (they are local stdout markers, not API prompt content) and pinning \`--system-prompt\` + avoiding dynamic sections IS sufficient. If warm creation ≈ full prefix, identify which injection shifted the prefix.`);
	lines.push("");
	lines.push(`## Flakiness`);
	lines.push("");
	for (const t of turns) {
		lines.push(`- turn ${t.turn} (${t.kind}): attempts=${JSON.stringify(t.attempts)}`);
	}
	lines.push("");
	lines.push(`## Raw run log`);
	lines.push("```");
	lines.push(...log);
	lines.push("```");
	writeFileSync(RESULTS_MD, lines.join("\n") + "\n", "utf8");

	console.log(`\n=== G4 VERDICT: ${PASS ? "PASS" : "FAIL"} ===`);
	console.log(`warmAllRead=${warmAllRead} warmDeltaSized=${warmDeltaSized} turn2Recalled=${turn2Recalled} warmUsage=${warmWithUsage.length}/5 coldPrefix=${turn1Prefix}`);
	console.table(turns.map((t) => ({ turn: `${t.turn} ${t.kind}`, input: t.usage?.input ?? "—", cache_creation: t.usage?.cacheWrite ?? "—", cache_read: t.usage?.cacheRead ?? "—", output: t.usage?.output ?? "—", reply: t.assistantText.slice(0, 24) })));
	console.log(`injection=${JSON.stringify(injection)}`);
	console.log(`Results -> ${RESULTS_MD}`);
})();
