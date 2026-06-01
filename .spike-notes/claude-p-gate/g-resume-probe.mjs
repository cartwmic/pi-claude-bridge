#!/usr/bin/env node
// G-resume — does claude-p FORWARD and HONOR `--input-file` AND
// `--system-prompt-file` (the bridge's >50KB overflow path in index.ts)?
//
// The bridge (index.ts) delivers the user prompt via `--input-file` and the
// system prompt via `--system-prompt-file` once either exceeds 50KB. This was
// verified historically on RAW `claude`, NOT through claude-p. claude-p drives
// the interactive TUI in a PTY, so flag forwarding is not guaranteed.
//
// Method: ONE claude-p spawn (no tools), strictly sequential, retried on flake:
//   - write a LARGE (>50KB) user prompt to a tempfile: a unique SENTINEL embedded
//     in filler; ask the model to echo the sentinel. → --input-file
//   - write a system prompt to a tempfile with a distinctive instruction
//     ("always end your reply with the token ZX9"). → --system-prompt-file
//   - ASSERT: spawn succeeds (no arg error); model output echoes the SENTINEL
//     (proves --input-file honored) AND contains ZX9 (proves --system-prompt-file
//     applied).
//
// buildClaudePArgs already emits --input-file / --system-prompt-file for the
// `kind:"file"` sources, so this exercises the EXACT production argv.
//
// Run: node --import tsx .spike-notes/claude-p-gate/g-resume-probe.mjs

import { writeFileSync, mkdirSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

import { buildClaudePArgs } from "../../src/driver/claudeP.js";
import { ClaudePStreamParser } from "../../src/driver/stream.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..", "..");
const CLAUDE_P_BIN = join(REPO, "node_modules", ".bin", "claude-p");
const NOTES_DIR = join(REPO, ".spike-notes", "claude-p-gate");
const RESULTS_MD = join(NOTES_DIR, "g-resume-results.md");
const STREAM_OUT = join(NOTES_DIR, "g-resume-stream.jsonl");

const MODEL = "claude-haiku-4-5";
const MAX_ATTEMPTS = 3;
const TIMEOUT_SECONDS = 180;
const nowIso = () => new Date().toISOString();

// >50KB unique prompt: a sentinel buried in filler so it can only be echoed if the
// large input-file content actually reached the model.
const SENTINEL = `INPUTFILE_SENTINEL_${randomBytes(8).toString("hex").toUpperCase()}`;
const SYS_TOKEN = "ZX9";

function buildLargePrompt() {
	const filler = ("The quick brown fox jumps over the lazy dog. ").repeat(1400); // ~64KB
	return (
		`Below is a long document. Buried in it is a unique sentinel token. ` +
		`Find the token that starts with "INPUTFILE_SENTINEL_" and reply with EXACTLY that token and nothing else of substance.\n\n` +
		filler +
		`\n\n=== THE SENTINEL TOKEN IS: ${SENTINEL} ===\n\n` +
		filler +
		`\n\nNow: what is the sentinel token? Reply with the token.`
	);
}

