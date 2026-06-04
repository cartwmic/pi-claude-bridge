#!/usr/bin/env node
// mcp-attach-race-proof.mjs — IRREFUTABLE proof of the tool-protocol-leak root cause.
//
// CLAIM UNDER TEST (the RCA I asserted): under concurrent-boot CPU contention,
// claude-p presses Enter (submits the prompt) BEFORE `claude` has completed the
// MCP `tools/list` handshake — so the model begins its turn with the bridged
// `mcp__*` tools ABSENT from its roster. Asked to use a tool, it then emits the
// tool call as TEXT (`<function_calls>`/`<tool_use>`) or fails to route, because
// a tool that isn't declared has no structured channel.
//
// DESIGN (single system clock; everything in absolute Date.now() ms):
//   * Per spawn we run the PATCHED claude-p (echo-confirm fork) exactly as the
//     bridge does: interactive TUI, --mcp-config pointing at the instrumented
//     mcp-readiness-server.mjs, all native tools disallowed so the ONLY callable
//     tool is the MCP `pi_ping`. No WaitForMcpServers in the system prompt — we
//     isolate the PURE race (the production WaitForMcpServers guard is separately
//     proven ineffective: real session 019e8c37 leaked despite it).
//   * T_send  = absolute time claude-p logs "prompt echo confirmed; Enter sent"
//               (its own +Nms debug clock, anchored to spawn wall-time; also
//               cross-checked against stderr-arrival time).
//   * T_list  = absolute Date.now() the MCP server logs for tools/list:responding
//               (= the bridged roster becomes available).
//   * T_call  = absolute Date.now() of a REAL structured tools/call (success).
//   * leaked  = claude's own transcript assistant text contains tool-protocol markup.
//
// DECISIVE per spawn:
//   T_send < T_list  → RACE LOST: prompt submitted before tools attached.
//   RACE LOST + (no real tools/call OR leaked markup) → the asserted mechanism, observed.
//   T_list < T_send  → race won: tools attached first → expect a real tools/call.
//
// DIAGNOSIS ONLY. No src edits. Does NOT override CLAUDE_CONFIG_DIR/HOME.
// Usage: node mcp-attach-race-proof.mjs [--concurrency 5] [--waves 4] [--timeout 75] [--load 10] [--model claude-haiku-4-5]

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
const WAVES = parseInt(arg("waves", "4"), 10);
const TIMEOUT_S = parseInt(arg("timeout", "75"), 10);
const LOAD = parseInt(arg("load", "10"), 10);
// Controlled MCP-attach delay: HOLD tools/list this many ms so the bridged roster
// provably becomes available AFTER the prompt-Enter point (race lost by construction).
const MCP_DELAY = parseInt(arg("mcpDelay", "0"), 10);

// A prompt that REQUIRES the bridged tool — exercises the model's behavior when
// that tool is (or isn't) in its roster.
const PROMPT = "Ping pi now using your pi_ping tool, then reply with ONLY the sentinel string the tool returns.";
const BASE_SYSTEM = "You are a helpful assistant. When asked to ping, you MUST call the pi_ping tool and then reply with only the sentinel string it returns.";
// --preamble ON prepends the EXACT production MCP-startup-race preamble
// (index.ts CLAUDE_P_MCP_WAIT_PREAMBLE), adapted to this spike's server/tool
// names. It (a) forbids declining and (b) primes the `mcp__<server>__<name>`
// text format + the WaitForMcpServers instruction.
const PREAMBLE_ON = process.argv.includes("--preamble");
const SPIKE_PREFIX = "mcp__pi-spike-tools__";
const PREAMBLE =
  `Your tools are provided by an MCP server named "pi-spike-tools" that may still ` +
  `be connecting when your turn begins. Tool names you can call therefore appear as ` +
  `\`${SPIKE_PREFIX}<name>\`. If a tool you need or were asked to use is not yet in ` +
  `your available tools, you MUST first call the \`WaitForMcpServers\` tool and wait for ` +
  `the server to finish connecting, THEN use the tool. Never tell the user a bridged ` +
  `(\`${SPIKE_PREFIX}*\`) tool is unavailable, and never decline a request, without ` +
  `first calling \`WaitForMcpServers\`.`;
