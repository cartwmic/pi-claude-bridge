/**
 * Probe 0.1 — Verify EXACT capture-path SDK option set for outputFormat.
 *
 * Tests:
 *   (a) WITH allowDangerouslySkipPermissions: true
 *   (b) WITHOUT allowDangerouslySkipPermissions (omitted)
 *   (c) Empty prompt with non-empty systemPrompt
 *
 * Auth: Claude subscription (~/.claude.json), no ANTHROPIC_API_KEY needed.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { tmpdir, homedir } from "os";
import { join } from "path";
import { readFileSync } from "fs";

// ─── Cleaned submit_digest schema (from pi-session-search/src/digest/schema.ts) ──
// Equivalent of JSON.parse(JSON.stringify(DigestArgs)) — deep plain-object clone.
const rawSchema = {
  type: "object",
  properties: {
    body: { type: "string", minLength: 50 },
    headline: { type: "string", minLength: 1, maxLength: 80 },
    topics: {
      type: "array",
      items: { type: "string", maxLength: 32 },
      minItems: 0,
      maxItems: 5,
    },
    outcome: { type: "string", maxLength: 200 },
  },
  required: ["body", "headline", "topics"],
};
// Simulate cleanSchemaForSdk
const cleanedSchema = JSON.parse(JSON.stringify(rawSchema));

const DISALLOWED_BUILTIN_TOOLS = [
  "Read", "Write", "Edit", "Glob", "Grep", "Bash", "Agent",
  "NotebookEdit", "EnterWorktree", "ExitWorktree",
  "CronCreate", "CronDelete", "CronList", "TeamCreate", "TeamDelete",
  "WebFetch", "WebSearch", "TodoRead", "TodoWrite",
  "EnterPlanMode", "ExitPlanMode", "RemoteTrigger", "SendMessage",
  "ListMcpResourcesTool", "ReadMcpResourceTool",
  "ToolSearch", "Skill", "AskUserQuestion", "PushNotification",
  "ScheduleWakeup", "TaskOutput", "TaskStop", "BashOutput", "Monitor", "Mcp",
];

function buildColdStartPromptSimple(userText) {
  return userText;
}

async function runProbe(label, options, prompt) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`PROBE ${label}`);
  console.log("=".repeat(60));
  console.log("Options:", JSON.stringify({ ...options, outputFormat: options.outputFormat ? "[present]" : undefined }, null, 2));
  console.log("Prompt:", prompt ? `"${prompt.slice(0, 80)}"` : "(empty string)");

  const startMs = Date.now();
  try {
    const sdkQuery = query({ prompt, options });
    let resultMsg = null;
    let initMsg = null;
    let msgCount = 0;

    for await (const message of sdkQuery) {
      msgCount++;
      if (message.type === "system" && message.subtype === "init") {
        initMsg = message;
        console.log(`  [system:init] session_id=${message.session_id?.slice(0, 8)} pid=${(message).pid ?? "(not exposed)"}`);
      } else if (message.type === "result") {
        resultMsg = message;
        break; // Stop after result
      }
    }

    const elapsed = Date.now() - startMs;
    console.log(`\n  RESULT (${elapsed}ms, ${msgCount} messages):`);
    if (resultMsg) {
      console.log(`    subtype: ${resultMsg.subtype}`);
      console.log(`    structured_output present: ${resultMsg.structured_output !== undefined}`);
      if (resultMsg.structured_output !== undefined) {
        console.log(`    structured_output:`, JSON.stringify(resultMsg.structured_output, null, 4));
      }
      console.log(`    is_error: ${resultMsg.is_error}`);
      if (resultMsg.usage) {
        console.log(`    usage: input=${resultMsg.usage.input_tokens} output=${resultMsg.usage.output_tokens} cache_read=${resultMsg.usage.cache_read_input_tokens} cache_creation=${resultMsg.usage.cache_creation_input_tokens}`);
      }
      if (resultMsg.errors?.length > 0) {
        console.log(`    errors: ${JSON.stringify(resultMsg.errors)}`);
      }
    } else {
      console.log(`    No result message received (iterator closed after ${msgCount} messages)`);
    }

    // Best-effort interrupt
    try { await sdkQuery.interrupt(); } catch (e) { console.log(`  interrupt() error: ${e.message}`); }

  } catch (err) {
    const elapsed = Date.now() - startMs;
    console.log(`  ERROR (${elapsed}ms): ${err.message}`);
    if (err.stack) console.log(err.stack.split("\n").slice(1, 4).join("\n"));
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

const baseOptions = {
  outputFormat: { type: "json_schema", schema: cleanedSchema },
  disallowedTools: DISALLOWED_BUILTIN_TOOLS,
  permissionMode: "bypassPermissions",
  cwd: tmpdir(),
  settingSources: [],
  extraArgs: { model: "claude-haiku-4-5", "strict-mcp-config": null },
  systemPrompt: "You are a digest writer.",
};

const userPrompt = "Summarize a short conversation: 'User: What is TypeScript? Assistant: TypeScript is a typed superset of JavaScript that compiles to plain JavaScript.'";

console.log("Probe 0.1 — outputFormat SDK option verification");
console.log(`Cleaned schema: ${JSON.stringify(cleanedSchema).slice(0, 200)}`);

// (a) WITH allowDangerouslySkipPermissions: true
await runProbe("(a) WITH allowDangerouslySkipPermissions=true", {
  ...baseOptions,
  allowDangerouslySkipPermissions: true,
}, userPrompt);

// (b) WITHOUT allowDangerouslySkipPermissions (omitted)
await runProbe("(b) WITHOUT allowDangerouslySkipPermissions", {
  ...baseOptions,
}, userPrompt);

// (c) Empty prompt with non-empty systemPrompt
await runProbe("(c) Empty prompt with non-empty systemPrompt", {
  ...baseOptions,
  allowDangerouslySkipPermissions: true,
}, "");

console.log("\n\n=== PROBE 0.1 COMPLETE ===\n");
