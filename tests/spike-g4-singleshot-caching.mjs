#!/usr/bin/env node
// SPIKE harness (G4 follow-up): does SINGLE-SHOT interactive claude-p
// (one process per turn + --resume) hit the prompt cache?
//
// NOT a unit test. Run explicitly:
//   RUN_REAL_CLAUDE_P=1 node tests/spike-g4-singleshot-caching.mjs
//
// Uses the REAL bridge wiring: createRouter + buildClaudePArgs + the BUILT
// shim (dist/src/mcp/shim.js) + ClaudePStreamParser. One claude-p process per
// turn. Turn 1 = fresh --session-id; turns 2..N = --resume same id. Captures
// per-turn result.usage AND every per-assistant-message usage.
//
// Concurrency 1 (strictly sequential). Does NOT override CLAUDE_CONFIG_DIR/HOME.
// Model claude-haiku-4-5. Retries flaky turns up to 3x.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

import { createRouter } from "../src/mcp/router.js";
import { buildClaudePArgs } from "../src/driver/claudeP.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const SHIM = join(REPO, "dist", "src", "mcp", "shim.js");
const CLAUDE_P_BIN = join(REPO, "node_modules", ".bin", "claude-p");
const NOTES_DIR = join(REPO, ".spike-notes", "claude-p-gate");
const RAW_DIR = join(NOTES_DIR, "g4-singleshot-raw");

const ENABLED = process.env.RUN_REAL_CLAUDE_P === "1";
const MODEL = "claude-haiku-4-5";
const TIMEOUT_SECONDS = 180;
const MAX_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Stable filler system prompt (~target tokens). Byte-identical every spawn.
// ---------------------------------------------------------------------------
function buildFiller(targetTokens) {
  // ~4 chars/token. Build deterministic, stable paragraphs.
  const targetChars = targetTokens * 4;
  const lines = [];
  let n = 0;
  let len = 0;
  while (len < targetChars) {
    const line =
      `Stable operating rule ${n}: the assistant follows this fixed, constant ` +
      `instruction on every spawn. It is byte-identical across all turns and ` +
      `exists only to create a large, stable system-prompt prefix so we can ` +
      `observe whether the Anthropic prompt cache engages across single-shot ` +
      `--resume spawns. Rule ${n} never varies. Determinism is required.`;
    lines.push(line);
    len += line.length + 1;
    n++;
  }
  return lines.join("\n");
}

const TRIVIAL_SYSTEM = "You are a terse test assistant. Answer in as few words as possible.";

// ---------------------------------------------------------------------------
// Tools for E2/E3 — several bridged MCP tools (bigger stable prefix).
// ---------------------------------------------------------------------------
const TOOLS_MANY = [
  {
    name: "mcp__custom-tools__lookup",
    description:
      "Look up a stored value by key. Returns the value text. Use this when the " +
      "user asks you to retrieve or recall a value you previously stored.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string", description: "the key to look up" } },
      required: ["key"],
    },
  },
  {
    name: "mcp__custom-tools__store",
    description:
      "Store a value under a key for later retrieval. Returns confirmation text.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "the key" },
        value: { type: "string", description: "the value to store" },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "mcp__custom-tools__add",
    description: "Add two numbers and return the sum as text.",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "number", description: "first addend" },
        b: { type: "number", description: "second addend" },
      },
      required: ["a", "b"],
    },
  },
  {
    name: "mcp__custom-tools__upper",
    description: "Uppercase a string and return it.",
    inputSchema: {
      type: "object",
      properties: { s: { type: "string", description: "string to uppercase" } },
      required: ["s"],
    },
  },
  {
    name: "mcp__custom-tools__reverse",
    description: "Reverse a string and return it.",
    inputSchema: {
      type: "object",
      properties: { s: { type: "string", description: "string to reverse" } },
      required: ["s"],
    },
  },
  {
    name: "mcp__custom-tools__now",
    description: "Return a fixed canned timestamp string for testing.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
];

// Canned tool implementation (router onPark resolver).
function runTool(name, args) {
  const bare = name.replace(/^.*__/, "");
  switch (bare) {
    case "add":
      return `sum=${(args.a ?? 0) + (args.b ?? 0)}`;
    case "upper":
      return String(args.s ?? "").toUpperCase();
    case "reverse":
      return String(args.s ?? "").split("").reverse().join("");
    case "store":
      return `stored ${args.key}=${args.value}`;
    case "lookup":
      return `value for ${args.key} is 4242`;
    case "now":
      return "2026-06-01T00:00:00Z";
    default:
      return "ok";
  }
}

