/**
 * Probe 0.2 — Verify subprocess teardown behavior.
 *
 * Tests:
 *   (a) interrupt() immediately after result
 *   (b) Let iterator close naturally (no interrupt)
 *
 * For each: assert child PID exited and zero unhandled rejections.
 * Auth: Claude subscription (~/.claude.json).
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { tmpdir } from "os";
import process from "process";

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

const cleanedSchema = JSON.parse(JSON.stringify({
  type: "object",
  properties: {
    body: { type: "string", minLength: 50 },
    headline: { type: "string", minLength: 1, maxLength: 80 },
    topics: { type: "array", items: { type: "string", maxLength: 32 }, minItems: 0, maxItems: 5 },
  },
  required: ["body", "headline", "topics"],
}));

const baseOptions = {
  outputFormat: { type: "json_schema", schema: cleanedSchema },
  disallowedTools: DISALLOWED_BUILTIN_TOOLS,
  permissionMode: "bypassPermissions",
  allowDangerouslySkipPermissions: true,
  cwd: tmpdir(),
  settingSources: [],
  extraArgs: { model: "claude-haiku-4-5", "strict-mcp-config": null },
  systemPrompt: "You are a digest writer.",
};

const prompt = "Summarize: 'User asked about Node.js, assistant explained it is a JS runtime.'";

let unhandledRejectionCount = 0;
process.on("unhandledRejection", (reason) => {
  unhandledRejectionCount++;
  console.error(`UNHANDLED REJECTION #${unhandledRejectionCount}:`, reason);
});

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code !== "ESRCH";
  }
}

async function waitForPidExit(pid, maxMs = 5000) {
  const step = 100;
  let elapsed = 0;
  while (elapsed < maxMs) {
    if (!pidAlive(pid)) return true;
    await new Promise(r => setTimeout(r, step));
    elapsed += step;
  }
  return false;
}

async function runTeardownProbe(label, useInterrupt) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`TEARDOWN PROBE ${label}`);
  console.log("=".repeat(60));

  const sdkQuery = query({ prompt, options: baseOptions });

  // Try to observe PID
  let capturedPid = undefined;
  const internalProcess = (sdkQuery)._process;
  if (internalProcess?.pid) {
    capturedPid = internalProcess.pid;
    console.log(`  PID via sdkQuery._process.pid: ${capturedPid}`);
  } else {
    console.log(`  sdkQuery._process?.pid not exposed`);
    // Try other approaches
    const keys = Object.keys(sdkQuery);
    console.log(`  sdkQuery keys: ${keys.join(", ") || "(none)"}`);
    // Look for any numeric pid
    for (const k of Object.getOwnPropertyNames(Object.getPrototypeOf(sdkQuery))) {
      if (k !== "constructor") {
        try {
          const v = sdkQuery[k];
          if (typeof v === "number" && v > 0) console.log(`  sdkQuery.${k} = ${v}`);
        } catch {}
      }
    }
  }

  let resultMsg = null;
  let msgCount = 0;
  const startMs = Date.now();

  for await (const message of sdkQuery) {
    msgCount++;
    if (message.type === "system" && message.subtype === "init") {
      console.log(`  [system:init] session_id=${message.session_id?.slice(0, 8)}`);
      // Try to get PID from init message
      if ((message).pid) {
        capturedPid = (message).pid;
        console.log(`  PID via system:init.pid: ${capturedPid}`);
      }
    } else if (message.type === "result") {
      resultMsg = message;
      console.log(`  [result] subtype=${message.subtype} structured_output=${message.structured_output !== undefined}`);

      if (useInterrupt) {
        console.log(`  Calling interrupt() immediately after result...`);
        try {
          await sdkQuery.interrupt();
          console.log(`  interrupt() resolved`);
        } catch (e) {
          console.log(`  interrupt() threw: ${e.message}`);
        }
        break; // Exit iterator immediately
      } else {
        console.log(`  Letting iterator continue naturally (no interrupt)...`);
        // Don't break — let iterator drain naturally
      }
    }
  }

  const elapsed = Date.now() - startMs;
  console.log(`  Iterator done after ${elapsed}ms, ${msgCount} messages`);

  // Check PID
  if (capturedPid !== undefined) {
    const exited = await waitForPidExit(capturedPid, 5000);
    console.log(`  PID ${capturedPid} exited within 5s: ${exited}`);
    if (!exited) {
      console.log(`  WARNING: PID ${capturedPid} still alive after 5s!`);
    }
  } else {
    console.log(`  PID not captured — cannot verify subprocess exit`);
  }

  // Wait a bit for any unhandled rejections to surface
  await new Promise(r => setTimeout(r, 500));
  console.log(`  Unhandled rejections so far: ${unhandledRejectionCount}`);
}

// (a) interrupt() immediately after result
await runTeardownProbe("(a) interrupt() after result", true);

// Reset count between probes
const countAfterA = unhandledRejectionCount;

// (b) Let iterator close naturally
await runTeardownProbe("(b) natural iterator close (no interrupt)", false);

const countAfterB = unhandledRejectionCount;

console.log("\n\n=== PROBE 0.2 SUMMARY ===");
console.log(`(a) interrupt after result: unhandled rejections = ${countAfterA}`);
console.log(`(b) natural close: unhandled rejections = ${countAfterB - countAfterA}`);
console.log(`Decision 5 recommendation: ${countAfterA === 0 ? "interrupt() is safe" : "prefer natural close"}`);
console.log("=== PROBE 0.2 COMPLETE ===\n");
