#!/usr/bin/env node
// Spike T0.2 (Design D6-limit): re-run the dangling-`tool_use` resume through the
// FULL claude-p + suppressResumeReplay path (not `claude` direct, which D6 already
// proved). Can INVERT spec R7: if claude-p does NOT cleanly resume a transcript
// ending in an unclosed mcp__custom-tools__* tool_use, a dangling tool call must
// become a cold-start trigger instead of a warm-resume case.
//
// Phases:
//   0. (bonus, T0.1 completeness) claude-p --resume <missing> → expect a clean error.
//   1. Fresh claude-p spawn; model calls a tool; KILL claude-p the moment the tool
//      is parked (onPark) — aborting mid-tool, leaving the transcript ending in a
//      dangling tool_use (assistant tool_use, no tool_result). Verify on disk.
//   2. Resume that session via claude-p (--resume) + a NEW prompt, parsed with
//      suppressResumeReplay:true + livePromptText (the bridge's warm path). Observe:
//      exit code, terminal `result`, whether the new prompt was answered, the
//      staleSuspected/livePromptAfterBoundary diag, and any dangling-tool error.
//
// Run: node --import tsx .spike-notes/claude-p-gate/d6-dangling-claudep-spike.mjs

import { existsSync, rmSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createRouter } from "../../src/mcp/router.js";
import { buildClaudePArgs } from "../../src/driver/claudeP.js";
import { ClaudePStreamParser } from "../../src/driver/stream.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..", "..");
const SHIM = join(REPO, "dist", "src", "mcp", "shim.js");
const CLAUDE_P_BIN = join(REPO, "node_modules", ".bin", "claude-p");
const MODEL = process.env.MODEL ?? "claude-haiku-4-5";

const WORK = "/tmp/d6-dangling-spike-cwd";
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
const ENC = WORK.replace(/[/.]/g, "-"); // claude encodes / and . as -
const PROJDIR = join(homedir(), ".claude", "projects", ENC);

const TS = process.env.TS ?? "manual";
const OUT = join(__dirname, `d6-dangling-claudep-${MODEL}-${TS}`);
mkdirSync(OUT, { recursive: true });
const log = [];
const say = (m) => { console.log(m); log.push(m); };
const flush = () => writeFileSync(join(OUT, "run.log"), log.join("\n") + "\n");

const SYSTEM = "You are a tool-calling test agent. Follow instructions precisely.";
const TOOL = {
	name: "mcp__custom-tools__work",
	description: "A work tool. Call it once with {} to do the work.",
	inputSchema: { type: "object", properties: {}, required: [] },
};
function mkMcpConfig(socketPath, readyFile) {
	const toolsB64 = Buffer.from(JSON.stringify([TOOL]), "utf-8").toString("base64");
	return JSON.stringify({
		mcpServers: {
			"custom-tools": {
				command: process.execPath,
				args: [SHIM, "--socket", socketPath, "--mode", "main", "--tools", toolsB64, "--ready-file", readyFile],
			},
		},
	});
}
const killGroup = (child) => { try { process.kill(-child.pid, "SIGKILL"); } catch {} try { child.kill("SIGKILL"); } catch {} };

// ───────────────────────── PHASE 0: claude-p --resume <missing> ─────────────────────────
async function phase0() {
	say("\n=== PHASE 0 — claude-p --resume <missing-uuid> (T0.1 TUI-path confirmation) ===");
	const missing = randomUUID();
	const router = createRouter({ onPark: () => {} });
	router.declareTools([TOOL]);
	await router.start();
	const readyFile = `${router.socketPath}.ready`;
	rmSync(readyFile, { force: true });
	const cfg = {
		model: MODEL,
		systemPrompt: { kind: "text", text: SYSTEM },
		prompt: { kind: "positional", text: "Reply with exactly SPIKE_FRESH_OK and nothing else." },
		mcpConfig: mkMcpConfig(router.socketPath, readyFile),
		session: { kind: "resume", sessionId: missing },
		timeoutSeconds: 60,
		mcpReadyFile: readyFile,
	};
	const args = buildClaudePArgs(cfg);
	const child = spawn(CLAUDE_P_BIN, [...args, "--debug"], { cwd: WORK, detached: true, stdio: ["ignore", "pipe", "pipe"] });
	let out = "", err = "";
	child.stdout.setEncoding("utf8"); child.stdout.on("data", (c) => (out += c));
	child.stderr.setEncoding("utf8"); child.stderr.on("data", (c) => (err += c));
	const exit = await new Promise((res) => { child.on("close", (code, signal) => res({ code, signal })); child.on("error", (e) => res({ code: null, signal: null, err: String(e) })); });
	await router.stop().catch(() => {});
	rmSync(readyFile, { force: true });
	const errored = exit.code !== 0 || /no conversation found/i.test(err) || /no conversation found/i.test(out);
	say(`missing=${missing}`);
	say(`exit=${JSON.stringify(exit)}`);
	say(`stderr(tail)=${JSON.stringify(err.slice(-400))}`);
	say(`stdout(tail)=${JSON.stringify(out.slice(-300))}`);
	say(`PHASE 0 → claude-p --resume <missing> ${errored ? "ERRORED (clean, matches claude-direct T0.1)" : "DID NOT ERROR (!! investigate)"}`);
	writeFileSync(join(OUT, "phase0-missing-resume.log"), `exit=${JSON.stringify(exit)}\n\n--- stdout ---\n${out}\n\n--- stderr ---\n${err}\n`);
	return errored;
}

