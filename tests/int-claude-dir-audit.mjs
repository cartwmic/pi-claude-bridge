#!/usr/bin/env node
// T4.2 — tenet T3 audit: the bridge opens NO path under `~/.claude/` in
// production code.
//
// tenet T3 ("never read claude state"): the claude-p driver observes the
// turn EXCLUSIVELY through claude-p's stdout (parsed by ClaudePStreamParser). It
// reads no settings, sessions, transcripts, skills, or plugins from `~/.claude/`.
// The ONLY filesystem touches the bridge performs are (a) its own debug log and
// AGENTS.md/APPEND_SYSTEM.md under `~/.pi/`, and (b) caller-supplied overflow
// tmpfiles under `os.tmpdir()`. Never `~/.claude/`.
//
// This is a DETERMINISTIC, static, unit-style check (node:test, no subprocess, no
// real claude-p): it scans the production source for any filesystem-access call
// or homedir()-derived path constant whose target references a `~/.claude` path
// SEGMENT. It FAILS if such an access is ever introduced.
//
// Allowed (NOT flagged): comments and string content that merely MENTION
// `.claude` (e.g. the tenet T3 assertion comments, log messages, or the
// `.pi` → `.claude` DISPLAY sanitizer at index.ts:437-439 which rewrites agent
// instruction TEXT and never touches the filesystem). The distinguishing rule:
// a `.claude` path SEGMENT (`.claude/`, `.claude"`, `~/.claude`, or a
// `join(homedir(), ".claude", …)` element) co-located with a filesystem call or
// a homedir() base is a VIOLATION; a `.claude` appearing only as `.replace(...)`
// output, in a log string, in a comment, or as a substring of an identifier
// (e.g. `frame.claudeHandle`) is NOT.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

// Production source scope (the exact set named by T4.2).
const PROD_FILES = [
	"index.ts",
	"convert.ts",
	"models.ts",
	"src/capture.ts",
	"src/driver/ansi.ts",
	"src/driver/claudeP.ts",
	"src/driver/pty.ts",
	"src/driver/stream.ts",
	"src/mcp/ipc.ts",
	"src/mcp/router.ts",
	"src/mcp/shim.ts",
];

// Filesystem-access call names that, applied to a `~/.claude` path, would violate
// tenet T3. Covers the sync + async + stream + promises surfaces.
const FS_ACCESS_CALLS = [
	"readFile", "readFileSync",
	"writeFile", "writeFileSync",
	"appendFile", "appendFileSync",
	"open", "openSync",
	"existsSync",
	"access", "accessSync",
	"stat", "statSync", "lstat", "lstatSync",
	"readdir", "readdirSync",
	"mkdir", "mkdirSync",
	"rm", "rmSync", "unlink", "unlinkSync",
	"createReadStream", "createWriteStream",
	"copyFile", "copyFileSync",
	"realpath", "realpathSync",
];
const FS_CALL_RE = new RegExp(`\\b(?:${FS_ACCESS_CALLS.join("|")})\\s*\\(`);

/**
 * A `.claude` path SEGMENT — `.claude` immediately followed by a path separator
 * or string terminator, OR the literal `~/.claude`. This deliberately does NOT
 * match `.claudeHandle` (segment must end at `/`, a quote, or end-of-string).
 *
 *   matches:  "~/.claude"  ".claude/"  ".claude"  '.claude/sessions'  `/.claude`
 *   no match: claudeHandle  claude-p  .claude_dir  claudeP.ts
 */
