#!/usr/bin/env node
// coldstart-perpetuation-proof.mjs — does a POISONED conversation_history (prior
// assistant turn containing tool-calls-as-TEXT) make the model KEEP emitting tool
// calls as text, EVEN WHEN the real MCP tools are present in its roster?
//
// This drives the bridge's REAL cold-start path: buildColdStartPrompt (index.ts:580)
// embeds pi's prior conversation verbatim as `[assistant] <text>` inside a
// <conversation_history> block. If turn 1's leaked <function_calls> text reached
// pi history, a cold-start turn 2 re-feeds it to the model. (The bridge cold-starts
// on cache-drop — and finalizeClaudePFrame CLEARS the cache on a tool-protocol-leak,
// so a leak DETERMINISTICALLY forces the next turn to cold-start with the poison.)
//
// TWO ARMS, tools PRESENT (no attach delay), opus-4-7, real production preamble:
//   POISONED: prior [assistant] text = the REAL leaked turn-1 markup from session 019e8c37.
//   CLEAN:    prior [assistant] text = a prose paraphrase, NO markup.
// If POISONED leaks and CLEAN does not → the replayed text-protocol is the cause.
//
// Captures the model's NEW output (claude transcript) + raw claude-p stream.
// Usage: node coldstart-perpetuation-proof.mjs [--n 3] [--model claude-opus-4-7] [--timeout 120]

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const CLAUDE_P_BIN = resolve(REPO, "node_modules", ".bin", "claude-p");
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const MODEL = arg("model", "claude-opus-4-7");
const N = parseInt(arg("n", "3"), 10);
const TIMEOUT_S = parseInt(arg("timeout", "120"), 10);

const RCA_DIR = "/tmp/pi-spike-rca"; mkdirSync(RCA_DIR, { recursive: true });
const TS = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = resolve(HERE, `coldstart-perpetuation-${MODEL}-${TS}`); mkdirSync(OUT, { recursive: true });

// SHORT, SIZE-MATCHED arms so prompt SIZE is not a confound (a large poison fails
// echo-confirm with PromptNotAccepted before the model ever runs). The poison keeps
// the real leak's SHAPE: a prior [assistant] turn whose text contains a
// <function_calls><invoke name="mcp__custom-tools__bash"> tool-call-as-TEXT block.
const POISON_ASSISTANT =
  'Let me check your config.\n<function_calls>\n<invoke name="mcp__custom-tools__bash">\n<parameter name="command">grep -rIE "opus|default" ~/.claude ~/.pi 2>/dev/null | head</parameter>\n</invoke>\n</function_calls>';
const CLEAN_ASSISTANT =
  'Let me check your config. I looked through your ~/.claude and ~/.pi directories for the default model setting, scanning for "opus" and "default" entries, but I want to confirm the exact value before I answer.';

const CURRENT_MSG = "Continue — finish answering my question using your tools, and report exactly what you find.";
// faithful replica of index.ts buildColdStartPrompt()'s <conversation_history> block
function historyBlock(priorAssistantText) {
  return [
    "<conversation_history>",
    "The following is our prior conversation in this session. Treat it as context.",
    `[user] What is my default opus model set to in my pi/claude config?`,
    `[assistant] ${priorAssistantText}`,
    "</conversation_history>",
  ].join("\n");
}
// buildColdStartPrompt() puts history + current msg in the TYPED prompt (faithful,
// but the markup makes echo-confirm flaky → PromptNotAccepted confound).
function buildColdStartPrompt(priorAssistantText) {
  return `${historyBlock(priorAssistantText)}\n\nUser's current message:\n${CURRENT_MSG}`;
}
// --history-in-system: same context CONTENT, but the history rides in the system
// prompt (argv, NOT typed through the PTY), so echo-confirm can't fail on it.
// Isolates the model's susceptibility to poisoned history from the PTY confound.
const HISTORY_IN_SYSTEM = process.argv.includes("--history-in-system");

const SPIKE_PREFIX = "mcp__pi-spike-tools__";
const PREAMBLE =
  `Your tools are provided by an MCP server named "pi-spike-tools" that may still ` +
  `be connecting when your turn begins. Tool names you can call therefore appear as ` +
  `\`${SPIKE_PREFIX}<name>\`. If a tool you need or were asked to use is not yet in ` +
  `your available tools, you MUST first call the \`WaitForMcpServers\` tool and wait for ` +
  `the server to finish connecting, THEN use the tool. Never tell the user a bridged ` +
  `(\`${SPIKE_PREFIX}*\`) tool is unavailable, and never decline a request, without ` +
  `first calling \`WaitForMcpServers\`.`;
