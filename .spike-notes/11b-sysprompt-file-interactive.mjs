// T0.11 follow-up: verify --system-prompt-file works in INTERACTIVE mode.

import * as pty from "node-pty";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { TrustDialogScanner } from "../src/driver/pty.js";

const cwd = realpathSync(mkdtempSync(join(tmpdir(), "spike-t11b-")));
const uuid = randomUUID();
const tp = join(homedir(), ".claude", "projects", cwd.replaceAll("/", "-"), uuid + ".jsonl");

const SENTINEL = "OBELISK_FROM_FILE_99";
const promptFile = join(cwd, "sp.txt");
writeFileSync(promptFile, `You are SentinelBot. Reply with exactly the literal string: ${SENTINEL}. Nothing else.`);

const hookLog = join(cwd, "hook.log");
writeFileSync(join(cwd, "hook.mjs"), `process.stdout.write("{}");`);
const settings = JSON.stringify({
	hooks: {
		SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: `node "${join(cwd, "hook.mjs")}"` }] }],
		Stop: [{ matcher: "*", hooks: [{ type: "command", command: `node "${join(cwd, "hook.mjs")}"` }] }],
	},
});

const proc = pty.spawn("/Users/cartwmic/.local/bin/claude", [
	"--session-id", uuid,
	"--system-prompt-file", promptFile,
	"--strict-mcp-config",
	"--setting-sources", "",
	"--dangerously-skip-permissions",
	"--settings", settings,
	"hello",
], { name: "xterm-256color", cols: 100, rows: 30, cwd, env: process.env });

const sc = new TrustDialogScanner({ onAnswer: (d) => proc.write(d), onFailure: console.log, dialogTimeoutMs: 8000, hardTimeoutMs: 25000 });
sc.start();
let exited = null;
proc.onData((d) => sc.feed(d));
proc.onExit((e) => (exited = e));

const t0 = Date.now();
while (!exited && Date.now() - t0 < 25000) {
	await new Promise((r) => setTimeout(r, 500));
	if (existsSync(tp)) {
		sc.notifyTranscriptCreated();
		const lines = readFileSync(tp, "utf8").split("\n").filter((l) => l.trim());
		const a = lines.find((l) => { try { return JSON.parse(l).type === "assistant"; } catch { return false; } });
		if (a) break;
	}
}

let txt = "";
if (existsSync(tp)) {
	const lines = readFileSync(tp, "utf8").split("\n").filter((l) => l.trim());
	for (const ln of lines) {
		try {
			const e = JSON.parse(ln);
			if (e.type === "assistant") {
				txt = (e.message.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
			}
		} catch {}
	}
}

proc.kill("SIGINT");
await new Promise((r) => setTimeout(r, 1500));

console.log("interactive --system-prompt-file response:", JSON.stringify(txt));
console.log("contains sentinel:", txt.includes(SENTINEL));
console.log(txt.includes(SENTINEL) ? "PASS" : "FAIL");
