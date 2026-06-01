#!/usr/bin/env node
// G7 — does claude-p's `--timeout` count WALL-TIME while an MCP tool call is held
// open? If it does, a long pi tool (S3 45s, S8 120s) would trip exit 124 mid-hold.
//
// Mechanism: ONE claude-p spawn with a single bridged tool whose router `onPark`
// DELAYS `router.deliver` by HOLD_MS (~40s, simulating a slow pi tool). We run it
// TWICE, STRICTLY SEQUENTIALLY (never two claude-p alive at once):
//   (1) SHORT timeout (25s) < hold (40s): does claude-p exit 124 mid-hold, or wait?
//   (2) control: LONG timeout (180s) >> hold (40s): confirm it completes.
//
// Real modules: createRouter + built shim + buildClaudePArgs + ClaudePStreamParser.
// model claude-haiku-4-5. Bare tool name `slow` (F1: claude namespaces it).
//
// Run: node --import tsx .spike-notes/claude-p-gate/g7-timeout-probe.mjs

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
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
const NOTES_DIR = join(REPO, ".spike-notes", "claude-p-gate");
const RESULTS_MD = join(NOTES_DIR, "g7-timeout-results.md");
const STREAM_OUT = join(NOTES_DIR, "g7-timeout-stream.jsonl");

const MODEL = "claude-haiku-4-5";
const HOLD_MS = 40_000; // simulated slow pi tool
const MAX_ATTEMPTS = 3;
const nowIso = () => new Date().toISOString();

const SLOW = {
	name: "slow",
	description: "A slow tool. Pass { go: true }. It takes a while, then returns a sentinel. Call it once, then report its result text verbatim.",
	inputSchema: { type: "object", properties: { go: { type: "boolean" } }, required: ["go"] },
};
const SENTINEL = "SLOW_TOOL_DONE_G7";
const PROMPT =
	"You have one tool: slow (takes { go: boolean }). Call slow with go=true exactly once. " +
	"It may take a while to return — wait for it. When it returns, report its result text verbatim.";

function runOnce({ timeoutSeconds, attempt, log }) {
	let holdTimer;
	const router = createRouter({
		logger: { debug() {}, info() {}, warn() {}, error() {} },
		onPark: (info) => {
			const parkedAt = Date.now();
			router.__hold = { piId: info.piId, parkedAt, resolvedAt: null };
			log.push(`[t=${timeoutSeconds}s a${attempt}] PARK ${nowIso()} piId=${info.piId} — holding ${HOLD_MS}ms before deliver`);
			holdTimer = setTimeout(() => {
				router.__hold.resolvedAt = Date.now();
				log.push(`[t=${timeoutSeconds}s a${attempt}] DELIVER ${nowIso()} piId=${info.piId} after ${Date.now() - parkedAt}ms`);
				router.deliver(info.piId, { content: [{ type: "text", text: `slow done — ${SENTINEL}` }] });
			}, HOLD_MS);
		},
	});
	router.__hold = null;
	router.declareTools([SLOW]);

	const toolsB64 = Buffer.from(JSON.stringify([SLOW]), "utf-8").toString("base64");
	const mcpConfig = JSON.stringify({
		mcpServers: { "custom-tools": { command: process.execPath, args: [SHIM, "--socket", router.socketPath, "--mode", "main", "--tools", toolsB64] } },
	});

	return router.start().then(async () => {
		const cfg = {
			model: MODEL,
			systemPrompt: { kind: "text", text: "You are a tool-calling test agent. Follow the user's instructions precisely." },
			prompt: { kind: "positional", text: PROMPT },
			mcpConfig,
			session: { kind: "fresh", sessionId: randomUUID() },
			timeoutSeconds,
		};
		const args = buildClaudePArgs(cfg);

		const rawChunks = [];
		let sawResult = false;
		const parser = new ClaudePStreamParser({ logger: { warn() {} }, onEvent: (e) => { if (e.kind === "done" && e.reason === "result") sawResult = true; } });

		const env = { ...process.env };
		delete env.CLAUDE_CONFIG_DIR;

		const start = Date.now();
		const child = spawn(CLAUDE_P_BIN, args, { detached: true, stdio: ["ignore", "pipe", "pipe"], env });
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (c) => { rawChunks.push(c); parser.write(c); });
		const stderrChunks = [];
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (c) => stderrChunks.push(c));

		const exit = await new Promise((res) => {
			child.on("close", (code, signal) => res({ code, signal }));
			child.on("error", (err) => res({ code: null, signal: null, err }));
		});
		const wallMs = Date.now() - start;
		parser.endOfStream({ aborted: false, exitInfo: { code: exit.code, signal: exit.signal } });
		if (holdTimer) clearTimeout(holdTimer);
		const hold = router.__hold;
		await router.stop().catch(() => {});

		const exitDuringHold = hold && hold.resolvedAt === null; // exited before we delivered
		log.push(`[t=${timeoutSeconds}s a${attempt}] EXIT code=${exit.code} signal=${exit.signal} wall=${wallMs}ms sawResult=${sawResult} exitDuringHold=${!!exitDuringHold} deliverFired=${!!(hold && hold.resolvedAt)}`);
		if (stderrChunks.length) log.push(`[t=${timeoutSeconds}s a${attempt}] STDERR ${stderrChunks.join("").replace(/\n/g, " ").slice(0, 400)}`);
		return { timeoutSeconds, exitCode: exit.code, signal: exit.signal, wallMs, sawResult, exitDuringHold, deliverFired: !!(hold && hold.resolvedAt), parked: !!hold, raw: rawChunks.join(""), sawSentinel: rawChunks.join("").includes(SENTINEL) };
	});
}