const SYSTEM_PROMPT = PREAMBLE_ON ? `${PREAMBLE}\n\n${BASE_SYSTEM}` : BASE_SYSTEM;

const DISALLOWED = [
  "Read","Write","Edit","Bash","Glob","Grep","WebFetch","WebSearch","NotebookEdit",
  "Agent","Task","Skill","ToolSearch","AskUserQuestion","EnterPlanMode","ExitPlanMode",
  "EnterWorktree","ExitWorktree","TodoWrite","TaskCreate","TaskGet","TaskList","TaskUpdate",
  "TaskOutput","TaskStop","BashOutput","Monitor","Workflow","ScheduleWakeup","CronCreate",
  "CronDelete","CronList","PushNotification","RemoteTrigger",
].join(" ");

const RCA_DIR = "/tmp/pi-spike-rca";
mkdirSync(RCA_DIR, { recursive: true });
const TS = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = resolve(HERE, `mcp-attach-race-proof-${MODEL}-${TS}`);
mkdirSync(OUT, { recursive: true });

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
function stopLoad() { for (const pid of loadWorkers) { try { process.kill(pid, "SIGKILL"); } catch {} } }

function buildArgs(sessionId, mcpLogPath) {
  const MCP_CONFIG = JSON.stringify({
    mcpServers: { "pi-spike-tools": { command: "node", args: [resolve(HERE, "mcp-readiness-server.mjs"), "--log", mcpLogPath, "--startup-delay-ms", String(MCP_DELAY)] } },
  });
  return [
    "--model", MODEL, "--system-prompt", SYSTEM_PROMPT, "--mcp-config", MCP_CONFIG,
    "--disallowedTools", DISALLOWED, "--strict-mcp-config", "--setting-sources", "",
    "--permission-mode", "bypassPermissions", "--session-id", sessionId,
    "--output-format", "stream-json", "--verbose", "--timeout", String(TIMEOUT_S),
    "--debug", PROMPT,
  ];
}

const TOOL_MARKUP = /<\/?(function_calls|tool_use|tool_call|function_call|invoke)[\s>]|<parameter\s+name=/;

// Read the MCP server's per-spawn milestone log.
function readMcpLog(path) {
  const out = { exists: false, serverStart: null, listRecv: null, listResp: null, call: null, callName: null };
  if (!existsSync(path)) return out;
  out.exists = true;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.event === "server-start" && out.serverStart == null) out.serverStart = o.t;
    if (o.event === "tools/list:received" && out.listRecv == null) out.listRecv = o.t;
    if (o.event === "tools/list:responding" && out.listResp == null) out.listResp = o.t;
    if (o.event === "tools/call:received" && out.call == null) { out.call = o.t; out.callName = o.name; }
  }
  return out;
}

// Parse claude's OWN transcript JSONL — independent ground truth for the leak.
function inspectTranscript(path) {
  const out = { exists: false, users: 0, assistants: 0, leaked: false, leakSample: null, assistantText: "" };
  if (!path || !existsSync(path)) return out;
  out.exists = true;
  let raw = ""; try { raw = readFileSync(path, "utf8"); } catch { return out; }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === "user") out.users++;
    if (o.type === "assistant") {
      out.assistants++;
      const c = o.message?.content;
      const txt = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : "";
      out.assistantText += txt;
      if (!out.leaked && TOOL_MARKUP.test(txt)) {
        out.leaked = true;
        const m = txt.match(TOOL_MARKUP);
        out.leakSample = txt.slice(Math.max(0, (m?.index ?? 0) - 20), (m?.index ?? 0) + 80).replace(/\n/g, "\\n");
      }
    }
  }
  return out;
}

