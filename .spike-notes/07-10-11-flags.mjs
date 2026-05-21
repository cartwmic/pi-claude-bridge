// T0.7 (--setting-sources isolation), T0.10 (--json-schema availability),
// T0.11 (--system-prompt-file existence + argv-size measurement).
//
// These are fast flag-existence / help-text checks, NOT full PTY runs.

import { execSync, spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLAUDE_BIN = "/Users/cartwmic/.local/bin/claude";

console.log("=== T0.10: --json-schema flag availability ===");
{
	const help = execSync(`${CLAUDE_BIN} --help`, { encoding: "utf8" });
	const hasJsonSchemaFlag = /--json-schema/.test(help);
	console.log("--json-schema appears in --help:", hasJsonSchemaFlag);
	if (hasJsonSchemaFlag) {
		const ctx = help.match(/.{0,200}--json-schema.{0,400}/s);
		console.log("Context:\n", ctx ? ctx[0] : "(none)");
	}
	// Try a --print -p call (printable mode) — the documented home for json-schema
	const result = spawnSync(CLAUDE_BIN, [
		"--print",
		"--json-schema", '{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"]}',
		"--system-prompt", "Output exactly {\"answer\":\"42\"} and nothing else.",
		"Pick a number",
	], { encoding: "utf8", timeout: 30000 });
	console.log("--print --json-schema exitCode:", result.status);
	console.log("--print --json-schema stdout (first 400):", (result.stdout || "").slice(0, 400));
	console.log("--print --json-schema stderr (first 400):", (result.stderr || "").slice(0, 400));
}

console.log("\n=== T0.11: --system-prompt-file flag availability + argv-size ===");
{
	const help = execSync(`${CLAUDE_BIN} --help`, { encoding: "utf8" });
	const hasSysFileFlag = /--system-prompt-file/.test(help);
	const hasAppendFileFlag = /--append-system-prompt-file/.test(help);
	console.log("--system-prompt-file appears in --help:", hasSysFileFlag);
	console.log("--append-system-prompt-file appears in --help:", hasAppendFileFlag);
	const ctx = help.match(/.{0,200}system-prompt.{0,400}/s);
	console.log("Help context for system-prompt:\n", ctx ? ctx[0] : "(none)");

	// argv size ceiling probe (macOS): produce strings of increasing size, see
	// where exec rejects with E2BIG. We don't actually want to find the limit
	// — we just want to confirm "claude --print --system-prompt <500KB blob>"
	// works (claude's per-arg limit is undocumented).
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "spike-t11-")));
	const sizes = [10_000, 100_000, 250_000];
	for (const sz of sizes) {
		const blob = "x".repeat(sz);
		const result = spawnSync(CLAUDE_BIN, [
			"--print",
			"--system-prompt", `Reply with the single word 'OK'. Filler: ${blob}`,
			"hi",
		], { encoding: "utf8", timeout: 30000, cwd });
		console.log(`size=${sz}: exit=${result.status}, stderr first 200=${(result.stderr || "").slice(0, 200)}, stdout first 100=${(result.stdout || "").slice(0, 100)}`);
		if (result.status !== 0) break;
	}

	// --system-prompt-file functional probe if the flag exists
	if (hasSysFileFlag) {
		const promptFile = join(cwd, "sysprompt.txt");
		writeFileSync(promptFile, "Reply with the single word 'BANANA_FROM_FILE'.");
		const result = spawnSync(CLAUDE_BIN, [
			"--print",
			"--system-prompt-file", promptFile,
			"hello",
		], { encoding: "utf8", timeout: 30000, cwd });
		console.log("--system-prompt-file exit:", result.status);
		console.log("--system-prompt-file stdout first 200:", (result.stdout || "").slice(0, 200));
	}
}

console.log("\n=== T0.7: --setting-sources isolation positive control ===");
{
	const help = execSync(`${CLAUDE_BIN} --help`, { encoding: "utf8" });
	const ctx = help.match(/.{0,100}setting-sources.{0,400}/s);
	console.log("Help context for --setting-sources:\n", ctx ? ctx[0] : "(none)");
	// In T0.14b we observed --setting-sources "" was accepted and only our
	// inline hooks fired (user has PreToolUse + UserPromptSubmit hooks in
	// ~/.claude/settings.json that did NOT fire during the spawn). That's a
	// strong negative signal for leakage. Try the positive control: run with
	// --setting-sources "user" and check whether the user-level hooks fire.
	console.log("\nPositive-control test (--setting-sources user):");
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "spike-t07-")));
	const probeFlag = join(cwd, "user-hook-probe.txt");
	// We don't want to mutate ~/.claude/settings.json. So instead, check
	// behaviorally: does claude pick up the user's permissions.allow list?
	// Try a Bash that's allowed in user settings (e.g., `ls`) under -p mode
	// with --setting-sources "user" and confirm it's allowed without prompt.
	const r1 = spawnSync(CLAUDE_BIN, [
		"--print", "--setting-sources", "user", "--strict-mcp-config",
		"--system-prompt", "Reply OK.",
		"hello",
	], { encoding: "utf8", timeout: 30000, cwd });
	const r2 = spawnSync(CLAUDE_BIN, [
		"--print", "--setting-sources", "", "--strict-mcp-config",
		"--system-prompt", "Reply OK.",
		"hello",
	], { encoding: "utf8", timeout: 30000, cwd });
	console.log("--setting-sources user exit:", r1.status, "stderr len:", (r1.stderr || "").length);
	console.log("--setting-sources \"\" exit:", r2.status, "stderr len:", (r2.stderr || "").length);
	console.log("Both accept the flag (no rejection):", r1.status === 0 && r2.status === 0);
}