// Retry only on a flake (no park at all / SessionStart/Stop timeout with no parked
// call). A clean exit-124-mid-hold or a clean completion is a RESULT, not a flake.
function isFlake(r) {
	return !r.parked && !r.sawResult; // never even got the tool call routed → boot flake
}

async function runScenario({ timeoutSeconds, label, log }) {
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		log.push(`===== ${label} (timeout=${timeoutSeconds}s, hold=${HOLD_MS}ms) ATTEMPT ${attempt} START ${nowIso()} =====`);
		const r = await runOnce({ timeoutSeconds, attempt, log });
		if (!isFlake(r)) return { ...r, attempts: attempt };
		log.push(`[${label} a${attempt}] FLAKE (no tool call routed) — retrying`);
	}
	return { timeoutSeconds, flake: true, attempts: MAX_ATTEMPTS };
}

(async () => {
	mkdirSync(NOTES_DIR, { recursive: true });
	if (!existsSync(SHIM)) throw new Error(`built shim missing at ${SHIM} — run npm run build`);
	if (!existsSync(CLAUDE_P_BIN)) throw new Error(`claude-p binary missing at ${CLAUDE_P_BIN}`);

	const log = [];

	// (1) SHORT timeout < hold — the load-bearing probe.
	const short = await runScenario({ timeoutSeconds: 25, label: "SHORT", log });
	// (2) Control: LONG timeout >> hold.
	const long = await runScenario({ timeoutSeconds: 180, label: "CONTROL-LONG", log });

	// Persist the winning (long) stream for evidence.
	if (long.raw) writeFileSync(STREAM_OUT, long.raw, "utf8");

	// ── Conclude ──────────────────────────────────────────────────────────────
	// Interpretation:
	//  - If SHORT exits ~25s with NO result and exitDuringHold=true → --timeout
	//    DOES count held-call wall-time → exit 124 trips mid-hold → generous
	//    constant is INSUFFICIENT; need AbortSignal-driven cancellation OR a
	//    --timeout derived per-turn larger than the longest pi tool.
	//  - If SHORT waits past 25s and completes (sawResult, sentinel) → --timeout
	//    does NOT count held-call time → generous constant is SUFFICIENT.
	const timeoutCountsHeldTime =
		!short.flake && short.exitDuringHold && !short.sawResult && short.wallMs < HOLD_MS + 5000;
	const shortCompletedDespiteHold = !short.flake && short.sawResult && short.sawSentinel;

	const lines = [];
	lines.push(`# G7 — \`--timeout\` semantics vs a held MCP call`);
	lines.push("");
	lines.push(`**Date:** ${nowIso()} · claude-p 0.1.0 · claude 2.1.159 · model ${MODEL}`);
	lines.push(`**Method:** ONE bridged tool \`slow\`; router \`onPark\` delays \`deliver\` by HOLD_MS=${HOLD_MS}ms (simulated slow pi tool). Two sequential spawns.`);
	lines.push("");
	lines.push(`## Results`);
	lines.push("");
	lines.push("| scenario | --timeout | hold | wall | exitCode | signal | sawResult | sentinel | exitDuringHold | attempts |");
	lines.push("|---|---|---|---|---|---|---|---|---|---|");
	const row = (label, r) => `| ${label} | ${r.timeoutSeconds}s | ${HOLD_MS / 1000}s | ${r.flake ? "—" : (r.wallMs / 1000).toFixed(1) + "s"} | ${r.exitCode ?? "—"} | ${r.signal ?? "—"} | ${r.sawResult ?? "—"} | ${r.sawSentinel ?? "—"} | ${r.exitDuringHold ?? "—"} | ${r.attempts} |`;
	lines.push(row("SHORT (25s < 40s)", short));
	lines.push(row("CONTROL-LONG (180s)", long));
	lines.push("");
	lines.push(`## Verdict`);
	lines.push("");
	if (short.flake) {
		lines.push(`**INCONCLUSIVE (SHORT):** the SHORT scenario flaked (no tool call routed in ${MAX_ATTEMPTS} attempts).`);
	} else if (timeoutCountsHeldTime) {
		lines.push(`**\`--timeout\` DOES count held-call wall-time.** The SHORT spawn exited at ~${(short.wallMs / 1000).toFixed(1)}s (timeout 25s) WHILE the tool was held (exitDuringHold=true, no result, exit ${short.exitCode}/${short.signal}). A held pi tool longer than \`--timeout\` trips a timeout-kill mid-hold.`);
	} else if (shortCompletedDespiteHold) {
		lines.push(`**\`--timeout\` does NOT count held-call wall-time.** The SHORT spawn (timeout 25s) WAITED through the ${HOLD_MS / 1000}s hold and completed cleanly (sawResult, sentinel echoed) at ~${(short.wallMs / 1000).toFixed(1)}s.`);
	} else {
		lines.push(`**AMBIGUOUS:** SHORT did not cleanly match either pattern — exit ${short.exitCode}/${short.signal} wall ${(short.wallMs / 1000).toFixed(1)}s sawResult=${short.sawResult} exitDuringHold=${short.exitDuringHold}. See log.`);
	}
	lines.push("");
	lines.push(`## Implication for \`deriveTimeout\` (index.ts \`CLAUDE_P_TIMEOUT_SECONDS\` = 600s constant)`);
	lines.push("");
	if (timeoutCountsHeldTime) {
		lines.push(`- \`--timeout\` is a HARD wall-clock kill that includes held-tool time. The 600s constant is SUFFICIENT **only if** no pi tool round (incl. user think-time on interactive tools) ever exceeds 600s wall. S3 (45s) and S8 (120s) are well under 600s, so the constant survives those — BUT a long-running held tool or a slow chain of held rounds approaching 600s would trip exit 124 mid-turn.`);
		lines.push(`- SAFER: drive cancellation via pi's AbortSignal (already wired into spawnClaudeP, design D31) rather than relying on claude-p's wall-timer, AND keep \`--timeout\` generous (600s) purely as a backstop. The AbortSignal path lets pi cancel precisely; the wall-timer must never be the primary cancellation mechanism for held tools.`);
	} else if (shortCompletedDespiteHold) {
		lines.push(`- \`--timeout\` does NOT count held-call time, so a generous constant (600s) is SUFFICIENT: held pi tools of any duration up to the model/agent-loop budget will not trip exit 124 purely from being held. AbortSignal remains the precise per-turn cancellation path (D31); the wall-timer is a safe backstop.`);
	} else {
		lines.push(`- Result ambiguous; re-run before concluding. Until then, treat AbortSignal (D31) as the authoritative cancellation and keep \`--timeout\` generous as a backstop.`);
	}
	lines.push("");
	lines.push(`## Raw run log`);
	lines.push("```");
	lines.push(...log);
	lines.push("```");
	writeFileSync(RESULTS_MD, lines.join("\n") + "\n", "utf8");

	console.log(`SHORT: flake=${!!short.flake} wall=${short.wallMs}ms exit=${short.exitCode}/${short.signal} sawResult=${short.sawResult} exitDuringHold=${short.exitDuringHold}`);
	console.log(`LONG : flake=${!!long.flake} wall=${long.wallMs}ms exit=${long.exitCode}/${long.signal} sawResult=${long.sawResult} sentinel=${long.sawSentinel}`);
	console.log(`timeoutCountsHeldTime=${timeoutCountsHeldTime} shortCompletedDespiteHold=${shortCompletedDespiteHold}`);
	console.log(`Results -> ${RESULTS_MD}`);
})();
