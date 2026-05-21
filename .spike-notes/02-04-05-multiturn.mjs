// T0.5 (mid-turn session_id rotation) + T0.4 (fs.watch reliability) +
// T0.2 (thinking blocks in transcript).
//
// One PTY spawn, multiple turns. After turn 1 we send another user prompt
// via PTY stdin and watch what happens to session_id, transcript path, and
// whether any 'thinking' content block appears.

import * as pty from "node-pty";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, realpathSync, watch } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { TrustDialogScanner } from "../src/driver/pty.js";

const CLAUDE_BIN = "/Users/cartwmic/.local/bin/claude";
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "spike-t02-")));
const uuid = randomUUID();
const encodedCwd = cwd.replaceAll("/", "-");
const transcriptPath = join(homedir(), ".claude", "projects", encodedCwd, uuid + ".jsonl");

const hookLog = join(cwd, "hook.log");
const hookScript = join(cwd, "hook.mjs");
writeFileSync(hookScript, `
import { readFileSync, appendFileSync } from "node:fs";
const evt = process.argv[2];
let stdin = "";
try { stdin = readFileSync(0, "utf8"); } catch {}
appendFileSync(${JSON.stringify(hookLog)}, JSON.stringify({t: Date.now(), evt, stdin: stdin.slice(0, 2000)}) + "\\n");
process.stdout.write("{}");
`);

const settings = JSON.stringify({
	hooks: {
		SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: `node "${hookScript}" session-start` }] }],
		Stop: [{ matcher: "*", hooks: [{ type: "command", command: `node "${hookScript}" stop` }] }],
	},
});

const args = [
	"--session-id", uuid,
	"--system-prompt", "Reply with at most 5 words.",
	"--strict-mcp-config",
	"--setting-sources", "",
	"--dangerously-skip-permissions",
	"--settings", settings,
	"What's 2+2?",
];

const proc = pty.spawn(CLAUDE_BIN, args, {
	name: "xterm-256color", cols: 100, rows: 30, cwd, env: process.env,
});

const scanner = new TrustDialogScanner({
	onAnswer: (d) => proc.write(d),
	onFailure: (r) => console.log("[scanner] failure:", r),
	dialogTimeoutMs: 8000,
	hardTimeoutMs: 25000,
});
scanner.start();

let exited = null;
proc.onData((d) => scanner.feed(d));
proc.onExit((e) => { exited = e; });

// fs.watch counters for T0.4
let watchEventsForTranscript = 0;
let firstWatchAt = null;
const parent = join(homedir(), ".claude", "projects");
const dirWatcher = watch(parent, { recursive: true }, (_event, filename) => {
	if (filename && filename.includes(uuid)) {
		watchEventsForTranscript++;
		if (!firstWatchAt) firstWatchAt = Date.now();
	}
});

function readTranscript() {
	if (!existsSync(transcriptPath)) return [];
	return readFileSync(transcriptPath, "utf8").split("\n").filter((l) => l.trim()).map((l) => {
		try { return JSON.parse(l); } catch { return null; }
	}).filter(Boolean);
}
function getAssistantTurns() {
	return readTranscript().filter((e) => e.type === "assistant");
}

// Wait for turn 1 to complete
const t0 = Date.now();
let turn1AssistantCount = 0;
while (!exited && Date.now() - t0 < 25000) {
	await new Promise((r) => setTimeout(r, 500));
	if (existsSync(transcriptPath)) scanner.notifyTranscriptCreated();
	const turns = getAssistantTurns();
	if (turns.length >= 1) {
		turn1AssistantCount = turns.length;
		break;
	}
}
console.log(`[turn 1] assistant turns: ${turn1AssistantCount} (after ${Date.now() - t0}ms)`);

// Brief pause then send turn 2
await new Promise((r) => setTimeout(r, 1500));
console.log("[sending turn 2]");
proc.write("What's 5+5?\r");

// Wait for turn 2
const t1 = Date.now();
while (!exited && Date.now() - t1 < 25000) {
	await new Promise((r) => setTimeout(r, 500));
	const turns = getAssistantTurns();
	if (turns.length > turn1AssistantCount) break;
}
const finalTurns = getAssistantTurns();
console.log(`[turn 2] assistant turns: ${finalTurns.length} (after ${Date.now() - t1}ms)`);

// Hook log: read all SessionStart payloads, check session_id stability
const hookLogContent = existsSync(hookLog) ? readFileSync(hookLog, "utf8") : "";
const sessionStartLines = hookLogContent.split("\n").filter((l) => l.includes("session-start")).map((l) => {
	try { return JSON.parse(JSON.parse(l).stdin); } catch { return null; }
}).filter(Boolean);
const stopLines = hookLogContent.split("\n").filter((l) => l.includes('"stop"')).map((l) => {
	try { return JSON.parse(JSON.parse(l).stdin); } catch { return null; }
}).filter(Boolean);

console.log("[hooks] SessionStart fires:", sessionStartLines.length);
console.log("[hooks] Stop fires:", stopLines.length);
console.log("[hooks] All session_ids match supplied uuid:",
	[...sessionStartLines, ...stopLines].every((p) => p.session_id === uuid));
console.log("[hooks] Stop sources:", stopLines.map((p) => p.last_assistant_message).slice(0, 3));

// Check transcript: same session_id throughout, multiple assistant turns
const transcript = readTranscript();
const uniqueSessionIds = new Set(transcript.map((e) => e.sessionId).filter(Boolean));
const userTurnCount = transcript.filter((e) => e.type === "user").length;
console.log("[transcript] unique sessionIds:", [...uniqueSessionIds]);
console.log("[transcript] user turns:", userTurnCount);
console.log("[transcript] assistant turns:", finalTurns.length);

// T0.2: scan all assistant content for thinking blocks
let thinkingSeen = false;
let thinkingBlockShape = null;
for (const turn of finalTurns) {
	const blocks = turn.message?.content || [];
	for (const b of blocks) {
		if (b.type === "thinking" || b.type === "redacted_thinking") {
			thinkingSeen = true;
			thinkingBlockShape = { type: b.type, keys: Object.keys(b) };
		}
	}
}
console.log("[T0.2] thinking block seen:", thinkingSeen, thinkingBlockShape || "");

// T0.4: fs.watch firing
console.log("[T0.4] fs.watch events for transcript:", watchEventsForTranscript);
console.log("[T0.4] first watch event delay (ms):", firstWatchAt ? firstWatchAt - t0 : "n/a");

// Cleanup
proc.kill("SIGINT");
await new Promise((r) => setTimeout(r, 2000));
dirWatcher.close();

// Verdicts
const t05_pass = uniqueSessionIds.size === 1 && [...uniqueSessionIds][0] === uuid && finalTurns.length >= 2;
const t04_pass = watchEventsForTranscript >= 1;
console.log("\n=== VERDICTS ===");
console.log("T0.5 (session_id stable across turns):", t05_pass ? "PASS" : `FAIL (turns=${finalTurns.length}, ids=${[...uniqueSessionIds]})`);
console.log("T0.4 (fs.watch fires for transcript):", t04_pass ? "PASS" : "FAIL");
console.log("T0.2 (thinking block in transcript):", thinkingSeen ? "OBSERVED" : "NOT OBSERVED (model didn't emit thinking on this prompt; not a fail since extended thinking wasn't requested)");