function runSpawn(label) {
  return new Promise((res) => {
    const sessionId = randomUUID();
    const mcpLogPath = resolve(RCA_DIR, `${sessionId}.mcp.log`);
    const tSpawn = Date.now();
    const child = spawn(process.execPath, [CLAUDE_P_BIN, ...buildArgs(sessionId, mcpLogPath)], {
      detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", sbuf = "";
    let sawResultLine = false;
    // claude-p markers (absolute, anchored to tSpawn + its own +Nms debug clock)
    let enterRelMs = null, enterArriveAbs = null, inkUpRelMs = null;
    let promptTypedAttempts = 0, echoConfirmed = false, promptNotAccepted = false;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      stdout += c;
      let nl, b = (stdout.match(/[^\n]*$/) || [""])[0]; // cheap: re-scan full lines below
      // detect result line
      for (const ln of c.split("\n")) { if (!ln.trim()) continue; try { if (JSON.parse(ln).type === "result") sawResultLine = true; } catch {} }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => {
      stderr += c; sbuf += c; let nl;
      while ((nl = sbuf.indexOf("\n")) >= 0) {
        const ln = sbuf.slice(0, nl); sbuf = sbuf.slice(nl + 1);
        const rel = (() => { const m = ln.match(/\[claude-p \+(\d+)ms\]/); return m ? parseInt(m[1], 10) : null; })();
        if (/SessionStart hook fired/.test(ln) && inkUpRelMs == null) inkUpRelMs = rel;
        if (/typing prompt \(/.test(ln)) promptTypedAttempts++;
        if (/prompt echo confirmed; Enter sent/.test(ln) && enterRelMs == null) { enterRelMs = rel; enterArriveAbs = Date.now(); echoConfirmed = true; }
        if (/PromptNotAccepted/.test(ln)) promptNotAccepted = true;
      }
    });

    const backstop = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, (TIMEOUT_S + 25) * 1000);
    backstop.unref();

    child.on("close", (code, signal) => {
      clearTimeout(backstop);
      const wallMs = Date.now() - tSpawn;
      let txPath = null; const m = stderr.match(/"transcript_path":"([^"]+\.jsonl)"/); if (m) txPath = m[1];
      const tx = inspectTranscript(txPath);
      const mcp = readMcpLog(mcpLogPath);

      // Anchor claude-p's Enter to absolute wall-time two independent ways.
      const enterAbsByClock = enterRelMs != null ? tSpawn + enterRelMs : null; // claude-p's own clock
      const enterAbs = enterAbsByClock ?? enterArriveAbs;                       // prefer claude-p clock
      const listAbs = mcp.listResp ?? mcp.listRecv;

      // gap = T_list - T_send. Positive → tools attached AFTER Enter (RACE LOST).
      const gapMs = (listAbs != null && enterAbs != null) ? listAbs - enterAbs : null;
      const raceLost = gapMs != null ? gapMs > 0 : (enterAbs != null && listAbs == null); // Enter sent, list never came
      const toolRouted = mcp.call != null;

      let verdict;
      if (!echoConfirmed) verdict = "NO-ENTER" + (promptNotAccepted ? "(PromptNotAccepted)" : "");
      else if (raceLost && (!toolRouted || tx.leaked)) verdict = "RACE-LOST→FAIL";
      else if (raceLost && toolRouted) verdict = "RACE-LOST→recovered";
      else if (!raceLost && toolRouted) verdict = "race-won→ok";
      else verdict = "race-won→noroute";

      const rec = {
        label, sessionId, verdict, exit: code, signal, wallMs,
        inkUpRelMs, enterRelMs, promptTypedAttempts, echoConfirmed, promptNotAccepted,
        tSpawn, enterAbs, listAbs, callAbs: mcp.call, gapMs, raceLost, toolRouted,
        mcp: { serverStart: mcp.serverStart, listRecv: mcp.listRecv, listResp: mcp.listResp, call: mcp.call, callName: mcp.callName },
        tx: { exists: tx.exists, users: tx.users, assistants: tx.assistants, leaked: tx.leaked, leakSample: tx.leakSample },
        sawResultLine, txPath,
      };
      writeFileSync(resolve(OUT, `${label}.log`),
        `${JSON.stringify(rec, null, 2)}\n\n===== ASSISTANT TEXT (claude transcript) =====\n${tx.assistantText}\n\n===== STDERR (--debug) =====\n${stderr}\n`);
      res(rec);
    });
    child.on("error", (e) => { clearTimeout(backstop); res({ label, sessionId, verdict: "SPAWN_ERR", err: e.message }); });
  });
}

