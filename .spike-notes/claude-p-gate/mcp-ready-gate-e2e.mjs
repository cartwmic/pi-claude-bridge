#!/usr/bin/env node
// End-to-end proof of the MCP-readiness gate against the REAL shim + claude-p +
// claude. Mirrors int-claude-p-multiround's harness but WIRES the readiness
// sentinel exactly as index.ts streamSimple now does:
//   - mcp-config shim args get  --ready-file <socket>.ready
//   - claude-p argv gets        --mcp-ready-file <socket>.ready  (via cfg.mcpReadyFile)
// Pass = a tool routed (so claude-p released the held Enter), the sentinel was
// created by the real shim, and the gate trace shows hold→release.
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createRouter } from "../../src/mcp/router.js";
import { buildClaudePArgs } from "../../src/driver/claudeP.js";
import { ClaudePStreamParser } from "../../src/driver/stream.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..", "..");
const SHIM = join(REPO, "dist", "src", "mcp", "shim.js");
const CLAUDE_P_BIN = join(REPO, "node_modules", ".bin", "claude-p");
const MODEL = process.env.MODEL ?? "claude-haiku-4-5";

const TOOL = {
	name: "mcp__custom-tools__ping",
	description: "A ping tool. Call it once with {} and then report its result text verbatim.",
	inputSchema: { type: "object", properties: {}, required: [] },
};
const PROMPT =
	"You have one tool: mcp__custom-tools__ping. Call it once with no arguments. " +
	"When it returns, report its result text verbatim and stop.";

let routed = 0;
const router = createRouter({
	onPark: (info) => {
		routed++;
		console.log(`[harness] TOOL ROUTED: name=${info.name} piId=${info.piId} → gate released`);
		router.deliver(info.piId, { content: [{ type: "text", text: "PONG_OK" }] });
	},
});
router.declareTools([TOOL]);
await router.start();

const readyFile = `${router.socketPath}.ready`;
rmSync(readyFile, { force: true });

const toolsB64 = Buffer.from(JSON.stringify([TOOL]), "utf-8").toString("base64");
const mcpConfig = JSON.stringify({
	mcpServers: {
		"custom-tools": {
			command: process.execPath,
			args: [SHIM, "--socket", router.socketPath, "--mode", "main", "--tools", toolsB64, "--ready-file", readyFile],
		},
	},
});

const cfg = {
	model: MODEL,
	systemPrompt: { kind: "text", text: "You are a tool-calling test agent. Follow instructions precisely." },
	prompt: { kind: "positional", text: PROMPT },
	mcpConfig,
	session: { kind: "fresh", sessionId: randomUUID() },
	timeoutSeconds: 120,
	mcpReadyFile: readyFile,
};
const args = buildClaudePArgs(cfg);
assert.ok(args.includes("--mcp-ready-file"), "buildClaudePArgs must emit --mcp-ready-file");

let sawResult = false;
let sentinelSeenDuringRun = false;
const parser = new ClaudePStreamParser({
	logger: { warn() {} },
	onEvent: (e) => {
		if (e.kind === "done" && e.reason === "result") sawResult = true;
	},
});

console.log(`[harness] spawning real claude-p (model=${MODEL}); ready-file=${readyFile}`);
const child = spawn(CLAUDE_P_BIN, [...args, "--debug"], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
child.stdout.setEncoding("utf8");
child.stdout.on("data", (c) => parser.write(c));
const stderr = [];
child.stderr.setEncoding("utf8");
child.stderr.on("data", (c) => {
	stderr.push(c);
	if (!sentinelSeenDuringRun && existsSync(readyFile)) sentinelSeenDuringRun = true;
});

const exit = await new Promise((res) => {
	child.on("close", (code, signal) => res({ code, signal }));
	child.on("error", (err) => res({ code: null, signal: null, err }));
});
parser.endOfStream({ aborted: false, exitInfo: { code: exit.code, signal: exit.signal } });
await router.stop().catch(() => {});

const trace = stderr.join("");
const held = /holding Enter for MCP readiness/.test(trace);
const released = /MCP surface ready; Enter sent/.test(trace);
const gateLines = trace.split("\n").filter((l) => /holding Enter|MCP surface ready|McpNotReady|Stop hook|typing prompt/.test(l));

console.log("\n=== GATE TRACE ===");
for (const l of gateLines) console.log(l);
console.log("\n=== RESULT ===");
console.log({ exit, routed, sawResult, held, released, sentinelSeenDuringRun });

rmSync(readyFile, { force: true });

assert.ok(held, "gate must HOLD the Enter (trace: 'holding Enter for MCP readiness')");
assert.ok(released, "gate must RELEASE (trace: 'MCP surface ready; Enter sent')");
assert.equal(routed, 1, "exactly one tool call must route (proves the real shim raised the sentinel and claude-p submitted)");
assert.ok(sawResult, "turn must complete with a terminal result line");
console.log("\n✅ PASS — full gate integration: real shim raised the sentinel, real claude-p held then released, tool routed, turn completed.");
process.exit(0);