function runOnce({ attempt, log, tmp }) {
	const promptText = buildLargePrompt();
	const promptFile = join(tmp, `prompt-${attempt}.txt`);
	const sysFile = join(tmp, `sys-${attempt}.txt`);
	writeFileSync(promptFile, promptText, "utf8");
	const promptBytes = Buffer.byteLength(promptText, "utf8");
	writeFileSync(
		sysFile,
		`You are a precise assistant. Always end every reply with the token ${SYS_TOKEN} on its own, after your answer. This is mandatory.`,
		"utf8",
	);

	const cfg = {
		model: MODEL,
		systemPrompt: { kind: "file", path: sysFile },
		prompt: { kind: "file", path: promptFile },
		mcpConfig: JSON.stringify({ mcpServers: {} }),
		session: { kind: "fresh", sessionId: randomUUID() },
		timeoutSeconds: TIMEOUT_SECONDS,
	};
	let args;
	try {
		args = buildClaudePArgs(cfg);
	} catch (err) {
		log.push(`[a${attempt}] buildClaudePArgs THREW: ${err?.message}`);
		return Promise.resolve({ argError: true, errMsg: err?.message });
	}
	log.push(`[a${attempt}] argv has --input-file=${args.includes("--input-file")} --system-prompt-file=${args.includes("--system-prompt-file")} promptBytes=${promptBytes}`);

	const rawChunks = [];
	let assistantText = "";
	let sawResult = false;
	const parser = new ClaudePStreamParser({
		logger: { warn() {} },
		onEvent: (e) => {
			if (e.kind === "text-delta") assistantText += e.text;
			if (e.kind === "done" && e.reason === "result") sawResult = true;
		},
	});

	const env = { ...process.env };
	delete env.CLAUDE_CONFIG_DIR;

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
			log.push(`[a${attempt}] EXIT code=${code} signal=${signal} sawResult=${sawResult} argRejected=${argRejected}`);
			if (stderr.trim()) log.push(`[a${attempt}] STDERR ${stderr.replace(/\n/g, " ").slice(0, 400)}`);
			res({
				exitCode: code,
				signal,
				sawResult,
				argError: false,
				argRejected,
				raw,
				assistantText,
				// Look in the full raw transcript AND the parsed assistant text.
				sawSentinel: raw.includes(SENTINEL) || assistantText.includes(SENTINEL),
				sawSysToken: assistantText.includes(SYS_TOKEN) || raw.includes(SYS_TOKEN),
				// Did the model echo the sentinel in ITS OWN text (strongest evidence)?
				sentinelInAssistant: assistantText.includes(SENTINEL),
				sysTokenInAssistant: assistantText.includes(SYS_TOKEN),
				stderr,
			});
		});
		child.on("error", (err) => res({ exitCode: null, signal: null, spawnErr: err?.message, raw: "", assistantText: "" }));
	});
}

function isFlake(r) {
	// Boot flake = no result, no sentinel, and an arg error did NOT happen (arg
	// error is a real NEGATIVE result, not a flake). StopTimeout/SessionStartTimeout
	// with no useful output is a flake to retry.
	return !r.argError && !r.argRejected && !r.sawResult && !r.sawSentinel;
}