(async () => {
  console.log(`\n=== claude-p MCP-ATTACH-RACE PROOF ===`);
  console.log(`model=${MODEL} concurrency=${CONCURRENCY} waves=${WAVES} timeout=${TIMEOUT_S}s load=${LOAD} mcpDelay=${MCP_DELAY}ms`);
  console.log(`bin=${CLAUDE_P_BIN}\nout=${OUT}\n`);
  console.log(`Legend: gapMs = T_list - T_send  (POSITIVE = prompt submitted BEFORE tools attached = RACE LOST)\n`);
  startLoad();
  const all = [];
  for (let w = 1; w <= WAVES; w++) {
    const wave = [];
    for (let c = 0; c < CONCURRENCY; c++) wave.push(runSpawn(`w${w}-s${c}`));
    const recs = await Promise.all(wave);
    all.push(...recs);
    for (const r of recs) {
      console.log(
        `[${(r.verdict || "?").padEnd(22)}] ${String(r.label).padEnd(7)} ` +
        `inkUp=${r.inkUpRelMs ?? "?"}ms enter=${r.enterRelMs ?? "?"}ms attempts=${r.promptTypedAttempts ?? "?"} ` +
        `| gap(list-send)=${r.gapMs == null ? "?" : (r.gapMs > 0 ? "+" : "") + r.gapMs + "ms"} ` +
        `toolRouted=${r.toolRouted ? "Y" : "n"} leaked=${r.tx?.leaked ? "Y" : "n"} ` +
        `tx[u=${r.tx?.users ?? "?"},a=${r.tx?.assistants ?? "?"}]`,
      );
    }
  }
  stopLoad();

  const cnt = {};
  for (const r of all) cnt[r.verdict] = (cnt[r.verdict] || 0) + 1;
  const raceLost = all.filter((r) => r.raceLost);
  const raceLostFail = all.filter((r) => r.verdict === "RACE-LOST→FAIL");
  const gaps = all.filter((r) => r.gapMs != null).map((r) => r.gapMs).sort((a, b) => a - b);
  console.log(`\n=== SUMMARY ===`);
  console.log(`total spawns: ${all.length}`);
  console.log(`verdict breakdown:`); for (const [k, v] of Object.entries(cnt)) console.log(`  ${v} × ${k}`);
  console.log(`race lost (Enter before tools/list): ${raceLost.length}/${all.length}`);
  console.log(`race lost AND failed/leaked:          ${raceLostFail.length}/${all.length}`);
  if (gaps.length) console.log(`gap(list-send) ms — min=${gaps[0]} median=${gaps[Math.floor(gaps.length / 2)]} max=${gaps[gaps.length - 1]}`);
  const leaks = all.filter((r) => r.tx?.leaked);
  console.log(`spawns with leaked tool-protocol markup in transcript: ${leaks.length}`);
  writeFileSync(resolve(OUT, "summary.json"), JSON.stringify({ params: { MODEL, CONCURRENCY, WAVES, TIMEOUT_S, LOAD }, cnt, gaps, all }, null, 2));
  console.log(`\nper-spawn logs + transcripts + assistant text: ${OUT}`);
})();