// ───────────────────────── PHASE 1: create a dangling tool_use ─────────────────────────
async function phase1(session) {
	say("\n=== PHASE 1 — fresh spawn, call tool, KILL mid-tool (create dangling tool_use) ===");
	let parked = false, killedAt = null;
	let child;
	const router = createRouter({
		onPark: (info) => {
			parked = true; killedAt = Date.now();
			say(`[phase1] TOOL PARKED: name=${info.name} piId=${info.piId} → KILLING claude-p mid-tool (no result delivered)`);
			killGroup(child);
		},
	});
	router.declareTools([TOOL]);
	await router.start();
	const readyFile = `${router.socketPath}.ready`;
	rmSync(readyFile, { force: true });
	const cfg = {
		model: MODEL,
		systemPrompt: { kind: "text", text: SYSTEM },
		prompt: { kind: "positional", text: "You have one tool: mcp__custom-tools__work. Call it once with no arguments. Do not reply with text first." },
		mcpConfig: mkMcpConfig(router.socketPath, readyFile),
		session: { kind: "fresh", sessionId: session },
		timeoutSeconds: 60,
		mcpReadyFile: readyFile,
	};
	const args = buildClaudePArgs(cfg);
	child = spawn(CLAUDE_P_BIN, [...args, "--debug"], { cwd: WORK, detached: true, stdio: ["ignore", "pipe", "pipe"] });
	let out = "", err = "";
	child.stdout.setEncoding("utf8"); child.stdout.on("data", (c) => (out += c));
	child.stderr.setEncoding("utf8"); child.stderr.on("data", (c) => (err += c));
	// Safety: if no park within 55s, give up on this run.
	const guard = setTimeout(() => { if (!parked) { say("[phase1] no tool call within 55s — killing"); killGroup(child); } }, 55_000);
	const exit = await new Promise((res) => { child.on("close", (code, signal) => res({ code, signal })); child.on("error", (e) => res({ code: null, signal: null, err: String(e) })); });
	clearTimeout(guard);
	await router.stop().catch(() => {});
	rmSync(readyFile, { force: true });
	say(`[phase1] parked=${parked} exit=${JSON.stringify(exit)}`);

	// Inspect the transcript on disk.
	const file = join(PROJDIR, `${session}.jsonl`);
	let dangling = false, lastKind = "(no file)", recCount = 0;
	if (existsSync(file)) {
		const lines = readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
		recCount = lines.length;
		const recs = lines.map((l) => { try { return JSON.parse(l); } catch { return {}; } });
		// Find the last assistant/user record and whether a tool_use is unmatched by a tool_result.
		let lastToolUseId = null, hasResultForLast = false, lastType = null;
		for (const r of recs) {
			const msg = r.message ?? r;
			const role = r.type ?? msg.role;
			lastType = role;
			const content = Array.isArray(msg?.content) ? msg.content : [];
			for (const c of content) {
				if (c.type === "tool_use") { lastToolUseId = c.id; hasResultForLast = false; }
				if (c.type === "tool_result" && c.tool_use_id === lastToolUseId) hasResultForLast = true;
			}
		}
		dangling = !!lastToolUseId && !hasResultForLast;
		lastKind = `lastType=${lastType} lastToolUseId=${lastToolUseId ?? "none"} hasResultForLast=${hasResultForLast}`;
		writeFileSync(join(OUT, "phase1-transcript.jsonl"), readFileSync(file, "utf8"));
	}
	say(`[phase1] transcript=${file}`);
	say(`[phase1] records=${recCount} ${lastKind}`);
	say(`PHASE 1 → dangling tool_use present: ${dangling ? "YES ✓" : "NO (cannot run T0.2 — see transcript)"}`);
	writeFileSync(join(OUT, "phase1.log"), `parked=${parked}\nexit=${JSON.stringify(exit)}\ndangling=${dangling}\n${lastKind}\n\n--- stderr(tail) ---\n${err.slice(-1500)}\n`);
	return dangling;
}

