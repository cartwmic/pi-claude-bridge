# ADR-0011: Deterministic transcript path via pre-generated `--session-id`

**Status:** Accepted
**Date:** 2026-05-24
**Source change:** `openspec/changes/archive/2026-05-24-replace-sdk-with-pty-tui/`

## Context

ADR-0004 commits to tailing the transcript JSONL file `claude` writes. The bridge needs to know that file's path BEFORE `claude` writes to it, so the tailer can start watching the parent directory and open the file the moment it appears.

Initial designs assumed `SessionStart`'s hook payload would carry `transcript_path`. Phase 0 spike T0.13 revealed two failure modes: (a) payload schema may vary across `claude` versions; (b) reliance on hook delivery races with the first transcript write. The Round-2 fallback ("directory snapshot + mtime") was Constitution-III-violating (writes outside `~/.claude/projects/`) and race-prone (concurrent PTY spawns).

## Decision Drivers

- Constitution III: bridge reads only paths it can prove it owns / deterministically computed
- No race with `claude`'s first transcript write
- No dependency on hook payload schema stability
- Survive macOS `/var/folders/...` → `/private/var/folders/...` realpath symlink

## Considered Options

### Option A: Pre-generated UUID via `crypto.randomUUID()` + `--session-id` flag
For each PTY spawn:
1. Bridge generates UUID at spawn time
2. Spawn flag `--session-id <uuid>` added (per `claude --help`: "Use a specific session ID for the conversation")
3. Bridge computes transcript path: `~/.claude/projects/<encodeCwd(realpath(cwd))>/<uuid>.jsonl` where `encodeCwd(p)` replaces `/` with `-`
4. Tailer opens path as soon as file appears via brief `fs.watch` on parent directory
5. `SessionStart` payload (if it carries `transcript_path`) is cross-checked, warn-logged on mismatch

**Pros:** path deterministic from bridge's own RNG; no race with first write; no hook payload dependency. Constitution III amended (v1.0.0) to allow this exemption.
**Cons:** `realpathSync(cwd)` required on macOS (Phase 0 F1 correction: tmpdir paths are symlinks).

### Option B: Directory snapshot + mtime detection
Before spawn, snapshot `~/.claude/projects/<encoded-cwd>/`. After spawn, scan for new files matching mtime > snapshot time.

**Pros:** no flag dependency.
**Cons:** Constitution-III-violating (Round-3 B.P1#2: reads files the bridge didn't claim); race-prone with concurrent spawns; rejected.

### Option C: `SessionStart` payload contains `transcript_path`; bridge reads it from there
**Pros:** trust upstream.
**Cons:** schema variability; payload may not include it on all `claude` versions; race with first write (Round-2 B.P1#1). Now used as cross-check only.

## Decision Outcome

**Chosen option:** A — pre-generated UUID via `--session-id`.

**Rationale:** the path is deterministically computed from a value the bridge itself generated. Constitution III amendment ratified by this Scale-L change's adversarial-review-cycle. Eliminates the directory-snapshot constitution violation AND the `SessionStart`-payload-dependency race. macOS realpath correction (Phase 0 F1) caught early.

## Consequences

**Positive:**
- Tailer starts watching parent directory immediately on spawn
- No race with first transcript write
- No dependency on hook payload schema
- Constitution III satisfied via amended exemption clause (b)

**Negative:**
- `realpathSync(cwd)` is mandatory (macOS) — `/var` vs `/private/var` mismatch silently breaks otherwise
- Bridge generates UUIDs that `claude` then uses as session IDs (semantic ownership question, addressed via cache-drop invariants)
- Future `claude` versions might reject pre-generated UUIDs (mitigated: documented flag; unlikely)

**Neutral:**
- Constitution III v1.0.0 → v1.1.0 amendment ratified
- `--resume` and `--session-id` interaction is unspecified — bridge passes only `--resume` on warm-resume (see related: D22 warm-resume transcript path)

## Links

- Source design discussion: `openspec/changes/archive/2026-05-24-replace-sdk-with-pty-tui/design.md` (Decision D18)
- Related ADRs: ADR-0004 (transcript tailing), ADR-0001 (PTY-driver), ADR-0015 (typed injection waits for SessionStart, independent of path resolution)
