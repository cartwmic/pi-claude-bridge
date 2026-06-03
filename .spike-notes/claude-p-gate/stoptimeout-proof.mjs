#!/usr/bin/env node
// stoptimeout-proof.mjs — IRREFUTABLE root-cause proof for the claude-p StopTimeout "hang".
//
// DIAGNOSIS ONLY. No src edits. Does NOT override CLAUDE_CONFIG_DIR/HOME.
// Reads (read-only) claude's OWN session transcript JSONL — the independent
// ground truth of what `claude` actually received — for each FAILED spawn.
//
// Hypothesis under test (now grounded in claude-p src/driver.zig):
//   waitForInkQuiescent() caps its wait at ink_max_wait_ms=2000ms and then
//   logs "Ink readiness wait hit max (2000ms) — typing anyway" and types the
//   prompt REGARDLESS of whether Ink is ready. Under concurrent-boot CPU
//   contention, Ink isn't ready at 2s → the prompt is typed into an unready
//   TUI → keystrokes are dropped → `claude` never receives a user message →
//   never produces an assistant turn → the Stop hook never fires →
//   RunError.StopTimeout (main.zig → "claude-p: StopTimeout", exit 2).
//
// DECISIVE TEST per failed spawn:
//   (A) did --debug log "...typing anyway" (quiescence cap hit)?  vs "Ink quiescent"
//   (B) does claude's transcript JSONL contain a {"type":"user"} entry? (prompt landed?)
//   (C) does it contain a complete {"type":"assistant"} entry?       (model ran?)
//
//   cap-hit + NO user entry            => PROVEN: dropped prompt (quiescence-cap-under-load)
//   user entry + complete assistant +
//     claude-p emitted NO result       => PROVEN: lost Stop signal (FIFO), turn DID finish
//   user entry + NO/partial assistant  => turn genuinely mid-flight at timeout (slow, not wedged)
//   NO transcript / no SessionStart    => boot/SessionStart failure
//
// Usage: node stoptimeout-proof.mjs [--concurrency 5] [--waves 6] [--timeout 60] [--model claude-haiku-4-5]

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const CLAUDE_P_BIN = resolve(REPO, "node_modules", ".bin", "claude-p");

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const MODEL = arg("model", "claude-haiku-4-5");
const CONCURRENCY = parseInt(arg("concurrency", "5"), 10);
const WAVES = parseInt(arg("waves", "6"), 10);
const TIMEOUT_S = parseInt(arg("timeout", "60"), 10); // SHORT so a wedge exits fast with its real error
const TARGET_FAILS = parseInt(arg("targetFails", "4"), 10); // stop early once we have enough proof
const LOAD = parseInt(arg("load", "0"), 10); // # of CPU-saturation busy workers to run DURING the waves
const PROMPT = "Reply with exactly the word READY and nothing else.";

// Spawn CPU-saturation workers to recreate the concurrent-boot contention window
// (the documented trigger). Tracked + killed on exit; we kill ONLY our own PIDs.
const loadWorkers = [];
function startLoad() {
	for (let i = 0; i < LOAD; i++) {
		const w = spawn(process.execPath, ["-e", "const e=Date.now()+10**9;let x=0;while(Date.now()<e){x+=Math.sqrt(Math.random()*Math.random());}"],
			{ detached: true, stdio: "ignore" });
		w.unref();
		loadWorkers.push(w.pid);
	}
	if (LOAD) console.log(`*** spawned ${LOAD} CPU-saturation workers (pids ${loadWorkers.join(",")}) ***`);
}
function stopLoad() {
	for (const pid of loadWorkers) { try { process.kill(pid, "SIGKILL"); } catch {} }
}

