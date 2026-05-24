// Spike T0.14 — Interactive-mode positional-prompt liveness HARD GATE
import * as pty from "node-pty";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";

const CLAUDE_BIN = "/Users/cartwmic/.local/bin/claude";
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "spike-t14-")));
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
appendFileSync(${JSON.stringify(hookLog)}, JSON.stringify({t: Date.now(), evt, stdin: stdin.slice(0, 800)}) + "\\n");
process.stdout.write("{}");
`);

const settings = JSON.stringify({
  hooks: {
    SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: `node "${hookScript}" session-start` }] }],
    Stop: [{ matcher: "*", hooks: [{ type: "command", command: `node "${hookScript}" stop` }] }],
  }
});

console.log("cwd:", cwd);
console.log("transcriptPath:", transcriptPath);

const args = [
  "--session-id", uuid,
  "--system-prompt", "Reply OK to any input.",
  "--strict-mcp-config",
  "--setting-sources", "",
  "--dangerously-skip-permissions",
  "--settings", settings,
  "hello"
];

const proc = pty.spawn(CLAUDE_BIN, args, {
  name: "xterm-256color", cols: 80, rows: 24, cwd, env: process.env
});

let ptyOutput = "";
proc.onData(d => { ptyOutput += d; });
let exited = null;
proc.onExit(e => { exited = e; });

// Wait 15s
await new Promise(r => setTimeout(r, 15000));

const hookLogContent = existsSync(hookLog) ? readFileSync(hookLog, "utf8") : "";
const sessionStartFired = hookLogContent.includes('"evt":"session-start"');
const transcriptExists = existsSync(transcriptPath);
let assistantLineSeen = false;
if (transcriptExists) {
  const lines = readFileSync(transcriptPath, "utf8").split("\n").filter(l => l.trim());
  for (const ln of lines) { try { if (JSON.parse(ln).type === "assistant") assistantLineSeen = true; } catch {} }
}
const aliveAt15s = exited === null;

console.log("\n=== 15s status ===");
console.log("SessionStart fired:", sessionStartFired);
console.log("Transcript exists:", transcriptExists);
console.log("Assistant JSONL line seen:", assistantLineSeen);
console.log("Process alive:", aliveAt15s);
console.log("hookLog:", hookLogContent.slice(0, 600));

console.log("\n=== sending SIGINT ===");
proc.kill("SIGINT");

const exitResult = await new Promise(r => {
  if (exited) return r(exited);
  proc.onExit(e => r(e));
  setTimeout(() => r({ timeout: true }), 8000);
});

const hookLogFinal = existsSync(hookLog) ? readFileSync(hookLog, "utf8") : "";
const stopFiredPostAbort = hookLogFinal.includes('"evt":"stop"');

console.log("Exit after SIGINT:", exitResult);
console.log("Stop hook fired:", stopFiredPostAbort);
console.log("\nVERDICT:");
console.log("  (i) SessionStart fired:", sessionStartFired);
console.log("  (ii) Transcript file appeared:", transcriptExists);
console.log("  (iii) Assistant JSONL line appeared:", assistantLineSeen);
console.log("  (iv) Process alive at 15s:", aliveAt15s);
console.log("  (v) Clean SIGINT exit:", exitResult && typeof exitResult.exitCode !== "undefined");
console.log("  (vi) Stop hook fired post-abort:", stopFiredPostAbort);
console.log("  HARD-GATE PASS:", sessionStartFired && transcriptExists && assistantLineSeen && aliveAt15s);

writeFileSync(join(cwd, "pty-output.log"), ptyOutput);
console.log("\nPTY output bytes:", ptyOutput.length);