function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Run ONE single-shot turn: spawn claude-p, capture raw stdout + parse usage.
// ---------------------------------------------------------------------------
async function runTurn({ systemPromptText, tools, mcpConfig, session, prompt, router }) {
  const cfg = {
    model: MODEL,
    systemPrompt: { kind: "text", text: systemPromptText },
    prompt: { kind: "positional", text: prompt },
    mcpConfig,
    session,
  };
  const args = buildClaudePArgs(cfg);

  const rawChunks = [];
  const child = spawn(CLAUDE_P_BIN, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (c) => rawChunks.push(c));
  const stderrChunks = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => stderrChunks.push(c));

  const start = Date.now();
  const exit = await new Promise((res) => {
    child.on("close", (code, signal) => res({ code, signal }));
    child.on("error", (err) => res({ code: null, signal: null, err }));
  });
  const wallMs = Date.now() - start;
  const raw = rawChunks.join("");
  return { raw, exit, wallMs, stderr: stderrChunks.join("") };
}

// Parse the raw stdout: extract result.usage + every assistant-message usage.
function parseUsage(raw) {
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  let result = null;
  const assistants = [];
  let assistantText = "";
  for (const l of lines) {
    let obj;
    try {
      obj = JSON.parse(l);
    } catch {
      continue;
    }
    if (obj.type === "result") {
      const u = obj.usage ?? {};
      result = {
        input: u.input_tokens ?? 0,
        cacheCreation: u.cache_creation_input_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        output: u.output_tokens ?? 0,
      };
    } else if (obj.type === "assistant" && obj.message?.usage) {
      const u = obj.message.usage;
      assistants.push({
        input: u.input_tokens ?? 0,
        cacheCreation: u.cache_creation_input_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        output: u.output_tokens ?? 0,
      });
      for (const b of obj.message.content ?? []) {
        if (b.type === "text" && b.text) assistantText += b.text;
      }
    }
  }
  return { result, assistants, assistantText: assistantText.slice(0, 200) };
}

// ---------------------------------------------------------------------------
// Run a multi-turn experiment (single-shot per turn).
// ---------------------------------------------------------------------------
async function runExperiment({ label, systemPromptText, tools, prompts }) {
  // One router/shim wiring shared (tools advertised once). Router resolves any
  // parked tools/call with the canned implementation.
  const router = createRouter({
    onPark: (info) => {
      const text = runTool(info.name, info.arguments ?? {});
      router.deliver(info.piId, { content: [{ type: "text", text }] });
    },
  });
  router.declareTools(tools);
  await router.start();

  const toolsB64 = Buffer.from(JSON.stringify(tools), "utf-8").toString("base64");
  const mcpConfig = JSON.stringify({
    mcpServers: {
      "custom-tools": {
        command: process.execPath,
        args: [SHIM, "--socket", router.socketPath, "--mode", "main", "--tools", toolsB64],
      },
    },
  });

  const sessionId = randomUUID();
  const turns = [];
  let allRaw = "";

  for (let i = 0; i < prompts.length; i++) {
    const session = i === 0 ? { kind: "fresh", sessionId } : { kind: "resume", sessionId };
    let parsed = null;
    let attemptsUsed = 0;
    let lastExit = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      attemptsUsed = attempt;
      const { raw, exit, wallMs, stderr } = await runTurn({
        systemPromptText,
        tools,
        mcpConfig,
        session,
        prompt: prompts[i],
        router,
      });
      lastExit = exit;
      const p = parseUsage(raw);
      allRaw += `\n===== ${label} TURN ${i + 1} (${session.kind}) attempt ${attempt} exit=${exit.code} wall=${wallMs}ms =====\n`;
      allRaw += raw;
      if (p.result) {
        parsed = { ...p, wallMs, stderr: stderr.slice(0, 300) };
        break;
      }
      console.error(`[${label}] turn ${i + 1} attempt ${attempt} FLAKY (no result) exit=${exit.code} stderr=${stderr.slice(0, 200)}`);
    }
    turns.push({
      turn: i + 1,
      mode: session.kind,
      attemptsUsed,
      ...(parsed ?? { result: null, assistants: [], assistantText: "(NO RESULT)", wallMs: 0 }),
    });
    console.error(`[${label}] turn ${i + 1} done: ${parsed ? JSON.stringify(parsed.result) : "FAILED"}`);
  }

  await router.stop().catch(() => {});
  return { label, turns, raw: allRaw };
}

