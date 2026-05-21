// Spike T0.14 — RE-RUN with TrustDialogScanner per D25.
//
// Spawns `claude` interactively in a FRESH tmpdir (untrusted cwd) via
// node-pty, attaches the scanner from src/driver/pty.ts, and asserts the
// (i)-(v) hard-gate criteria from tasks.md T0.14.

import * as pty from "node-pty";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, realpathSync, watch } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { TrustDialogScanner } from "../src/driver/pty.js";

const CLAUDE_BIN = "/Users/cartwmic/.local/bin/claude";

const cwd = realpathSync(mkdtempSync(join(tmpdir(), "spike-t14b-")));
const uuid = randomUUID();
const encodedCwd = cwd.replaceAll("/", "-");
const transcriptDir = join(homedir(), ".claude", "projects", encodedCwd);
const transcriptPath = join(transcriptDir, uuid + ".jsonl");

const hookLog = join(cwd, "hook.log");
const hookScript = join(cwd, "hook.mjs");
writeFileSync(hookScript, `
import { readFileSync, appendFileSync } from "node:fs";
const evt = process.argv[2];
let stdin = "";
try { stdin = readFileSync(0, "utf8"); } catch {}
appendFileSync(${JSON.stringify(hookLog)}, JSON.stringify({t: Date.now(), evt, stdin: stdin.slice(0, 1200)}) + "\\n");
process.stdout.write("{}");
`);

const settings = JSON.stringify({
	hooks: {
		SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: `node "${hookScript}" session-start` }] }],
		Stop: [{ matcher: "*", hooks: [{ type: "command", command: `node "${hookScript}" stop` }] }],
	},
});

console.log("cwd:", cwd);
console.log("uuid:", uuid);
console.log("transcriptPath:", transcriptPath);

const args = [
	"--session-id", uuid,
	"--system-prompt", "Reply OK.",
	"--strict-mcp-config",
	"--setting-sources", "",
	"--dangerously-skip-permissions",
	"--settings", settings,
	"hello",
];

const proc = pty.spawn(CLAUDE_BIN, args, {
	name: "xterm-256color",
	cols: 100,
	rows: 30,
	cwd,
	env: process.env,
});

const t0 = Date.now();
let ptyOutput = "";
let dialogDetectedAt = null;
let keystrokeSentAt = null;
let scannerFailed = null;

const scanner = new TrustDialogScanner({
	onAnswer: (data) => {
		keystrokeSentAt = Date.now() - t0;
		proc.write(data);
		dialogDetectedAt = keystrokeSentAt;
		console.log(`[scanner] dialog detected + answered @ +${keystrokeSentAt}ms`);
	},
	onFailure: (reason) => {
		scannerFailed = reason;
		console.log(`[scanner] FAILURE @ +${Date.now() - t0}ms: ${reason}`);
	},
	dialogTimeoutMs: 8000,
	hardTimeoutMs: 25000,
});
scanner.start();

proc.onData((d) => {
	ptyOutput += d;
	scanner.feed(d);
});

let exited = null;
proc.onExit((e) => {
	exited = e;
	console.log(`[pty] exited @ +${Date.now() - t0}ms`, e);
});

// Watch the transcript dir for file creation, notify scanner.
let transcriptCreatedAt = null;
let transcriptWatcher = null;
let dirWatcher = null;
try {
	// transcriptDir may not exist yet; watch the parent
	const parent = join(homedir(), ".claude", "projects");
	dirWatcher = watch(parent, { recursive: true }, (_event, filename) => {
		if (filename && filename.includes(uuid)) {
			if (!transcriptCreatedAt && existsSync(transcriptPath)) {
				transcriptCreatedAt = Date.now() - t0;
				scanner.notifyTranscriptCreated();
				console.log(`[transcript] file appeared @ +${transcriptCreatedAt}ms`);
			}
		}
	});
} catch (err) {
	console.log("[transcript] dirWatcher failed:", err.message);
}

