#!/usr/bin/env node
// Controlled reproduction matrix for claude-p PromptNotAccepted.
// Diagnosis-only: creates files under .spike-notes; does not edit src.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
function flag(name) { return process.argv.includes(`--${name}`); }
const TS = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = resolve(arg("out", resolve(HERE, `promptnotaccepted-rootcause-${TS}`)));
const CLAUDE_P_BIN = arg("claude-p", process.env.CLAUDE_P_BIN || resolve(REPO, "node_modules", ".bin", "claude-p"));
const TIMEOUT_S = Number(arg("timeout", "45"));
const TRIALS = Number(arg("trials", "5"));
const C_BATCHES = Number(arg("c-batches", String(TRIALS))); // each C batch launches 4 at once
const INCLUDE_THRESHOLD = flag("include-threshold");
const ONLY_THRESHOLD = flag("only-threshold");
const THRESHOLD_LENGTHS = arg("lengths", "50,200,400,800").split(",").map(s => Number(s.trim())).filter(Boolean);
const SYSTEM_PROMPT = "You are a helpful assistant. Reply tersely and do not use tools.";

const DISALLOWED = [
  "Read","Write","Edit","Bash","Glob","Grep","WebFetch","WebSearch","NotebookEdit",
  "Agent","Task","Skill","ToolSearch","AskUserQuestion","EnterPlanMode","ExitPlanMode",
  "EnterWorktree","ExitWorktree","TodoWrite","TaskCreate","TaskGet","TaskList","TaskUpdate",
  "TaskOutput","TaskStop","BashOutput","Monitor","Workflow","ScheduleWakeup","CronCreate",
  "CronDelete","CronList","PushNotification","RemoteTrigger",
].join(" ");

const shortPrompt = "Reply with OK";
const longPrompt = "Task: Analyze the following issue and reply with exactly OK. We are debugging a cold-start prompt submission path for a terminal UI wrapper. The wrapper types a realistic delegated-agent task into the Claude Code Ink interface, waits for an echo, and then sends Enter. This paragraph intentionally resembles a production subagent instruction with detailed constraints, background, and acceptance criteria. It includes enough ordinary prose to exceed six hundred characters while still asking for a tiny response. Please do not use tools, do not explain, do not include markdown, and do not mention these instructions; simply return OK so the trial is cheap and the measurement focuses on prompt acceptance rather than generation latency. Extra filler for length boundary validation: alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu.";

function promptOfLength(n) {
  const base = "Reply exactly OK. Diagnostic prompt length boundary probe. ";
  if (n <= base.length) return ("Reply exactly OK. " + "x".repeat(n)).slice(0, n);
  const filler = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu ";
  let s = base;
  while (s.length < n) s += filler;
  return s.slice(0, n);
}

mkdirSync(OUT, { recursive: true });
const summaryPath = resolve(OUT, "summary.ndjson");
const aggregatePath = resolve(OUT, "aggregate.md");
writeFileSync(resolve(OUT, "harness-config.json"), JSON.stringify({
  createdAt: new Date().toISOString(), cwd: process.cwd(), claudePBin: CLAUDE_P_BIN,
  timeoutSeconds: TIMEOUT_S, trials: TRIALS, cBatches: C_BATCHES, includeThreshold: INCLUDE_THRESHOLD,
  onlyThreshold: ONLY_THRESHOLD, thresholdLengths: THRESHOLD_LENGTHS,
  prompts: { shortLength: shortPrompt.length, longLength: longPrompt.length },
}, null, 2));

function buildArgs({ model, prompt, debugFile, sessionId }) {
  return [
    "--model", model,
    "--system-prompt", SYSTEM_PROMPT,
    "--disallowedTools", DISALLOWED,
    "--strict-mcp-config",
    "--setting-sources", "",
    "--permission-mode", "bypassPermissions",
    "--session-id", sessionId,
    "--output-format", "stream-json",
    "--verbose",
    "--timeout", String(TIMEOUT_S),
    "--debug",
    "--debug-file", debugFile,
    prompt,
  ];
}

