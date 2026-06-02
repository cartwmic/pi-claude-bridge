#!/usr/bin/env node
// hang-repro.mjs — root-cause repro for the intermittent claude-p turn HANG.
//
// DIAGNOSIS ONLY. Does NOT touch src, does NOT commit, does NOT override
// CLAUDE_CONFIG_DIR/HOME. Concurrency 1 (one claude-p at a time).
//
// Drives REAL claude-p directly with the bridge's EXACT production flags
// (mirrors src/driver/claudeP.ts buildClaudePArgs + index.ts), but with a
// SHORT --timeout (default 45s) so a stuck turn EXITS fast with its real error
// (124 timeout / 2 internal) instead of hanging the full 600s. --debug +
// --output-format stream-json --verbose capture the hook/FIFO lifecycle.
//
// Per failed turn it captures: exit code, signal, wall time, whether ANY
// stream-json line was seen (SessionStart fired = prompt typed = user/assistant
// lines), whether `result` was emitted (Stop fired), stderr/--debug text
// (SessionStartTimeout / StopTimeout / other), the FIFO/relay dir state, and a
// process census (claude/zmux leak check) before+after each turn.
//
// Usage:
//   node hang-repro.mjs --model claude-haiku-4-5 --turns 30 --timeout 45
//   node hang-repro.mjs --model claude-sonnet-4-6 --turns 20 --timeout 45

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, statSync, appendFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const CLAUDE_P_BIN = resolve(REPO, "node_modules", ".bin", "claude-p");

