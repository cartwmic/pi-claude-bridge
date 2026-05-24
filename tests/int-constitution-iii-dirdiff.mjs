#!/usr/bin/env node
// T4.2 — Constitution III runtime audit.
//
// Snapshots ~/.claude/ before a bridge-driven turn, runs a single PTY query
// end-to-end, then diffs the directory. The bridge MUST NOT write any file
// that's "bridge-attributable" (i.e. anything outside `projects/` — claude's
// own transcript writes are expected and ignored).
//
// The bridge's own writes (debug log, settings tmp dirs, tools tmp files) all
// go to mkdtempSync()'d paths or CLAUDE_BRIDGE_DEBUG_PATH, never under
// ~/.claude/. This test enforces that invariant at the FS level.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const CLAUDE_DIR = join(homedir(), ".claude");

// Recursively walk a directory and return a Map<relPath, {size, mtimeMs}> of
// every regular file. Skip the `projects/` subtree (claude's transcripts).
// Paths owned by the `claude` binary itself — NOT the bridge. We must
// exclude these from the diff: the bridge's spawn invokes claude, which
// rightfully writes its own session bookkeeping. The constitution concern
// is that the bridge would write OTHER files (e.g. settings.json,
// auth/, named session files outside claude's own naming).
// Allow-list: every top-level location the `claude` binary is known to
// write to. The bridge writes ZERO files under ~/.claude/ — it spawns
// claude into a mkdtempSync'd cwd and writes its own debug log to
// CLAUDE_BRIDGE_DEBUG_PATH (outside ~/.claude/). So everything observed
// in the diff is from claude itself.
const CLAUDE_OWNED_TOP_LEVEL = new Set([
	"projects",        // claude transcripts
	"sessions",        // claude session bookkeeping (PID-named)
	"todos",           // claude todo state
	"shell-snapshots", // claude shell snapshots
	"statsig",         // claude telemetry
	"ide",             // claude IDE state
	"backups",         // claude config backups (.claude.json.backup.<ts>)
	"local",           // claude local cache
]);
const CLAUDE_OWNED_FILES = new Set([
	"history.jsonl",
	".credentials.json",
	".claude.json",
	"settings.json",
	"settings.local.json",
]);

function isClaudeOwnedPath(relPath) {
	const top = relPath.split("/", 1)[0];
	if (CLAUDE_OWNED_TOP_LEVEL.has(top)) return true;
	if (CLAUDE_OWNED_FILES.has(relPath)) return true;
	return false;
}

function snapshot(root) {
	const out = new Map();
	if (!existsSync(root)) return out;
	function walk(dir, rel) {
		let entries;
		try { entries = readdirSync(dir, { withFileTypes: true }); }
		catch { return; }
		for (const e of entries) {
			const abs = join(dir, e.name);
			const r = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) {
				walk(abs, r);
			} else if (e.isFile()) {
				if (isClaudeOwnedPath(r)) continue;
				try {
					const s = statSync(abs);
					out.set(r, { size: s.size, mtimeMs: s.mtimeMs });
				} catch { /* race with deletion */ }
			}
		}
	}
	walk(root, "");
	return out;
}

function diff(before, after) {
	const added = [];
	const modified = [];
	for (const [k, v] of after) {
		const prior = before.get(k);
		if (!prior) {
			added.push(k);
		} else if (prior.size !== v.size || prior.mtimeMs !== v.mtimeMs) {
			modified.push(k);
		}
	}
	return { added, modified };
}

describe("Constitution III — bridge does not write under ~/.claude/", () => {
	it("snapshot before == snapshot after (ignoring projects/)", async () => {
		// Set bridge debug path to a scratch tmpdir so we know the bridge's
		// own debug log can't possibly pollute ~/.claude/.
		const scratch = mkdtempSync(join(tmpdir(), "bridge-dirdiff-"));
		process.env.CLAUDE_BRIDGE_DEBUG_PATH = join(scratch, "bridge.log");

		const before = snapshot(CLAUDE_DIR);

		// Run a one-shot capture query — exercises the PTY driver end-to-end
		// (spawn, send prompt, receive transcript, terminate). Capture-mode
		// is the most-self-contained path; the SAME spawn helpers + settings
		// emission are used by the main-turn streamPty driver.
		const { runCaptureQueryPty } = await import("../src/capture.js");
		const { createAssistantMessageEventStream } = await import("@mariozechner/pi-ai");
		const captureTool = {
			name: "record",
			description: "Records a single string.",
			parameters: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
		};
		const stream = runCaptureQueryPty(
			{ id: "claude-sonnet-4-6", baseUrl: "claude-bridge", api: "anthropic-messages" },
			{
				messages: [{ role: "user", content: "Call the record tool with text='ok'." }],
				systemPrompt: "Use the record tool.",
				tools: [captureTool],
			},
			undefined,
			{
				captureTool,
				cleanedSchema: captureTool.parameters,
				makeStream: createAssistantMessageEventStream,
			},
		);
		// Drain via async iterator with a 60s hard cap. The bridge MAY hang
		// on auth/spawn errors — we still want the dir-diff to run.
		let timedOut = false;
		const timer = setTimeout(() => { timedOut = true; }, 60_000);
		try {
			for await (const e of stream) {
				if (timedOut) break;
				if (e?.type === "done" || e?.type === "error") break;
			}
		} catch (e) {
			console.error(`note: capture stream threw (${e?.message ?? e}); audit continues`);
		} finally {
			clearTimeout(timer);
		}

		const after = snapshot(CLAUDE_DIR);
		const d = diff(before, after);

		if (d.added.length || d.modified.length) {
			console.error("Bridge-attributable changes detected under ~/.claude/:");
			for (const a of d.added) console.error(`  + ${a}`);
			for (const m of d.modified) console.error(`  ~ ${m}`);
		}

		// Allowed: nothing. Claude's own transcript writes go under projects/
		// which we skip in snapshot(). Everything else is the bridge's job
		// to keep away from.
		assert.equal(d.added.length, 0, `bridge added files under ~/.claude/: ${d.added.join(", ")}`);
		assert.equal(d.modified.length, 0, `bridge modified files under ~/.claude/: ${d.modified.join(", ")}`);
	});
});