// ───────────────────────── PHASE 2: resume through claude-p + suppression ─────────────────────────
async function phase2(session) {
	say("\n=== PHASE 2 — resume the dangling session via claude-p + suppressResumeReplay ===");
	const NEWPROMPT = "Do NOT call any tool. Reply with exactly the token SPIKE_RESUME_OK and nothing else.";
	const router = createRouter({ onPark: (info) => { say(`[phase2] (unexpected) tool call on resume → delivering`); router.deliver(info.piId, { content: [{ type: "text", text: "DONE" }] }); } });
	router.declareTools([TOOL]);
	await router.start();
	const readyFile = `${router.socketPath}.ready`;
	rmSync(readyFile, { force: true });
	const cfg = {
		model: MODEL,
		systemPrompt: { kind: "text", text: SYSTEM },
		prompt: { kind: "positional", text: NEWPROMPT },
		mcpConfig: mkMcpConfig(router.socketPath, readyFile),
		session: { kind: "resume", sessionId: session },
		timeoutSeconds: 90,
		mcpReadyFile: readyFile,
	};
	const args = buildClaudePArgs(cfg);
	let sawResult = false, answerText = "", diag = null;
	const parser = new ClaudePStreamParser({
		logger: { warn() {} },
		suppressResumeReplay: true,
		livePromptText: NEWPROMPT,
		onEvent: (e) => {
			if (e.kind === "done" && e.reason === "result") sawResult = true;
			if (e.kind === "text" && typeof e.text === "string") answerText += e.text;
			if (e.kind === "assistant_text" && typeof e.text === "string") answerText += e.text;
		},
		onResumeDiag: (d) => { diag = d; },
	});
	const child = spawn(CLAUDE_P_BIN, [...args, "--debug"], { cwd: WORK, detached: true, stdio: ["ignore", "pipe", "pipe"] });
	let err = "", rawOut = "";
	child.stdout.setEncoding("utf8"); child.stdout.on("data", (c) => { rawOut += c; parser.write(c); });
	child.stderr.setEncoding("utf8"); child.stderr.on("data", (c) => (err += c));
	const exit = await new Promise((res) => { child.on("close", (code, signal) => res({ code, signal })); child.on("error", (e) => res({ code: null, signal: null, err: String(e) })); });
	parser.endOfStream({ aborted: false, exitInfo: { code: exit.code, signal: exit.signal } });
	await router.stop().catch(() => {});
	rmSync(readyFile, { force: true });

	const answered = /SPIKE_RESUME_OK/.test(answerText) || /SPIKE_RESUME_OK/.test(rawOut);
	const apiError = /tool_use|tool_result|unclosed|400|invalid_request|no conversation found/i.test(err);
	say(`[phase2] exit=${JSON.stringify(exit)}`);
	say(`[phase2] sawResult=${sawResult} answered(SPIKE_RESUME_OK)=${answered}`);
	say(`[phase2] resumeDiag=${JSON.stringify(diag)}`);
	say(`[phase2] answerText(tail)=${JSON.stringify(answerText.slice(-200))}`);
	say(`[phase2] stderr(tail)=${JSON.stringify(err.slice(-600))}`);
	writeFileSync(join(OUT, "phase2.log"), `exit=${JSON.stringify(exit)}\nsawResult=${sawResult}\nanswered=${answered}\ndiag=${JSON.stringify(diag)}\napiErrorPattern=${apiError}\n\n--- answerText ---\n${answerText}\n\n--- stderr ---\n${err}\n`);
	writeFileSync(join(OUT, "phase2-rawout.jsonl"), rawOut);

	const pass = exit.code === 0 && sawResult && answered;
	say(`\nPHASE 2 → claude-p resume of a dangling tool_use: ${pass ? "CLEAN ✓ (exit 0, result, live prompt answered)" : "FAILED ✗ (R7 may need to INVERT)"}`);
	return { pass, exit, sawResult, answered, diag };
}

async function main() {
	say(`T0.2 dangling-tool_use resume through claude-p — model=${MODEL}`);
	say(`claude-p=${CLAUDE_P_BIN}`);
	say(`work cwd=${WORK} → projectdir=${PROJDIR}`);
	const session = randomUUID();
	say(`session=${session}`);
	try {
		const p0 = await phase0();
		const dangling = await phase1(session);
		if (!dangling) { say("\nABORT: phase 1 did not produce a dangling tool_use; cannot run phase 2."); flush(); process.exit(2); }
		const p2 = await phase2(session);
		say("\n================ T0.2 VERDICT ================");
		say(`phase0 (claude-p --resume missing errors): ${p0 ? "OK" : "UNEXPECTED"}`);
		say(`phase1 (dangling tool_use created): YES`);
		say(`phase2 (clean resume through claude-p+suppression): ${p2.pass ? "PASS — R7 HOLDS" : "FAIL — R7 INVERTS (dangling → cold trigger)"}`);
		flush();
		process.exit(p2.pass ? 0 : 1);
	} catch (e) {
		say(`\nHARNESS ERROR: ${e?.stack ?? e}`);
		flush();
		process.exit(3);
	}
}
main();
