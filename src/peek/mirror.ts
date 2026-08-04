// src/peek/mirror.ts — mirror-file lifecycle for the claude-peek overlay.
//
// Responsibilities (claude-peek-overlay.mirror-files-confined-to-bridge-owned-storage,
// claude-peek-overlay.peek-follows-latest-main-turn-spawn-only):
//   - Resolve the bridge-owned peek diagnostics dir (NEVER under ~/.claude/).
//   - Mint per-spawn mirror paths for MAIN-PROVIDER spawns (callers on the
//     capture path never invoke this module).
//   - Track the "current" main-turn mirror path and notify subscribers on
//     retarget (the overlay's screen model re-follows the newest spawn).
//   - Bound disk accumulation: keep the newest KEEP_LAST_N mirror files.
//
// Failure isolation (claude-peek-overlay.peek-failures-never-affect-the-inference-turn):
// every filesystem touch is wrapped; on any error the helper returns undefined
// (spawn proceeds unmirrored) — nothing here may throw into the spawn path.

import { mkdirSync, readdirSync, realpathSync, rmSync, statSync } from "fs";
import { homedir, tmpdir } from "os";
import { basename, dirname, join, resolve, sep } from "path";

/** Env override for the peek dir (tests / operator). */
export const PEEK_DIR_ENV = "CLAUDE_BRIDGE_PEEK_DIR";

/** Mirror files retained per cleanup pass (newest first). */
export const KEEP_LAST_N = 5;

/** Minimal logger shape (subset of pino) so this module stays dependency-free. */
export interface PeekLogger {
	warn(obj: unknown, msg?: string): void;
}

/**
 * Physical (symlink-resolved) form of a path that may not fully exist yet:
 * realpath the deepest EXISTING ancestor, then re-append the missing tail.
 * Never throws; degrades to the lexical resolve.
 */
export function physicalPath(p: string): string {
	let cur = resolve(p);
	const tail: string[] = [];
	for (;;) {
		try {
			return tail.length === 0 ? realpathSync(cur) : join(realpathSync(cur), ...tail.reverse());
		} catch {
			const parent = dirname(cur);
			if (parent === cur) return resolve(p); // hit fs root; nothing exists
			tail.push(basename(cur));
			cur = parent;
		}
	}
}

/** True when `p` (lexically OR physically, symlinks resolved) sits under `<home>/.claude`. */
function isUnderClaudeRoot(p: string, home: string): boolean {
	const claudeRoot = join(home, ".claude");
	const physRoot = physicalPath(claudeRoot);
	for (const candidate of [resolve(p), physicalPath(p)]) {
		for (const root of [claudeRoot, physRoot]) {
			if (candidate === root || candidate.startsWith(root + sep)) return true;
		}
	}
	return false;
}

/**
 * Bridge-owned peek dir: env override, else <tmpdir>/claude-bridge-peek.
 * Tenet T3 guard (code-review r1+r2 findings): an override that
 * resolves under ~/.claude/ — lexically OR through symlinks (physicalPath) —
 * is REJECTED (falls back to the default, with a warning). The bridge never
 * writes under ~/.claude/ no matter what the env says.
 */
export function resolvePeekDir(env: NodeJS.ProcessEnv = process.env, log?: PeekLogger, home: string = homedir()): string {
	// The tmpdir() default itself can land under ~/.claude when TMPDIR points
	// there — guard the FALLBACK too, escalating to ~/.cache (code-review r4;
	// tenet T3 is unconditional).
	let fallback = join(tmpdir(), "claude-bridge-peek");
	if (isUnderClaudeRoot(fallback, home)) {
		log?.warn({ fallback }, "peek: os.tmpdir() resolves under ~/.claude/ — using ~/.cache/claude-bridge-peek instead (tenet T3)");
		fallback = join(home, ".cache", "claude-bridge-peek");
	}
	const override = env[PEEK_DIR_ENV];
	if (!override || override.length === 0) return fallback;
	if (isUnderClaudeRoot(override, home)) {
		log?.warn({ override }, `peek: ${PEEK_DIR_ENV} resolves under ~/.claude/ (lexically or via symlink) — rejected (tenet T3); using default`);
		return fallback;
	}
	return resolve(override);
}

