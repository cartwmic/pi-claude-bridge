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

import { mkdirSync, readdirSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/** Env override for the peek dir (tests / operator). */
export const PEEK_DIR_ENV = "CLAUDE_BRIDGE_PEEK_DIR";

/** Mirror files retained per cleanup pass (newest first). */
export const KEEP_LAST_N = 5;

/** Minimal logger shape (subset of pino) so this module stays dependency-free. */
export interface PeekLogger {
	warn(obj: unknown, msg?: string): void;
}

/** Bridge-owned peek dir: env override, else <tmpdir>/claude-bridge-peek. */
export function resolvePeekDir(env: NodeJS.ProcessEnv = process.env): string {
	const override = env[PEEK_DIR_ENV];
	return override && override.length > 0 ? override : join(tmpdir(), "claude-bridge-peek");
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
export function prepareMirrorForSpawn(sessionId: string, log?: PeekLogger, env: NodeJS.ProcessEnv = process.env): string | undefined {
	try {
		const dir = resolvePeekDir(env);
		mkdirSync(dir, { recursive: true });
		cleanupOldMirrors(dir, KEEP_LAST_N, log);
		const path = mirrorPathFor(dir, sessionId);
		setCurrentMirror(path);
		return path;
	} catch (err) {
		log?.warn({ err: err instanceof Error ? err.message : String(err) }, "peek: mirror preparation failed; spawn proceeds unmirrored (non-fatal)");
		return undefined;
	}
}

// ── Current-mirror tracking (retarget hook for the overlay) ────────────────

type MirrorListener = (path: string | null) => void;

let currentMirror: string | null = null;
const listeners = new Set<MirrorListener>();

/** Publish the current main-turn mirror path (null = no active mirror). */
export function setCurrentMirror(path: string | null): void {
	currentMirror = path;
	for (const fn of listeners) {
		try {
			fn(path);
		} catch {
			/* listener errors never propagate into the spawn path */
		}
	}
}

export function getCurrentMirror(): string | null {
	return currentMirror;
}

/** Subscribe to retargets. Returns unsubscribe. */
export function onCurrentMirrorChange(fn: MirrorListener): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}