const SYSTEM_PROMPT = `${PREAMBLE}\n\nYou are a helpful assistant. Use the pi_ping tool when you need to inspect the system; it returns a sentinel.`;

const DISALLOWED = [
  "Read","Write","Edit","Bash","Glob","Grep","WebFetch","WebSearch","NotebookEdit","Agent","Task","Skill",
  "ToolSearch","AskUserQuestion","EnterPlanMode","ExitPlanMode","EnterWorktree","ExitWorktree","TodoWrite",
  "TaskCreate","TaskGet","TaskList","TaskUpdate","TaskOutput","TaskStop","BashOutput","Monitor","Workflow",
  "ScheduleWakeup","CronCreate","CronDelete","CronList","PushNotification","RemoteTrigger",
].join(" ");
const TOOL_MARKUP = /<\/?(function_calls|tool_use|tool_call|function_call|invoke)[\s>]|<parameter\s+name=/;

function buildArgs(sessionId, mcpLogPath, prompt, systemPrompt) {
  const MCP_CONFIG = JSON.stringify({ mcpServers: { "pi-spike-tools": { command: "node", args: [resolve(HERE, "mcp-readiness-server.mjs"), "--log", mcpLogPath, "--startup-delay-ms", "0"] } } });
  return [
    "--model", MODEL, "--system-prompt", systemPrompt, "--mcp-config", MCP_CONFIG,
    "--disallowedTools", DISALLOWED, "--strict-mcp-config", "--setting-sources", "",
    "--permission-mode", "bypassPermissions", "--session-id", sessionId,
    "--output-format", "stream-json", "--verbose", "--timeout", String(TIMEOUT_S), "--debug", prompt,
  ];
}

function inspectTranscript(path) {
  const out = { exists: false, leaked: false, leakSample: null, text: "" };
  if (!path || !existsSync(path)) return out;
  out.exists = true;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === "assistant") {
      const c = o.message?.content;
      const txt = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : "";
      out.text += txt;
      if (!out.leaked && TOOL_MARKUP.test(txt)) {
        out.leaked = true;
        const m = txt.match(TOOL_MARKUP);
        out.leakSample = txt.slice(Math.max(0, (m?.index ?? 0) - 20), (m?.index ?? 0) + 100).replace(/\n/g, "\\n");
      }
    }
  }
  return out;
}

function runSpawn(arm, label, prompt, systemPrompt) {
  return new Promise((res) => {
    const sessionId = randomUUID();
    const mcpLogPath = resolve(RCA_DIR, `${sessionId}.mcp.log`);
    const child = spawn(process.execPath, [CLAUDE_P_BIN, ...buildArgs(sessionId, mcpLogPath, prompt, systemPrompt)], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", toolRouted = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => { stderr += c; });
    const backstop = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, (TIMEOUT_S + 25) * 1000);
    backstop.unref();
    child.on("close", (code) => {
      clearTimeout(backstop);
      try { for (const l of readFileSync(mcpLogPath, "utf8").split("\n")) { if (l.includes("tools/call:received")) toolRouted = true; } } catch {}
      let txPath = null; const m = stderr.match(/"transcript_path":"([^"]+\.jsonl)"/); if (m) txPath = m[1];
      const tx = inspectTranscript(txPath);
      const runErr = (stderr.match(/claude-p:\s*(\w+)/) || [])[1] || null;
      const stopFired = /Stop hook fired/.test(stderr); // the model actually produced a turn
      // THE real signal: markup in the MODEL's generated output (stdout stream-json
      // assistant TEXT events) — NOT the prompt echo. Parse assistant events only.
      let modelOutLeaked = false, modelLeakSample = null, modelText = "";
      for (const ln of stdout.split("\n")) {
        if (!ln.trim()) continue;
        let o; try { o = JSON.parse(ln); } catch { continue; }
        if (o.type !== "assistant") continue;
        const c = o.message?.content;
        const txt = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : "";
        modelText += txt;
        if (!modelOutLeaked && TOOL_MARKUP.test(txt)) {
          modelOutLeaked = true;
          const m = txt.match(TOOL_MARKUP);
          modelLeakSample = txt.slice(Math.max(0, (m?.index ?? 0) - 20), (m?.index ?? 0) + 100).replace(/\n/g, "\\n");
        }
      }
      const rec = { arm, label, sessionId, exit: code, runErr, stopFired, modelOutLeaked, modelLeakSample, txLeaked: tx.leaked, toolRouted, txPath };
      writeFileSync(resolve(OUT, `${arm}-${label}.log`), `${JSON.stringify(rec, null, 2)}\n\n===== MODEL NEW OUTPUT (transcript) =====\n${tx.text}\n\n===== CLAUDE-P STDOUT (what the bridge parses) =====\n${stdout}\n\n===== PROMPT SENT =====\n${prompt}\n\n===== STDERR =====\n${stderr}\n`);
      res(rec);
    });
    child.on("error", (e) => { clearTimeout(backstop); res({ arm, label, sessionId, err: e.message, leaked: false }); });
  });
}

