// ---------------------------------------------------------------------------
// Warm-pi-resume content-free sidecar store.
//
// Persists a minimal, CONTENT-FREE record per (literal spawn cwd + full pi
// sessionId) so the first turn after a pi restart/resume can validate and warm-
// resume the prior `claude` driver session (`--resume`) instead of cold-starting.
//
// Constitution Principle I (v2.0.0): the bridge MAY persist resume *metadata*
// but no conversation content. The history fingerprint chain is therefore a
// one-way `sha256` digest per message position — NOT index.ts's in-memory
// `hashMessage` value, which embeds up to 128 chars of verbatim plaintext. No
// message bodies, tool args/results, thinking text, or turn counters are stored.
//
// Storage: ~/.pi/agent/resume/<key>.json (NEVER ~/.claude/ — Principle III is
// unchanged by the warm path). Writes are atomic (temp + rename). Reads are
// best-effort: any missing/torn/malformed/expired file yields null -> cold-start,
// the always-safe floor.
//
// Keying (design D3): the LITERAL `frame.cwd` (NOT realpath) + the FULL pi
// `sessionId` (NOT the 8-char getPiSessionId truncation). `claude` fragments its
// transcript dirs by literal cwd and `--resume` cannot cross a symlink alias, so
// keying on the literal path is correct: a resume from a different literal path
// simply misses the sidecar -> cold (the only safe outcome).
// ---------------------------------------------------------------------------

import { createHash } from "crypto";
import {
	mkdirSync,
	readFileSync,
	writeFileSync,
	renameSync,
	rmSync,
	readdirSync,
	statSync,
} from "fs";
import { homedir } from "os";
import { join } from "path";

/** Content-free resume sidecar schema (the ONLY persisted shape). */
export interface ResumeSidecar {
	/** The `claude` driver session id to pass to `--resume`. */
	claudeSessionId: string;
	/** The full pi session id this sidecar belongs to (also encoded in the key). */
	piSessionId: string;
	/**
	 * One-way fingerprint of pi's message history at persist time: a `sha256` hex
	 * digest per message position. Prefix-comparable across history growth; no
	 * plaintext is recoverable.
	 */
	historyHashChain: string[];
	/** Installed `claude` version at persist time, for version-gating (or null). */
	claudeVersion: string | null;
}

/** Default prune knobs (overridable via env for tests / ops). */
const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const DEFAULT_MAX = 256;

/**
 * The bridge-owned sidecar directory. Defaults to ~/.pi/agent/resume/ (alongside
 * claude-p's existing stale-diag dir); CLAUDE_BRIDGE_RESUME_DIR overrides (tests).
 * Never under ~/.claude/.
 */
export function resumeStoreDir(): string {
	return process.env.CLAUDE_BRIDGE_RESUME_DIR || join(homedir(), ".pi", "agent", "resume");
}

/**
 * Derive the sidecar key from the LITERAL cwd + FULL sessionId. A `sha256` of
 * the pair gives a filesystem-safe, collision-resistant key while keeping both
 * inputs verbatim-distinct (alias-vs-target paths differ; full ids differ even
 * when their 8-char prefixes match).
 */
export function deriveResumeKey(cwd: string, sessionId: string): string {
	return createHash("sha256").update(`${cwd}\n${sessionId}`).digest("hex");
}

/**
 * Compute the one-way history fingerprint chain: `sha256(role ":" len ":" text)`
 * per message position. The digest is opaque (no plaintext recoverable) yet
 * prefix-comparable: a longer history shares the exact prefix digests of a
 * shorter one (forward progress is a prefix-extension, not divergence).
 */
export function computeSha256Chain(
	items: ReadonlyArray<{ role: string; text: string }>,
): string[] {
	return items.map(({ role, text }) =>
		createHash("sha256").update(`${role}:${text.length}:${text}`).digest("hex"),
	);
}

function sidecarFile(cwd: string, sessionId: string): string {
	return join(resumeStoreDir(), `${deriveResumeKey(cwd, sessionId)}.json`);
}

function isValidSidecar(v: unknown): v is ResumeSidecar {
	if (typeof v !== "object" || v === null) return false;
	const o = v as Record<string, unknown>;
	return (
		typeof o.claudeSessionId === "string" &&
		typeof o.piSessionId === "string" &&
		Array.isArray(o.historyHashChain) &&
		o.historyHashChain.every((h) => typeof h === "string") &&
		(o.claudeVersion === null || typeof o.claudeVersion === "string")
	);
}

function ttlMs(): number {
	const raw = process.env.CLAUDE_BRIDGE_RESUME_TTL_MS;
	if (raw === undefined || raw === "") return DEFAULT_TTL_MS;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_MS;
}

function maxCount(): number {
	const raw = process.env.CLAUDE_BRIDGE_RESUME_MAX;
	if (raw === undefined || raw === "") return DEFAULT_MAX;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX;
}

/**
 * Prune the store (Risk R5): drop sidecars older than the TTL, then enforce the
 * count cap by dropping the oldest. Best-effort; never throws (a prune failure
 * must never break a turn or a resume).
 */
function pruneStore(): void {
	try {
		const dir = resumeStoreDir();
		let entries: { file: string; mtime: number }[];
		try {
			entries = readdirSync(dir)
				.filter((f) => f.endsWith(".json"))
				.map((f) => {
					const p = join(dir, f);
					return { file: p, mtime: statSync(p).mtimeMs };
				});
		} catch {
			return; // dir absent / unreadable — nothing to prune
		}
		const now = Date.now();
		const ttl = ttlMs();
		const survivors: { file: string; mtime: number }[] = [];
		for (const e of entries) {
			if (now - e.mtime > ttl) {
				try { rmSync(e.file, { force: true }); } catch { /* ignore */ }
			} else {
				survivors.push(e);
			}
		}
		const cap = maxCount();
		if (survivors.length > cap) {
			survivors.sort((a, b) => a.mtime - b.mtime); // oldest first
			for (const e of survivors.slice(0, survivors.length - cap)) {
				try { rmSync(e.file, { force: true }); } catch { /* ignore */ }
			}
		}
	} catch {
		/* ignore — pruning is opportunistic */
	}
}

/**
 * Read + validate a sidecar by (literal cwd + full sessionId). Returns null on
 * any miss/corruption/expiry (-> cold-start). Triggers an opportunistic prune.
 */
export function readSidecar(cwd: string, sessionId: string): ResumeSidecar | null {
	pruneStore();
	try {
		const parsed = JSON.parse(readFileSync(sidecarFile(cwd, sessionId), "utf8"));
		return isValidSidecar(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * Atomically persist a sidecar (temp + rename) under (literal cwd + full
 * sessionId). Throws on I/O failure — callers (finalizeClaudePFrame) wrap this
 * best-effort so a write failure logs and the turn completes normally.
 */
export function writeSidecar(cwd: string, sessionId: string, sidecar: ResumeSidecar): void {
	const dir = resumeStoreDir();
	mkdirSync(dir, { recursive: true });
	const file = sidecarFile(cwd, sessionId);
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, JSON.stringify(sidecar));
	try {
		renameSync(tmp, file);
	} catch (err) {
		try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
		throw err;
	}
}

/**
 * Drop the sidecar for (literal cwd + full sessionId). Best-effort; never throws
 * (used on the turn-error path, where a missing file is the normal case).
 */
export function invalidateSidecar(cwd: string, sessionId: string): void {
	try {
		rmSync(sidecarFile(cwd, sessionId), { force: true });
	} catch {
		/* ignore */
	}
}