function arg(name, def) {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const MODEL = arg("model", "claude-haiku-4-5");
const TURNS = parseInt(arg("turns", "30"), 10);
const TIMEOUT_S = parseInt(arg("timeout", "45"), 10);
const CONCURRENCY = parseInt(arg("concurrency", "1"), 10);
const PROMPT = "Reply with exactly the word READY and nothing else.";

// The bridge's exact disallow set (src/driver/claudeP.ts CLAUDE_P_DISALLOWED_TOOLS).
const DISALLOWED = [
	"Read","Write","Edit","Bash","Glob","Grep","WebFetch","WebSearch","NotebookEdit",
	"Agent","Task","Skill","ToolSearch","AskUserQuestion","EnterPlanMode","ExitPlanMode",
	"EnterWorktree","ExitWorktree","TodoWrite","TaskCreate","TaskGet","TaskList","TaskUpdate",
	"TaskOutput","TaskStop","BashOutput","Monitor","Workflow","ScheduleWakeup","CronCreate",
	"CronDelete","CronList","PushNotification","RemoteTrigger",
].join(" ");

// Mirror index.ts: a real (small) mcp-config pointing at the spike shim, so the
// MCP attach + WaitForMcpServers preamble path is exercised like production.
const MCP_CONFIG = JSON.stringify({
	mcpServers: {
		"pi-spike-tools": { command: "node", args: [resolve(HERE, "mcp-server.mjs")] },
	},
});
// Production prepends a WaitForMcpServers preamble to the system prompt.
const SYSTEM_PROMPT =
	"You are a helpful assistant. Before using any mcp__ tool, call WaitForMcpServers once.";

const TS = new Date().toISOString().replace(/[:.]/g, "-");
const DEBUG_DIR = resolve(HERE, `hang-repro-${MODEL}-${TS}`);
execSync(`mkdir -p ${DEBUG_DIR}`);
const SUMMARY = resolve(DEBUG_DIR, "summary.ndjson");

function buildArgs(sessionId) {
	return [
		"--model", MODEL,
		"--system-prompt", SYSTEM_PROMPT,
		"--mcp-config", MCP_CONFIG,
		"--disallowedTools", DISALLOWED,
		"--strict-mcp-config",
		"--setting-sources", "",
		"--permission-mode", "bypassPermissions",
		"--session-id", sessionId,
		"--output-format", "stream-json",
		"--verbose",
		"--timeout", String(TIMEOUT_S),
		"--debug",
		PROMPT,
	];
}

// Census of live claude/claude-p/zmux processes (leak detector).
function procCensus() {
	try {
		const out = execSync(
			`ps -eo pid,ppid,etime,command | grep -E 'claude-p|[c]laude |zmux' | grep -v hang-repro | grep -v grep`,
			{ encoding: "utf8" },
		).trim();
		const lines = out ? out.split("\n") : [];
		return { count: lines.length, lines };
	} catch {
		return { count: 0, lines: [] };
	}
}

// Snapshot claude-p relay/FIFO dirs in TMPDIR ($TMPDIR/claude-p-<pid>-<rand>/).
function fifoDirs() {
	const tmp = process.env.TMPDIR || "/tmp";
	try {
		return readdirSync(tmp)
			.filter((n) => n.startsWith("claude-p-"))
			.map((n) => {
				const p = resolve(tmp, n);
				let contents = [];
				try { contents = readdirSync(p); } catch {}
				return { dir: n, contents };
			});
	} catch {
		return [];
	}
}

function runTurn(turnIdx) {
	return new Promise((resolveTurn) => {
		const sessionId = randomUUID();
		const args = buildArgs(sessionId);
		const turnLog = resolve(DEBUG_DIR, `turn-${String(turnIdx).padStart(3, "0")}.log`);
		const start = Date.now();

		const censusBefore = procCensus();

		const child = spawn(process.execPath, [CLAUDE_P_BIN, ...args], {
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let firstStreamLineAtMs = null; // SessionStart proxy: first stream-json line
		let sawUserLine = false; // prompt actually typed
		let sawAssistant = false; // generation happened
		let sawResult = false; // Stop fired + result drained
		let lineBuf = "";

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
			lineBuf += chunk;
			let nl;
			while ((nl = lineBuf.indexOf("\n")) >= 0) {
				const line = lineBuf.slice(0, nl);
				lineBuf = lineBuf.slice(nl + 1);
				if (!line.trim()) continue;
				if (firstStreamLineAtMs === null) firstStreamLineAtMs = Date.now() - start;
				try {
					const obj = JSON.parse(line);
					const t = obj.type;
					if (t === "user") sawUserLine = true;
					if (t === "assistant") sawAssistant = true;
					if (t === "result") sawResult = true;
				} catch {
					// non-JSON line (debug noise on stdout, unlikely); ignore for classification.
				}
			}
		});

		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => { stderr += chunk; });

		const finish = (code, signal) => {
			const wallMs = Date.now() - start;
			const censusAfter = procCensus();
			const fifos = fifoDirs();

			// Classify the failure mode the way the bridge's parser would.
			const errLower = (stderr + stdout).toLowerCase();
			const sessionStartTimeout = /sessionstarttimeout|session start.*timed out|timed out.*session/.test(errLower);
			const stopTimeout = /stoptimeout|stop.*timed out|timed out.*stop/.test(errLower);

			// claude-p --debug lifecycle markers (observed signatures, claude-p 0.1.0).
			const dbgSessionStartFired = /SessionStart hook fired/.test(stderr);
			const dbgTranscriptOpened = /transcript opened for tailing/.test(stderr);
			const dbgPromptTyped = /typing prompt|prompt \+ Enter sent/.test(stderr);
			const dbgStopFired = /Stop hook fired/.test(stderr);
			const dbgResultEmitted = /result envelope emitted/.test(stderr);
			// The last debug line tells us where it got stuck.
			const dbgLines = stderr.split("\n").filter((l) => /\[claude-p \+/.test(l));
			const lastDbg = dbgLines.length ? dbgLines[dbgLines.length - 1].trim() : "(none)";

			let verdict;
			if (code === 0 && sawResult) verdict = "PASS";
			else if (code === 124) verdict = "TIMEOUT_124";
			else if (code === 2) verdict = "INTERNAL_2";
			else verdict = `OTHER_exit=${code}_sig=${signal}`;

			// Which hook missed (for failures). Prefer the --debug lifecycle markers
			// (authoritative); fall back to stream-line heuristics.
			let missedHook = "n/a";
			if (verdict !== "PASS") {
				if (!dbgSessionStartFired) missedHook = "SessionStart(boot)";
				else if (dbgSessionStartFired && !dbgStopFired) missedHook = "Stop";
				else if (dbgStopFired && !dbgResultEmitted) missedHook = "result-drain";
				else if (firstStreamLineAtMs === null && !sawUserLine && !sawAssistant) missedHook = "SessionStart";
				else if ((sawUserLine || sawAssistant) && !sawResult) missedHook = "Stop";
				else missedHook = "ambiguous";
			}

			writeFileSync(
				turnLog,
				`=== turn ${turnIdx} model=${MODEL} timeout=${TIMEOUT_S}s session=${sessionId} ===\n` +
				`verdict=${verdict} exit=${code} signal=${signal} wallMs=${wallMs}\n` +
				`firstStreamLineAtMs=${firstStreamLineAtMs} sawUser=${sawUserLine} sawAssistant=${sawAssistant} sawResult=${sawResult}\n` +
				`missedHook=${missedHook} sessionStartTimeout=${sessionStartTimeout} stopTimeout=${stopTimeout}\n` +
				`censusBefore=${censusBefore.count} censusAfter=${censusAfter.count}\n` +
				`fifoDirsAfter=${JSON.stringify(fifos)}\n` +
				`\n----- STDERR (--debug) -----\n${stderr}\n` +
				`\n----- STDOUT (stream-json) -----\n${stdout}\n`,
			);

			const rec = {
				turn: turnIdx, model: MODEL, verdict, exit: code, signal, wallMs,
				firstStreamLineAtMs, sawUser: sawUserLine, sawAssistant, sawResult,
				missedHook, sessionStartTimeout, stopTimeout,
				dbgSessionStartFired, dbgTranscriptOpened, dbgPromptTyped, dbgStopFired, dbgResultEmitted,
				lastDbg,
				censusBefore: censusBefore.count, censusAfter: censusAfter.count,
			};
			appendFileSync(SUMMARY, JSON.stringify(rec) + "\n");

			const mark = verdict === "PASS" ? "ok  " : "FAIL";
			console.log(
				`[${mark}] turn ${String(turnIdx).padStart(2)}  ${verdict.padEnd(12)} ` +
				`wall=${(wallMs / 1000).toFixed(1)}s exit=${code} sig=${signal} ` +
				`firstLine=${firstStreamLineAtMs === null ? "NONE" : firstStreamLineAtMs + "ms"} ` +
				`user=${sawUserLine ? "Y" : "n"} asst=${sawAssistant ? "Y" : "n"} result=${sawResult ? "Y" : "n"} ` +
				`missed=${missedHook} census=${censusBefore.count}->${censusAfter.count}`,
			);
			if (verdict !== "PASS") {
				console.log(`        lastDbg: ${lastDbg}`);
				console.log(`        hooks: SessionStart=${dbgSessionStartFired} txOpened=${dbgTranscriptOpened} promptTyped=${dbgPromptTyped} Stop=${dbgStopFired} result=${dbgResultEmitted}`);
			}
			if (censusAfter.count > censusBefore.count) {
				console.log(`        LEAK? census grew. after-lines:\n        ${censusAfter.lines.join("\n        ")}`);
			}
			resolveTurn(rec);
		};

		// Hard backstop: if claude-p truly HANGS (never exits past its own --timeout),
		// kill the group at --timeout + 30s slack and record TRUE_HANG.
		const backstopMs = (TIMEOUT_S + 30) * 1000;
		const backstop = setTimeout(() => {
			console.log(`        !! backstop fired (no exit at timeout+30s) — TRUE HANG. killing group.`);
			try { process.kill(-child.pid, "SIGKILL"); } catch {}
			finish("TRUE_HANG", null);
		}, backstopMs);
		backstop.unref();

		child.on("close", (code, signal) => { clearTimeout(backstop); finish(code, signal); });
		child.on("error", (err) => { clearTimeout(backstop); stderr += `\nSPAWN ERROR: ${err.message}\n`; finish("SPAWN_ERR", null); });
	});
}

(async () => {
	console.log(`\n=== claude-p HANG repro ===`);
	console.log(`model=${MODEL} turns=${TURNS} timeout=${TIMEOUT_S}s bin=${CLAUDE_P_BIN}`);
	console.log(`TMPDIR=${process.env.TMPDIR || "/tmp"}  debugDir=${DEBUG_DIR}\n`);
	const recs = [];
	// CONCURRENCY mode (--concurrency N): launch N spawns simultaneously per wave,
	// TURNS waves. Default 1 = the strict-sequential concurrency-1 path.
	if (CONCURRENCY > 1) {
		console.log(`*** CONCURRENCY=${CONCURRENCY} — ${TURNS} waves of ${CONCURRENCY} simultaneous spawns ***\n`);
		let idx = 0;
		for (let w = 1; w <= TURNS; w++) {
			const wave = [];
			for (let c = 0; c < CONCURRENCY; c++) wave.push(runTurn(++idx));
			recs.push(...(await Promise.all(wave)));
		}
	} else {
		for (let i = 1; i <= TURNS; i++) {
			recs.push(await runTurn(i));
		}
	}
	// Aggregate.
	const fails = recs.filter((r) => r.verdict !== "PASS");
	const byVerdict = {};
	const byMissed = {};
	for (const r of recs) {
		byVerdict[r.verdict] = (byVerdict[r.verdict] || 0) + 1;
		if (r.verdict !== "PASS") byMissed[r.missedHook] = (byMissed[r.missedHook] || 0) + 1;
	}
	console.log(`\n=== SUMMARY (${MODEL}) ===`);
	console.log(`failures: ${fails.length}/${TURNS}`);
	console.log(`by verdict: ${JSON.stringify(byVerdict)}`);
	console.log(`failures by missed-hook: ${JSON.stringify(byMissed)}`);
	const trueHangs = recs.filter((r) => r.exit === "TRUE_HANG").length;
	console.log(`true-hangs (never exited past --timeout): ${trueHangs}`);
	// Did failure rate rise with turn count? Report first-failure turn + spread.
	if (fails.length) {
		console.log(`failed turns: ${fails.map((f) => f.turn).join(", ")}`);
	}
	console.log(`\nfull per-turn logs: ${DEBUG_DIR}`);
	console.log(`summary ndjson: ${SUMMARY}`);
})();
