// T0.2: confirm CC TUI emits thinking blocks in transcript JSONL when extended
// reasoning is enabled. Use --effort xhigh + a question that benefits from
// reasoning.

import * as pty from "node-pty";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { TrustDialogScanner } from "../src/driver/pty.js";

const cwd = realpathSync(mkdtempSync(join(tmpdir(), "spike-t02-")));
const uuid = randomUUID();
const tp = join(homedir(), ".claude", "projects", cwd.replaceAll("/", "-"), uuid + ".jsonl");

writeFileSync(join(cwd, "hook.mjs"), `process.stdout.write("{}");`);
const settings = JSON.stringify({
	hooks: {
		SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: `node "${join(cwd, "hook.mjs")}"` }] }],
		Stop: [{ matcher: "*", hooks: [{ type: "command", command: `node "${join(cwd, "hook.mjs")}"` }] }],
	},
});

const proc = pty.spawn("/Users/cartwmic/.local/bin/claude", [
	"--session-id", uuid,
	"--effort", "high",
	"--system-prompt", "Think carefully before answering.",
	"--strict-mcp-config",
	"--setting-sources", "",
	"--dangerously-skip-permissions",
	"--settings", settings,
	"Find a four-digit number whose digits are all different and which is equal to the cube of the sum of its digits. Show your reasoning.",
], { name: "xterm-256color", cols: 100, rows: 30, cwd, env: process.env });

const sc = new TrustDialogScanner({ onAnswer: (d) => proc.write(d), onFailure: console.log, dialogTimeoutMs: 8000, hardTimeoutMs: 90000 });
sc.start();
let exited = null;
proc.onData((d) => sc.feed(d));
proc.onExit((e) => (exited = e));

const t0 = Date.now();
while (!exited && Date.now() - t0 < 60000) {
	await new Promise((r) => setTimeout(r, 1000));
	if (existsSync(tp)) {
		sc.notifyTranscriptCreated();
		const lines = readFileSync(tp, "utf8").split("\n").filter((l) => l.trim());
		const a = lines.find((l) => { try { return JSON.parse(l).type === "assistant"; } catch { return false; } });
		if (a) break;
	}
}

const lines = existsSync(tp) ? readFileSync(tp, "utf8").split("\n").filter((l) => l.trim()) : [];
const blockTypes = new Set();
let thinkingCount = 0;
let textCount = 0;
for (const ln of lines) {
	try {
		const e = JSON.parse(ln);
		if (e.type === "assistant") {
			for (const b of (e.message?.content || [])) {
				blockTypes.add(b.type);
				if (b.type === "thinking" || b.type === "redacted_thinking") thinkingCount++;
				if (b.type === "text") textCount++;
			}
		}
	} catch {}
}
console.log("assistant block types observed:", [...blockTypes]);
console.log("thinking block count:", thinkingCount);
console.log("text block count:", textCount);

proc.kill("SIGINT");
await new Promise((r) => setTimeout(r, 1500));

console.log(thinkingCount > 0 ? "T0.2 PASS" : "T0.2 NOT OBSERVED (model didn't emit thinking even with --effort high)");