(async () => {
  console.log(`\n=== COLD-START PERPETUATION PROOF ===`);
  console.log(`model=${MODEL} n=${N}/arm  tools PRESENT (no delay)  preamble ON  historyInSystem=${HISTORY_IN_SYSTEM}`);
  console.log(`poison shape: prior [assistant] text carries <function_calls><invoke name="mcp__custom-tools__bash"> (${POISON_ASSISTANT.length} chars)`);
  console.log(`out=${OUT}\n`);
  // POISONED vs CLEAN differ ONLY in the prior [assistant] history text (markup vs prose).
  // history-in-system: identical context content, but history rides in the system prompt
  // (argv) so the TYPED prompt is short+markup-free → no PromptNotAccepted confound.
  const armCfg = (assistant) => HISTORY_IN_SYSTEM
    ? { system: `${SYSTEM_PROMPT}\n\n${historyBlock(assistant)}`, prompt: CURRENT_MSG }
    : { system: SYSTEM_PROMPT, prompt: buildColdStartPrompt(assistant) };
  const poison = armCfg(POISON_ASSISTANT), clean = armCfg(CLEAN_ASSISTANT);
  const jobs = [];
  for (let i = 0; i < N; i++) jobs.push(runSpawn("POISONED", `s${i}`, poison.prompt, poison.system));
  for (let i = 0; i < N; i++) jobs.push(runSpawn("CLEAN", `s${i}`, clean.prompt, clean.system));
  const all = await Promise.all(jobs);
  for (const r of all) console.log(
    `[${r.arm.padEnd(8)} ${r.label}] modelRan(Stop)=${r.stopFired ? "Y" : "n"} ` +
    `MODEL-OUTPUT-LEAK=${r.modelOutLeaked ? "YES" : "no"} toolRouted=${r.toolRouted ? "Y" : "n"} ` +
    `exit=${r.exit}${r.runErr ? `(${r.runErr})` : ""}${r.modelOutLeaked ? `  sample="${r.modelLeakSample}"` : ""}`);
  // Count ONLY genuine model-output leaks where the model actually ran.
  const pL = all.filter((r) => r.arm === "POISONED" && r.modelOutLeaked).length;
  const cL = all.filter((r) => r.arm === "CLEAN" && r.modelOutLeaked).length;
  const pRan = all.filter((r) => r.arm === "POISONED" && r.stopFired).length;
  const cRan = all.filter((r) => r.arm === "CLEAN" && r.stopFired).length;
  console.log(`\n=== SUMMARY (model-OUTPUT leaks only; prompt echo excluded) ===`);
  console.log(`POISONED: model ran ${pRan}/${N}, of which leaked ${pL}`);
  console.log(`CLEAN:    model ran ${cRan}/${N}, of which leaked ${cL}`);
  console.log(pL > 0 && cL === 0
    ? `\n>>> PERPETUATION CONFIRMED: poisoned history → model GENERATES tool-calls-as-text; clean history does not.`
    : `\n>>> NOT cleanly reproduced this run (poisoned model-leaks=${pL}, clean model-leaks=${cL}; poisoned ran=${pRan}/${N}).`);
  writeFileSync(resolve(OUT, "summary.json"), JSON.stringify({ MODEL, N, all, pL, cL, pRan, cRan }, null, 2));
  console.log(`\nlogs: ${OUT}`);
})();