/** Per-spawn mirror filename: <sessionId>-<ts>.raw (ts keeps names unique across retries). */
export function mirrorPathFor(peekDir: string, sessionId: string, now: number = Date.now()): string {
	return join(peekDir, `${sessionId}-${now}.raw`);
}

/**
 * Delete all but the newest `keep` *.raw files in the peek dir (by mtime,
 * newest retained). Never throws; best-effort.
 */
export function cleanupOldMirrors(peekDir: string, keep: number = KEEP_LAST_N, log?: PeekLogger): void {
	try {
		const entries = readdirSync(peekDir)
			.filter((f) => f.endsWith(".raw"))
			.map((f) => {
				const p = join(peekDir, f);
				try {
					return { p, mtime: statSync(p).mtimeMs };
				} catch {
					return { p, mtime: 0 };
				}
			})
			.sort((a, b) => b.mtime - a.mtime);
		for (const { p } of entries.slice(keep)) {
			try {
				rmSync(p);
			} catch {
				/* best-effort */
			}
		}
	} catch (err) {
		log?.warn({ err: err instanceof Error ? err.message : String(err) }, "peek: mirror cleanup failed (non-fatal)");
	}
}

/**
 * One-stop helper for the main-provider spawn site: ensure the peek dir
 * exists, clean up stale mirrors, mint this spawn's mirror path, and publish
 * it as current. Returns undefined on ANY failure (spawn proceeds unmirrored).
 */
export function prepareMirrorForSpawn(
	sessionId: string,
	log?: PeekLogger,
	env: NodeJS.ProcessEnv = process.env,
	home: string = homedir(),
): string | undefined {
	try {
		const dir = resolvePeekDir(env, log, home);
		mkdirSync(dir, { recursive: true });
		// keep-1: the file this spawn is about to lazy-create counts toward the
		// retained-file limit, so trim to KEEP_LAST_N-1 BEFORE minting — after
		// the new file appears at most KEEP_LAST_N remain (code-review r1;
		// claude-peek-overlay.mirror-files-confined-to-bridge-owned-storage).
		cleanupOldMirrors(dir, KEEP_LAST_N - 1, log);
		const path = mirrorPathFor(dir, sessionId);
		setCurrentMirror(path);
		return path;
	} catch (err) {
		log?.warn({ err: err instanceof Error ? err.message : String(err) }, "peek: mirror preparation failed; spawn proceeds unmirrored (non-fatal)");
		// The turn is LIVE but unpeekable — surface an explicit error to any open
		// overlay instead of leaving it idle/stale (code-review r3;
		// claude-peek-overlay.explicit-idle-and-error-states).
		publishMirrorError();
		return undefined;
	}
}

// ── Current-mirror tracking (retarget hook for the overlay) ────────────────

type MirrorListener = (path: string | null, error?: boolean) => void;

let currentMirror: string | null = null;
let currentMirrorError = false;
const listeners = new Set<MirrorListener>();

function notify(path: string | null, error: boolean): void {
	for (const fn of listeners) {
		try {
			fn(path, error);
		} catch {
			/* listener errors never propagate into the spawn path */
		}
	}
}

/** Publish the current main-turn mirror path (null = no active mirror). */
export function setCurrentMirror(path: string | null): void {
	currentMirror = path;
	currentMirrorError = false;
	notify(path, false);
}

/**
 * Publish "main turn live but mirror unavailable": overlays show their
 * explicit error state (claude-peek-overlay.explicit-idle-and-error-states).
 * Cleared by the next setCurrentMirror (new spawn or turn-end null).
 */
export function publishMirrorError(): void {
	currentMirror = null;
	currentMirrorError = true;
	notify(null, true);
}

/** True while the last publication was a mirror-preparation error. */
export function hasCurrentMirrorError(): boolean {
	return currentMirrorError;
}

export function getCurrentMirror(): string | null {
	return currentMirror;
}

/** Subscribe to retargets. Returns unsubscribe. */
export function onCurrentMirrorChange(fn: MirrorListener): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}