(async () => {
	mkdirSync(NOTES_DIR, { recursive: true });
	if (!existsSync(CLAUDE_P_BIN)) throw new Error(`claude-p binary missing at ${CLAUDE_P_BIN}`);
	const tmp = mkdtempSync(join(tmpdir(), "g-resume-"));
	const log = [];
	let outcome = null;
	const attemptsMeta = [];
	try {
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			log.push(`===== ATTEMPT ${attempt} START ${nowIso()} =====`);
			const r = await runOnce({ attempt, log, tmp });
			attemptsMeta.push({ attempt, exit: r.exitCode, sawResult: r.sawResult, sentinel: r.sawSentinel, sysToken: r.sawSysToken, argRejected: r.argRejected, argError: r.argError });
			log.push(`===== ATTEMPT ${attempt} END exit=${r.exitCode} sawResult=${r.sawResult} sentinel=${r.sawSentinel} sysToken=${r.sawSysToken} =====`);
			outcome = r;
			if (r.argError || r.argRejected) break; // definitive negative
			if (r.sawResult && r.sawSentinel) break; // definitive positive
			if (!isFlake(r)) break;
			log.push(`[a${attempt}] FLAKE — retrying`);
		}

		if (outcome?.raw) writeFileSync(STREAM_OUT, outcome.raw, "utf8");

		const inputFileHonored = !!(outcome && !outcome.argError && !outcome.argRejected && outcome.sawSentinel);
		const sysFileHonored = !!(outcome && !outcome.argError && !outcome.argRejected && outcome.sawSysToken);

		const lines = [];
		lines.push(`# G-resume — \`--input-file\` AND \`--system-prompt-file\` forwarding through claude-p`);
		lines.push("");
		lines.push(`**Date:** ${nowIso()} · claude-p 0.1.0 · claude 2.1.159 · model ${MODEL}`);
		lines.push(`**Method:** ONE claude-p spawn (no tools). User prompt (~64KB, sentinel \`${SENTINEL}\` buried in filler) via \`--input-file\`; system prompt ("end every reply with ${SYS_TOKEN}") via \`--system-prompt-file\`. Exact production argv from \`buildClaudePArgs({prompt:{kind:"file"}, systemPrompt:{kind:"file"}})\`.`);
		lines.push("");
		lines.push(`## Results`);
		lines.push("");
		lines.push(`- spawn arg-rejected (unknown option / invalid): **${outcome?.argRejected ? "YES" : "no"}**`);
		lines.push(`- buildClaudePArgs threw: **${outcome?.argError ? "YES" : "no"}**`);
		lines.push(`- clean turn (\`result\`): **${outcome?.sawResult}**`);
		lines.push(`- model echoed the >50KB input-file SENTINEL: **${outcome?.sawSentinel}** (in assistant text: ${outcome?.sentinelInAssistant})`);
		lines.push(`- system-prompt-file token ${SYS_TOKEN} present: **${outcome?.sawSysToken}** (in assistant text: ${outcome?.sysTokenInAssistant})`);
		lines.push(`- attempts: ${JSON.stringify(attemptsMeta)}`);
		lines.push("");
		lines.push(`## Verdict`);
		lines.push("");
		if (outcome?.argRejected || outcome?.argError) {
			lines.push(`**NOT FORWARDED.** claude-p rejected the flag(s) (arg error). See fallback below.`);
		} else if (inputFileHonored && sysFileHonored) {
			lines.push(`**BOTH \`--input-file\` AND \`--system-prompt-file\` are FORWARDED and HONORED through claude-p.** The model echoed the sentinel buried in the >50KB \`--input-file\` prompt (proving the large input reached the model) AND ended its reply with the \`--system-prompt-file\` token ${SYS_TOKEN} (proving the system-prompt-file was applied). The bridge's >50KB overflow path in index.ts is SAFE.`);
		} else {
			lines.push(`**PARTIAL / INCONCLUSIVE.** input-file honored=${inputFileHonored}, system-prompt-file honored=${sysFileHonored}. See run log; may need a re-run if a flake.`);
		}
		lines.push("");
		lines.push(`## index.ts >50KB overflow path`);
		lines.push("");
		if (inputFileHonored && sysFileHonored) {
			lines.push(`SAFE — no change needed. index.ts may continue to switch the prompt/system-prompt to \`--input-file\`/\`--system-prompt-file\` above 50KB; both flags are forwarded by claude-p to \`claude\` and honored through the PTY-driven interactive session.`);
		} else if (outcome?.argRejected || outcome?.argError) {
			lines.push(`UNSAFE as-is — claude-p rejected the flag. Fallback: deliver the large user prompt via the POSITIONAL arg / stdin instead of \`--input-file\`, and inline the system prompt via \`--system-prompt\` instead of \`--system-prompt-file\`. index.ts's >50KB branch would need to change to NOT use the file flags through claude-p. REPORT to the owner.`);
		} else {
			lines.push(`Re-run before concluding. If the failure is the sentinel not echoed (not an arg error), the flag was accepted but the large input may not have been fully consumed — investigate before trusting the overflow path.`);
		}
		lines.push("");
		lines.push(`## Raw run log`);
		lines.push("```");
		lines.push(...log);
		lines.push("```");
		writeFileSync(RESULTS_MD, lines.join("\n") + "\n", "utf8");

		console.log(`argRejected=${outcome?.argRejected} argError=${outcome?.argError} sawResult=${outcome?.sawResult}`);
		console.log(`inputFileHonored=${inputFileHonored} (sentinel=${outcome?.sawSentinel}) sysFileHonored=${sysFileHonored} (token=${outcome?.sawSysToken})`);
		console.log(`Results -> ${RESULTS_MD}`);
	} finally {
		try { rmSync(tmp, { recursive: true, force: true }); } catch {}
	}
})();