function oneTrial(cell, idx, spec) {
  return new Promise((resolveTrial) => {
    const trialDir = resolve(OUT, `${cell}-${String(idx).padStart(3, "0")}`);
    mkdirSync(trialDir, { recursive: true });
    const stdoutPath = resolve(trialDir, "stdout.ndjson");
    const stderrPath = resolve(trialDir, "stderr.log");
    const debugFile = resolve(trialDir, "claude-debug.log");
    const promptPath = resolve(trialDir, "prompt.txt");
    writeFileSync(promptPath, spec.prompt);
    const sessionId = randomUUID();
    const args = buildArgs({ ...spec, sessionId, debugFile });
    writeFileSync(resolve(trialDir, "argv.json"), JSON.stringify([CLAUDE_P_BIN, ...args], null, 2));
    const start = Date.now();
    const child = spawn(CLAUDE_P_BIN, args, { stdio: ["ignore", "pipe", "pipe"], cwd: REPO });
    let stdout = "", stderr = "", lineBuf = "";
    let firstLineAtMs = null, sawResult = false, sawAssistant = false, sawUser = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk; lineBuf += chunk;
      let nl; while ((nl = lineBuf.indexOf("\n")) >= 0) {
        const line = lineBuf.slice(0, nl); lineBuf = lineBuf.slice(nl + 1);
        if (!line.trim()) continue;
        if (firstLineAtMs === null) firstLineAtMs = Date.now() - start;
        try {
          const obj = JSON.parse(line);
          if (obj.type === "user") sawUser = true;
          if (obj.type === "assistant") sawAssistant = true;
          if (obj.type === "result") sawResult = true;
        } catch {}
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code, signal) => {
      const wallMs = Date.now() - start;
      writeFileSync(stdoutPath, stdout);
      writeFileSync(stderrPath, stderr);
      let claudeDebug = "";
      try { claudeDebug = readFileSync(debugFile, "utf8"); } catch {}
      const traceLines = stderr.split("\n").filter(l => l.includes("[claude-p +"));
      const lastTrace = traceLines.at(-1)?.trim() || "";
      const promptNotAccepted = /PromptNotAccepted/.test(stderr + stdout);
      const pasteMentions = (stderr + "\n" + claudeDebug).split("\n").filter(l => /paste|Pasted text|bracket/i.test(l)).slice(0, 20);
      const authQuota = /(login|auth|quota|rate limit|credit|billing|unauthorized)/i.test(stderr + stdout + claudeDebug);
      const rec = {
        cell, idx, model: spec.model, promptLength: spec.prompt.length, concurrency: spec.concurrency,
        exit: code, signal, wallMs, ok: code === 0 && sawResult, promptNotAccepted, authQuota,
        sawUser, sawAssistant, sawResult, firstLineAtMs, lastTrace, pasteMentions,
        trialDir,
      };
      writeFileSync(resolve(trialDir, "meta.json"), JSON.stringify(rec, null, 2));
      appendFileSync(summaryPath, JSON.stringify(rec) + "\n");
      const verdict = rec.ok ? "PASS" : promptNotAccepted ? "PNA" : `FAIL(${code ?? signal})`;
      console.log(`${cell} #${idx} ${verdict} model=${spec.model} len=${spec.prompt.length} wall=${(wallMs/1000).toFixed(2)}s last=${lastTrace}`);
      resolveTrial(rec);
    });
  });
}

async function runSerial(cell, count, spec) {
  const out = [];
  for (let i = 1; i <= count; i++) out.push(await oneTrial(cell, i, { ...spec, concurrency: 1 }));
  return out;
}
async function runBatches(cell, batches, width, spec) {
  const out = [];
  let idx = 1;
  for (let b = 0; b < batches; b++) {
    const batch = [];
    for (let j = 0; j < width; j++) batch.push(oneTrial(cell, idx++, { ...spec, concurrency: width }));
    out.push(...await Promise.all(batch));
  }
  return out;
}

function summarize(records) {
  const by = new Map();
  for (const r of records) {
    if (!by.has(r.cell)) by.set(r.cell, []);
    by.get(r.cell).push(r);
  }
  let md = `# PromptNotAccepted matrix aggregate\n\n`;
  md += `- claude-p: ${CLAUDE_P_BIN}\n- cwd: ${REPO}\n- timeout: ${TIMEOUT_S}s\n- generated: ${new Date().toISOString()}\n\n`;
  md += `| Cell | Model | Prompt len | Concurrency | Trials | Pass | PromptNotAccepted | Other fail | Median wall |\n`;
  md += `|---|---:|---:|---:|---:|---:|---:|---:|---:|\n`;
  for (const [cell, rs] of [...by.entries()].sort()) {
    const pass = rs.filter(r => r.ok).length;
    const pna = rs.filter(r => r.promptNotAccepted).length;
    const other = rs.length - pass - pna;
    const walls = rs.map(r => r.wallMs).sort((a,b)=>a-b);
    const median = walls.length ? walls[Math.floor(walls.length/2)] : 0;
    md += `| ${cell} | ${rs[0].model} | ${rs[0].promptLength} | ${rs[0].concurrency} | ${rs.length} | ${pass} | ${pna} | ${other} | ${(median/1000).toFixed(2)}s |\n`;
  }
  md += `\n## Last traces\n\n`;
  for (const r of records) md += `- ${r.cell} #${r.idx}: exit=${r.exit} ok=${r.ok} pna=${r.promptNotAccepted} wall=${r.wallMs}ms — ${r.lastTrace}\n`;
  writeFileSync(aggregatePath, md);
}

const records = [];
if (!ONLY_THRESHOLD) {
  records.push(...await runSerial("A-long-opus-c1", TRIALS, { model: "claude-opus-4-8", prompt: longPrompt }));
  records.push(...await runSerial("B-short-opus-c1", TRIALS, { model: "claude-opus-4-8", prompt: shortPrompt }));
  records.push(...await runBatches("C-long-opus-c4", C_BATCHES, 4, { model: "claude-opus-4-8", prompt: longPrompt }));
  records.push(...await runSerial("D-long-haiku-c1", TRIALS, { model: "claude-haiku-4-5", prompt: longPrompt }));
}
if (INCLUDE_THRESHOLD || ONLY_THRESHOLD) {
  for (const len of THRESHOLD_LENGTHS) {
    records.push(...await runSerial(`E-len${len}-opus-c1`, TRIALS, { model: "claude-opus-4-8", prompt: promptOfLength(len) }));
  }
}
summarize(records);
console.log(`\nWrote ${OUT}`);