const DISALLOWED = [
	"Read","Write","Edit","Bash","Glob","Grep","WebFetch","WebSearch","NotebookEdit",
	"Agent","Task","Skill","ToolSearch","AskUserQuestion","EnterPlanMode","ExitPlanMode",
	"EnterWorktree","ExitWorktree","TodoWrite","TaskCreate","TaskGet","TaskList","TaskUpdate",
	"TaskOutput","TaskStop","BashOutput","Monitor","Workflow","ScheduleWakeup","CronCreate",
	"CronDelete","CronList","PushNotification","RemoteTrigger",
].join(" ");
const MCP_CONFIG = JSON.stringify({ mcpServers: { "pi-spike-tools": { command: "node", args: [resolve(HERE, "mcp-server.mjs")] } } });
const SYSTEM_PROMPT = "You are a helpful assistant. Before using any mcp__ tool, call WaitForMcpServers once.";

const TS = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = resolve(HERE, `stoptimeout-proof-${MODEL}-${TS}`);
mkdirSync(OUT, { recursive: true });

function buildArgs(sessionId) {
	return [
		"--model", MODEL, "--system-prompt", SYSTEM_PROMPT, "--mcp-config", MCP_CONFIG,
		"--disallowedTools", DISALLOWED, "--strict-mcp-config", "--setting-sources", "",
		"--permission-mode", "bypassPermissions", "--session-id", sessionId,
		"--output-format", "stream-json", "--verbose", "--timeout", String(TIMEOUT_S),
		"--debug", PROMPT,
	];
}

// Parse claude's OWN transcript JSONL — independent ground truth.
function inspectTranscript(path) {
	if (!path || !existsSync(path)) return { exists: false };
	let users = 0, assistants = 0, assistantComplete = 0, lines = 0, lastType = null, types = {};
	let raw = "";
	try { raw = readFileSync(path, "utf8"); } catch { return { exists: true, readErr: true }; }
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		lines++;
		let o; try { o = JSON.parse(line); } catch { continue; }
		const t = o.type;
		lastType = t;
		types[t] = (types[t] || 0) + 1;
		if (t === "user") users++;
		if (t === "assistant") {
			assistants++;
			// a "complete" assistant turn carries a stop_reason in message
			const sr = o.message && o.message.stop_reason;
			if (sr) assistantComplete++;
		}
	}
	return { exists: true, lines, users, assistants, assistantComplete, lastType, types };
}