const CLAUDE_SEGMENT_RE = /(?:^|[/\\"'`~])\.claude(?=$|[/\\"'`])/;

/** Read a production source file; returns its lines (1-indexed access via [i-1]). */
function readLines(rel) {
	return readFileSync(resolve(REPO, rel), "utf-8").split("\n");
}

/**
 * True if `line` is purely a comment line (single-line `//`, or a block-comment
 * body/opener where the trimmed line begins with `*`, `//`, or `/*`). The
 * tenet T3 assertion + the design notes are written as comments, so
 * comment lines MUST be exempt.
 */
function isCommentLine(line) {
	const t = line.trim();
	return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

/**
 * True if a `.claude` segment on this line is produced ONLY by a string-rewriting
 * `.replace(...)` (the `.pi` → `.claude` DISPLAY sanitizer). That code emits the
 * TEXT `.claude` for agent instructions; it never opens a path. We detect the
 * sanitizer shape conservatively: a `.replace(` appears on the line AND no
 * filesystem call / homedir() base appears on the same line.
 */
function isReplaceSanitizerLine(line) {
	return /\.replace\s*\(/.test(line) && !FS_CALL_RE.test(line) && !/\bhomedir\s*\(\s*\)/.test(line);
}

/**
 * Scan one production file for forbidden `~/.claude` filesystem accesses.
 * Returns an array of { file, lineNo, line } violations.
 *
 * A line is a VIOLATION when it is NOT a comment / replace-sanitizer line AND it
 * carries a `.claude` path SEGMENT together with EITHER
 *   (a) a filesystem-access call (FS_ACCESS_CALLS), OR
 *   (b) a `homedir()` / `os.homedir()` base (a path-construction site).
 * That covers both `readFileSync(join(homedir(), ".claude", …))` (call + segment)
 * AND a standalone `const X = join(homedir(), ".claude", …)` (homedir + segment).
 */
function scanFile(rel) {
	const lines = readLines(rel);
	const violations = [];
	for (let n = 0; n < lines.length; n++) {
		const raw = lines[n];
		if (isCommentLine(raw)) continue;
		if (!CLAUDE_SEGMENT_RE.test(raw)) continue; // no .claude path segment here
		if (isReplaceSanitizerLine(raw)) continue; // display-only string rewrite
		const callsFs = FS_CALL_RE.test(raw);
		const homedirBase = /\bhomedir\s*\(\s*\)/.test(raw);
		if (callsFs || homedirBase) {
			violations.push({ file: rel, lineNo: n + 1, line: raw.trim() });
		}
	}
	return violations;
}

describe("T4.2 — tenet T3: no ~/.claude/ filesystem access in production", () => {
	it("scans the full production source scope (sanity: files exist + non-empty)", () => {
		for (const rel of PROD_FILES) {
			const lines = readLines(rel);
			assert.ok(lines.length > 0, `${rel} should be readable + non-empty`);
		}
	});

	it("NO production file performs a filesystem access on a ~/.claude path segment", () => {
		const all = [];
		for (const rel of PROD_FILES) all.push(...scanFile(rel));
		assert.deepEqual(
			all,
			[],
			`tenet T3 violated — filesystem access on a ~/.claude path found:\n` +
				all.map((v) => `  ${v.file}:${v.lineNo}  ${v.line}`).join("\n"),
		);
	});

	it("every homedir()-derived path base in production targets ~/.pi, never ~/.claude", () => {
		// Stronger positive: any `join(homedir(), …)` constant the bridge builds must
		// NOT contain a `.claude` segment, regardless of whether an fs call sits on
		// the same physical line. (All such bases legitimately target `.pi`.)
		const offenders = [];
		for (const rel of PROD_FILES) {
			const lines = readLines(rel);
			for (let n = 0; n < lines.length; n++) {
				if (isCommentLine(lines[n])) continue;
				if (!/\bhomedir\s*\(\s*\)/.test(lines[n])) continue;
				if (CLAUDE_SEGMENT_RE.test(lines[n])) {
					offenders.push(`${rel}:${n + 1}  ${lines[n].trim()}`);
				}
			}
		}
		assert.deepEqual(
			offenders,
			[],
			`a homedir()-based ~/.claude path was constructed in production code:\n  ${offenders.join("\n  ")}`,
		);
	});

	it("self-check: the detector flags a synthetic ~/.claude read and ignores benign mentions", () => {
		// Guards against the audit silently rotting into an always-pass. We feed the
		// same predicates the real scan uses against crafted lines.
		const flagged = (line) =>
			!isCommentLine(line) &&
			CLAUDE_SEGMENT_RE.test(line) &&
			!isReplaceSanitizerLine(line) &&
			(FS_CALL_RE.test(line) || /\bhomedir\s*\(\s*\)/.test(line));

		// MUST flag — genuine violations.
		assert.equal(flagged(`readFileSync(join(homedir(), ".claude", "settings.json"))`), true, "homedir+segment+fs read");
		assert.equal(flagged(`const SESSIONS = join(homedir(), ".claude", "sessions");`), true, "homedir+segment base");
		assert.equal(flagged(`existsSync("~/.claude/skills")`), true, "literal ~/.claude existsSync");
		assert.equal(flagged(`writeFileSync(p + "/.claude/x", data)`), true, "concatenated .claude/ write");

		// MUST NOT flag — benign mentions.
		assert.equal(flagged(`// NEVER opens any path under ~/.claude/ (tenet T3)`), false, "comment mention");
		assert.equal(flagged(` * which the shim builds under os.tmpdir(), never under ~/.claude/.`), false, "block-comment body");
		assert.equal(flagged(`.replace(/~\\/\\.pi\\b/gi, "~/.claude")`), false, "display sanitizer .replace");
		assert.equal(flagged(`frame.claudeHandle?.abort();`), false, "claudeHandle identifier substring");
		assert.equal(flagged(`const bin = "claude-p";`), false, "claude-p binary name");
		assert.equal(flagged(`log.info("we NEVER read ~/.claude/sessions/");`), false, "log string mention (no fs call/homedir)");
	});
});
