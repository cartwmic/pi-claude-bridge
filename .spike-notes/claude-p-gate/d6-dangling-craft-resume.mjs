#!/usr/bin/env node
// T0.2 part B: craft a GENUINELY dangling tool_use transcript (remove the trailing
// tool_result that claude auto-wrote on the MCP disconnect), then resume it through
// the full claude-p + suppressResumeReplay path. This is R7's literal precondition:
// "the recorded driver transcript ends with an unclosed tool call."
//
// Run: node --import tsx .spike-notes/claude-p-gate/d6-dangling-craft-resume.mjs <sessionId>
import { existsSync, readFileSync, writeFileSync, readdirSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { createRouter } from "../../src/mcp/router.js";
import { buildClaudePArgs } from "../../src/driver/claudeP.js";
import { ClaudePStreamParser } from "../../src/driver/stream.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..", "..");
const SHIM = join(REPO, "dist", "src", "mcp", "shim.js");
const CLAUDE_P_BIN = join(REPO, "node_modules", ".bin", "claude-p");
const MODEL = process.env.MODEL ?? "claude-haiku-4-5";
const SESSION = process.argv[2];
const WORK = "/tmp/d6-dangling-spike-cwd"; // resolves to /private/tmp/... → -private-tmp-...
if (!SESSION) { console.error("usage: ... <sessionId>"); process.exit(2); }

// Find the transcript by globbing the projects dir (robust to cwd encoding).
const PROOT = join(homedir(), ".claude", "projects");
let file = null;
for (const d of readdirSync(PROOT)) {
	const f = join(PROOT, d, `${SESSION}.jsonl`);
	if (existsSync(f)) { file = f; break; }
}
if (!file) { console.error("transcript not found for session " + SESSION); process.exit(2); }
console.log("transcript:", file);

// Back up, then craft the dangling state: drop trailing tool_result record(s).
copyFileSync(file, file + ".bak");
let lines = readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
const isToolResultLine = (l) => { try { const r = JSON.parse(l); const m = r.message ?? r; const c = Array.isArray(m?.content) ? m.content : []; return c.some((b) => b.type === "tool_result"); } catch { return false; } };
while (lines.length && isToolResultLine(lines[lines.length - 1])) lines.pop();
writeFileSync(file, lines.join("\n") + "\n");

// Confirm it now ends with an unclosed tool_use.
const recs = lines.map((l) => JSON.parse(l));
let lastTU = null, hasRes = false;
for (const r of recs) { const m = r.message ?? r; for (const b of (Array.isArray(m?.content) ? m.content : [])) { if (b.type === "tool_use") { lastTU = b.id; hasRes = false; } if (b.type === "tool_result" && b.tool_use_id === lastTU) hasRes = true; } }
const dangling = !!lastTU && !hasRes;
console.log(`crafted transcript: records=${lines.length} dangling=${dangling} lastToolUse=${lastTU?.slice(0, 12)}`);
if (!dangling) { console.error("FAILED to craft a dangling transcript"); process.exit(2); }

// Resume through claude-p + suppressResumeReplay.
const TOOL = { name: "mcp__custom-tools__work", description: "A work tool.", inputSchema: { type: "object", properties: {}, required: [] } };
const NEWPROMPT = "Do NOT call any tool. Reply with exactly the token SPIKE_RESUME_OK and nothing else.";
const router = createRouter({ onPark: (info) => { console.log("[resume] (unexpected) tool call → delivering"); router.deliver(info.piId, { content: [{ type: "text", text: "DONE" }] }); } });
router.declareTools([TOOL]);
await router.start();
const readyFile = `${router.socketPath}.ready`;
const toolsB64 = Buffer.from(JSON.stringify([TOOL]), "utf-8").toString("base64");
const mcpConfig = JSON.stringify({ mcpServers: { "custom-tools": { command: process.execPath, args: [SHIM, "--socket", router.socketPath, "--mode", "main", "--tools", toolsB64, "--ready-file", readyFile] } } });
const cfg = { model: MODEL, systemPrompt: { kind: "text", text: "You are a tool-calling test agent." }, prompt: { kind: "positional", text: NEWPROMPT }, mcpConfig, session: { kind: "resume", sessionId: SESSION }, timeoutSeconds: 90, mcpReadyFile: readyFile };
const args = buildClaudePArgs(cfg);

let sawResult = false, answer = "", raw = "", diag = null;
const parser = new ClaudePStreamParser({ logger: { warn() {} }, suppressResumeReplay: true, livePromptText: NEWPROMPT,
	onEvent: (e) => { if (e.kind === "done" && e.reason === "result") sawResult = true; if (typeof e.text === "string") answer += e.text; },
	onResumeDiag: (d) => { diag = d; } });
console.log("[resume] spawning claude-p --resume " + SESSION.slice(0, 8) + " (suppressResumeReplay=true)");
const child = spawn(CLAUDE_P_BIN, [...args, "--debug"], { cwd: WORK, detached: true, stdio: ["ignore", "pipe", "pipe"] });
let err = "";
child.stdout.setEncoding("utf8"); child.stdout.on("data", (c) => { raw += c; parser.write(c); });
child.stderr.setEncoding("utf8"); child.stderr.on("data", (c) => (err += c));
const exit = await new Promise((res) => { child.on("close", (code, signal) => res({ code, signal })); child.on("error", (e) => res({ code: null, signal: null })); });
parser.endOfStream({ aborted: false, exitInfo: { code: exit.code, signal: exit.signal } });
await router.stop().catch(() => {});

const answered = /SPIKE_RESUME_OK/.test(answer) || /SPIKE_RESUME_OK/.test(raw);
const danglingError = /tool_use ids were found without `tool_result`|unclosed|no conversation found/i.test(err) || /tool_use.*tool_result/i.test(raw);
const pass = exit.code === 0 && sawResult && answered;
console.log("\n=== RESUME-OF-DANGLING RESULT ===");
console.log({ exit, sawResult, answered, danglingErrorSeen: danglingError });
console.log("resumeDiag:", JSON.stringify(diag));
console.log("answer(tail):", JSON.stringify(answer.slice(-160)));
console.log("stderr(tail):", JSON.stringify(err.slice(-500)));
console.log(`\nVERDICT: ${pass ? "PASS — claude-p cleanly resumed a DANGLING tool_use (R7 HOLDS)" : "FAIL — R7 INVERTS (dangling must become a cold trigger)"}`);
// restore the backup so we don't leave a mutated transcript
copyFileSync(file + ".bak", file);
process.exit(pass ? 0 : 1);