// ---------------------------------------------------------------------------
// Format per-turn tables
// ---------------------------------------------------------------------------
function fmtTable(exp) {
  const rows = [];
  rows.push(`### ${exp.label}`);
  rows.push("");
  rows.push("| turn | mode | input | cache_creation | cache_read | uncached | output | attempts |");
  rows.push("|------|------|-------|----------------|------------|----------|--------|----------|");
  for (const t of exp.turns) {
    const r = t.result;
    if (!r) {
      rows.push(`| ${t.turn} | ${t.mode} | (NO RESULT) | | | | | ${t.attemptsUsed} |`);
      continue;
    }
    const uncached = r.input - r.cacheRead - r.cacheCreation;
    rows.push(
      `| ${t.turn} | ${t.mode} | ${r.input} | ${r.cacheCreation} | ${r.cacheRead} | ${uncached} | ${r.output} | ${t.attemptsUsed} |`,
    );
  }
  rows.push("");
  // Per-assistant-message usage detail
  rows.push("Per-assistant-message usage (input/cache_creation/cache_read/output):");
  rows.push("");
  for (const t of exp.turns) {
    const segs = t.assistants.map((a) => `[${a.input}/${a.cacheCreation}/${a.cacheRead}/${a.output}]`).join(" ");
    rows.push(`- turn ${t.turn} (${t.mode}): ${segs || "(none)"} — reply: ${JSON.stringify(t.assistantText)}`);
  }
  rows.push("");
  return rows.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  if (!ENABLED) {
    console.error("set RUN_REAL_CLAUDE_P=1 to run this spike");
    process.exit(2);
  }
  if (!existsSync(SHIM)) throw new Error(`built shim missing at ${SHIM} — run npm run build`);
  if (!existsSync(CLAUDE_P_BIN)) throw new Error(`claude-p missing at ${CLAUDE_P_BIN}`);
  mkdirSync(RAW_DIR, { recursive: true });

  // Large filler ~10k tokens. Measure byte size.
  const LARGE_SYS = buildFiller(10000) + "\n\nYou will be asked to remember and recall a favorite number across turns.";
  console.error(`LARGE_SYS bytes=${LARGE_SYS.length} (~${Math.round(LARGE_SYS.length / 4)} tok est)`);

  // E1: large system, NO tools, 4 turns.
  const e1 = await runExperiment({
    label: "E1 (large sys, no tools)",
    systemPromptText: LARGE_SYS,
    tools: [], // no tools
    prompts: [
      "My favorite number is 4242. Acknowledge with just 'ok'.",
      "What is my favorite number? Reply with just the number.",
      "Add 1 to my favorite number. Reply with just the result.",
      "Subtract 2 from that. Reply with just the result.",
    ],
  });

  // E2: large system + many tools, 4 turns; turn 1 calls a tool.
  const e2 = await runExperiment({
    label: "E2 (large sys, 6 tools)",
    systemPromptText: LARGE_SYS,
    tools: TOOLS_MANY,
    prompts: [
      "Use the store tool to store key 'fav' with value '4242'. Then reply 'ok'.",
      "Use the lookup tool to get key 'fav'. Reply with just the value.",
      "Use the add tool to add 1 and 4242. Reply with just the sum.",
      "Use the upper tool on the string 'hello'. Reply with just the result.",
    ],
  });

  // E3: control — trivial system + same tools, 4 turns; turn 1 calls a tool.
  const e3 = await runExperiment({
    label: "E3 (trivial sys, 6 tools)",
    systemPromptText: TRIVIAL_SYSTEM,
    tools: TOOLS_MANY,
    prompts: [
      "Use the store tool to store key 'fav' with value '4242'. Then reply 'ok'.",
      "Use the lookup tool to get key 'fav'. Reply with just the value.",
      "Use the add tool to add 1 and 4242. Reply with just the sum.",
      "Use the upper tool on the string 'hello'. Reply with just the result.",
    ],
  });

  // Persist raw fixtures.
  writeFileSync(join(RAW_DIR, "e1.raw.txt"), e1.raw, "utf8");
  writeFileSync(join(RAW_DIR, "e2.raw.txt"), e2.raw, "utf8");
  writeFileSync(join(RAW_DIR, "e3.raw.txt"), e3.raw, "utf8");

  const meta = {
    largeSysBytes: LARGE_SYS.length,
    largeSysTokEst: Math.round(LARGE_SYS.length / 4),
    trivialSysBytes: TRIVIAL_SYSTEM.length,
    model: MODEL,
  };
  writeFileSync(
    join(RAW_DIR, "summary.json"),
    JSON.stringify({ meta, e1: e1.turns, e2: e2.turns, e3: e3.turns }, null, 2),
    "utf8",
  );

  // Emit tables to stdout for the handoff.
  console.log("====== RESULTS ======");
  console.log(`meta: ${JSON.stringify(meta)}`);
  console.log(fmtTable(e1));
  console.log(fmtTable(e2));
  console.log(fmtTable(e3));
}

main().catch((err) => {
  console.error("SPIKE FAILED:", err);
  process.exit(1);
});