function runSpawn(label) {
	return new Promise((res) => {
		const sessionId = randomUUID();
		const start = Date.now();
		const child = spawn(process.execPath, [CLAUDE_P_BIN, ...buildArgs(sessionId)], {
			detached: true, stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "", stderr = "";
		let sawResultLine = false; // claude-p emitted a stream-json `result` (Stop fired + drained)
		let buf = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (c) => {
			stdout += c; buf += c; let nl;
			while ((nl = buf.indexOf("\n")) >= 0) {
				const ln = buf.slice(0, nl); buf = buf.slice(nl + 1);
				if (!ln.trim()) continue;
				try { if (JSON.parse(ln).type === "result") sawResultLine = true; } catch {}
			}
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (c) => { stderr += c; });

		const backstop = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, (TIMEOUT_S + 25) * 1000);
		backstop.unref();

		child.on("close", (code, signal) => {
			clearTimeout(backstop);
			const wallMs = Date.now() - start;
			// --debug markers (verbatim strings from src/driver.zig)
			const sessionStartFired = /SessionStart hook fired/.test(stderr);
			const typingAnyway = /Ink readiness wait hit max .* typing anyway/.test(stderr);
			const inkQuiescent = /Ink quiescent \(output silent/.test(stderr);
			const promptTyped = /typing prompt \(/.test(stderr);
			const stopFired = /Stop hook fired/.test(stderr);
			const resultEmitted = /result envelope emitted/.test(stderr);
			const stopTimeout = /StopTimeout/.test(stderr);
			const sessionStartTimeout = /SessionStartTimeout/.test(stderr);
			// transcript_path from the session_start payload (claude's own path)
			let txPath = null;
			const m = stderr.match(/"transcript_path":"([^"]+\.jsonl)"/);
			if (m) txPath = m[1];
			const tx = inspectTranscript(txPath);

			const verdict = code === 0 && sawResultLine ? "PASS" : `FAIL(exit=${code}${signal ? "/" + signal : ""})`;

			// Conclusion logic (the decisive interpretation)
			let conclusion = "PASS";
			if (verdict !== "PASS") {
				if (!sessionStartFired) conclusion = "BOOT: SessionStart never fired";
				else if (tx.exists && tx.users === 0) conclusion = typingAnyway
					? "DROPPED PROMPT (quiescence-cap typed-anyway; transcript has NO user msg)"
					: "DROPPED PROMPT (transcript has NO user msg)";
				else if (tx.exists && tx.users > 0 && tx.assistantComplete > 0 && !sawResultLine)
					conclusion = "LOST STOP SIGNAL (turn finished in transcript, but no result emitted)";
				else if (tx.exists && tx.users > 0 && tx.assistantComplete === 0)
					conclusion = "MID-FLIGHT at timeout (user landed, assistant not complete)";
				else if (!tx.exists) conclusion = "NO TRANSCRIPT (session file absent)";
				else conclusion = "AMBIGUOUS";
			}

			const rec = {
				label, sessionId, verdict, exit: code, signal, wallMs,
				sessionStartFired, typingAnyway, inkQuiescent, promptTyped, stopFired, resultEmitted,
				stopTimeout, sessionStartTimeout, sawResultLine,
				txPath, tx, conclusion,
			};
			writeFileSync(resolve(OUT, `${label}.log`),
				`${JSON.stringify(rec, null, 2)}\n\n===== STDERR (--debug) =====\n${stderr}\n\n===== STDOUT =====\n${stdout}\n`);
			res(rec);
		});
		child.on("error", (e) => { clearTimeout(backstop); res({ label, sessionId, verdict: "SPAWN_ERR", err: e.message }); });
	});
}

(async () => {
	console.log(`\n=== claude-p StopTimeout PROOF ===`);
	console.log(`model=${MODEL} concurrency=${CONCURRENCY} waves=${WAVES} timeout=${TIMEOUT_S}s targetFails=${TARGET_FAILS}`);
	console.log(`bin=${CLAUDE_P_BIN}\nout=${OUT}\n`);
	startLoad();
	const all = [];
	for (let w = 1; w <= WAVES; w++) {
		const wave = [];
		for (let c = 0; c < CONCURRENCY; c++) wave.push(runSpawn(`w${w}-s${c}`));
		const recs = await Promise.all(wave);
		all.push(...recs);
		for (const r of recs) {
			const mark = r.verdict === "PASS" ? "ok  " : "FAIL";
			console.log(`[${mark}] ${r.label.padEnd(7)} ${String(r.verdict).padEnd(16)} wall=${((r.wallMs||0)/1000).toFixed(1)}s ` +
				`SSfired=${r.sessionStartFired?"Y":"n"} typedAnyway=${r.typingAnyway?"Y":"n"} quiescent=${r.inkQuiescent?"Y":"n"} ` +
				`tx[user=${r.tx?.users ?? "?"},asstDone=${r.tx?.assistantComplete ?? "?"}] result=${r.sawResultLine?"Y":"n"}`);
			if (r.verdict !== "PASS") console.log(`        => ${r.conclusion}`);
		}
		const fails = all.filter((r) => r.verdict !== "PASS").length;
		if (fails >= TARGET_FAILS) { console.log(`\n(reached ${fails} failures — enough proof, stopping early)`); break; }
	}

	const fails = all.filter((r) => r.verdict !== "PASS");
	const byConclusion = {};
	for (const r of fails) byConclusion[r.conclusion] = (byConclusion[r.conclusion] || 0) + 1;
	console.log(`\n=== SUMMARY ===`);
	console.log(`total spawns: ${all.length}  failures: ${fails.length}`);
	console.log(`failure root-cause breakdown:`);
	for (const [k, v] of Object.entries(byConclusion)) console.log(`  ${v} × ${k}`);
	writeFileSync(resolve(OUT, "summary.json"), JSON.stringify({ all, byConclusion }, null, 2));
	console.log(`\nper-spawn logs + transcripts: ${OUT}`);
	stopLoad();
})();