// Also poll as a safety net (fs.watch on macOS sometimes misses)
const pollInterval = setInterval(() => {
	if (!transcriptCreatedAt && existsSync(transcriptPath)) {
		transcriptCreatedAt = Date.now() - t0;
		scanner.notifyTranscriptCreated();
		console.log(`[transcript] file detected via poll @ +${transcriptCreatedAt}ms`);
	}
}, 250);

// Wait 20s
await new Promise((r) => setTimeout(r, 20000));

const hookLogContent = existsSync(hookLog) ? readFileSync(hookLog, "utf8") : "";
const sessionStartFired = hookLogContent.includes('"evt":"session-start"');
const transcriptExists = existsSync(transcriptPath);
let assistantLineSeen = false;
let transcriptLineCount = 0;
if (transcriptExists) {
	const lines = readFileSync(transcriptPath, "utf8").split("\n").filter((l) => l.trim());
	transcriptLineCount = lines.length;
	for (const ln of lines) {
		try {
			if (JSON.parse(ln).type === "assistant") assistantLineSeen = true;
		} catch {}
	}
}
const aliveAt20s = exited === null;

console.log("\n=== 20s status ===");
console.log("scanner state:", scanner.getState());
console.log("dialog detected:", dialogDetectedAt !== null, dialogDetectedAt !== null ? `+${dialogDetectedAt}ms` : "");
console.log("keystroke sent:", keystrokeSentAt !== null);
console.log("SessionStart fired:", sessionStartFired);
console.log("Transcript exists:", transcriptExists, transcriptExists ? `(${transcriptLineCount} lines)` : "");
console.log("Assistant JSONL line seen:", assistantLineSeen);
console.log("PTY alive:", aliveAt20s);
console.log("scanner failure:", scannerFailed);

console.log("\n=== sending SIGINT ===");
proc.kill("SIGINT");

const exitResult = await new Promise((r) => {
	if (exited) return r(exited);
	const handler = (e) => r(e);
	proc.onExit(handler);
	setTimeout(() => r({ timeout: true }), 8000);
});

clearInterval(pollInterval);
if (dirWatcher) dirWatcher.close();

const hookLogFinal = existsSync(hookLog) ? readFileSync(hookLog, "utf8") : "";
const stopFiredPostAbort = hookLogFinal.includes('"evt":"stop"');

console.log("Exit after SIGINT:", exitResult);
console.log("Stop hook fired:", stopFiredPostAbort);

// Re-read transcript after SIGINT (Stop hook may have written more)
let finalLineCount = 0;
let finalAssistant = false;
if (existsSync(transcriptPath)) {
	const lines = readFileSync(transcriptPath, "utf8").split("\n").filter((l) => l.trim());
	finalLineCount = lines.length;
	for (const ln of lines) {
		try {
			if (JSON.parse(ln).type === "assistant") finalAssistant = true;
		} catch {}
	}
}

console.log("\n=== FINAL VERDICT ===");
const v_i = dialogDetectedAt !== null && dialogDetectedAt <= 5000;
const v_ii = sessionStartFired;
const v_iii = finalAssistant;
const v_iv = aliveAt20s;
const v_v = stopFiredPostAbort || (exitResult && typeof exitResult.exitCode !== "undefined");
console.log(`  (i)   scanner detected dialog + sent keystroke ≤ 5s: ${v_i} (${dialogDetectedAt}ms)`);
console.log(`  (ii)  SessionStart hook fired: ${v_ii}`);
console.log(`  (iii) ≥1 assistant JSONL line: ${v_iii} (final lines: ${finalLineCount})`);
console.log(`  (iv)  PTY alive when SIGINT sent: ${v_iv}`);
console.log(`  (v)   Stop hook fired OR clean exit: ${v_v}`);
const pass = v_i && v_ii && v_iii && v_iv && v_v;
console.log(`HARD GATE: ${pass ? "PASS" : "FAIL"}`);

writeFileSync(join(cwd, "pty-output.log"), ptyOutput);
writeFileSync(join(cwd, "hook-log.log"), hookLogFinal);
console.log("\nPTY bytes:", ptyOutput.length);
console.log("Logs at:", cwd);
console.log("\nhook log content:", hookLogFinal.slice(0, 800));

process.exit(pass ? 0 : 1);
