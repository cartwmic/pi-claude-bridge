## 1. claude-p fork: write-only PTY output mirror

- [x] 1.1 Implement `--mirror-file <path>` in the fork at `/Volumes/Workshop/git/claude-p`: flag parsing in `src/args.zig`, `Options` field + reader-loop tee in `src/driver.zig` (append every PTY output byte in arrival order; open lazily; write failures non-fatal, stderr note only), README flag-table row. `zig build -Doptimize=ReleaseSafe` and `zig build test` green. Commit on the fork as `custom: add --mirror-file write-only PTY output mirror (upstream smithersai/claude-p; for pi-claude-bridge claude-peek-overlay)`. Push the fork branch. AC: claude-p-fork.write-only-pty-output-mirror
  - intent: feature
  - files_allowed:
      - openspec/changes/add-claude-peek-overlay/**
  - allow_new_files: true
- [x] 1.2 Bump the `claude-p` pin in bridge `package.json` to the fork commit from 1.1; `npm install`; verify `node_modules/claude-p` carries the flag (`claude-p --help` or strings check).
  - intent: infra
  - files_allowed:
      - package.json
      - package-lock.json
  - allow_new_files: false

## 2. Bridge spawn plumbing

- [x] 2.1 Add optional `mirrorFile` to the claude-p spawn config in `src/driver/claudeP.ts`: argv assembly emits `--mirror-file <path>` when set (pure `buildClaudePArgs` change + config type). Unit-test argv assembly both ways.
  - intent: feature
  - files_allowed:
      - src/driver/claudeP.ts
      - tests/**
  - allow_new_files: true
- [x] 2.2 In `index.ts`, resolve a per-spawn mirror path for MAIN-PROVIDER spawns only (never capture path), under the bridge diagnostics dir (same root as existing per-spawn debug files; never `~/.claude/`); track the current main-turn mirror path for the peek module; keep-last-N cleanup (default N=5) of older mirror files. AC: claude-peek-overlay.mirror-files-confined-to-bridge-owned-storage, claude-peek-overlay.peek-follows-latest-main-turn-spawn-only
  - intent: feature
  - files_allowed:
      - index.ts
      - src/**
      - tests/**
  - allow_new_files: true
- [x] 2.3 Add `@xterm/headless` dependency.
  - intent: infra
  - files_allowed:
      - package.json
      - package-lock.json
  - allow_new_files: false

## 3. Peek module + overlay

- [ ] 3.1 New `src/peek/` module: mirror-file tailer (poll/fs.watch, replay-from-byte-0 on retarget) feeding an `@xterm/headless` `Terminal({cols:120, rows:40})`; screen-snapshot API returning grid rows via `translateToString(true)`; render coalescing at a bounded rate (≤20/s); explicit states `idle | live | error`; all errors caught, surfaced as state + structured log, never thrown into the stream path. AC: claude-peek-overlay.live-screen-during-main-provider-turn, claude-peek-overlay.explicit-idle-and-error-states, claude-peek-overlay.peek-failures-never-affect-the-inference-turn, claude-peek-overlay.fixed-session-geometry-rendering
  - intent: feature
  - files_allowed:
      - src/peek/**
      - tests/**
  - allow_new_files: true
- [ ] 3.2 Register `/claude-peek` command in `index.ts` (handler signature `(args, ctx)`): toggles `ctx.ui.custom()` overlay (`overlay: true`, `nonCapturing: true`, anchor top-right, width ≤ session width + border); retain `done` for toggle-off; dispose timers/tailers in `dispose()`; crop/h-scroll rows when overlay viewport < 120 cols; retarget to newest main-turn spawn automatically. AC: claude-peek-overlay.overlay-toggle-command, claude-peek-overlay.peek-follows-latest-main-turn-spawn-only
  - intent: feature
  - files_allowed:
      - index.ts
      - src/peek/**
      - tests/**
  - allow_new_files: true

## 4. Tests + validation sources

- [ ] 4.1 Unit tests (cite AC IDs literally): emulator screen model replays the spike capture (`.spike-notes/claude-peek/capture/raw-pty-full-turn.bin`) to a faithful final grid; coalescing bounds re-render rate; retarget resets the emulator; keep-last-N cleanup; crop behavior; error-state transitions on unreadable mirror file.
  - intent: feature
  - files_allowed:
      - tests/**
  - allow_new_files: true
- [ ] 4.2 E2E tmux scenario `scripts/run-scenario-s31-claude-peek.sh` (scenario-lib harness, private server): overlay visible after `/claude-peek`; overlay content advances during a streaming turn; prompt typed+submitted while overlay open reaches the model (coherence probe with positive + negative regex); toggle-off removes overlay; NDJSON/stream output of the turn unaffected by mirroring (no PTY-pollution regression). Add scenario block to `SCENARIOS.md`. AC: claude-peek-overlay.overlay-toggle-command, claude-peek-overlay.live-screen-during-main-provider-turn, claude-p-fork.write-only-pty-output-mirror
  - intent: feature
  - files_allowed:
      - scripts/**
      - SCENARIOS.md
      - tests/**
  - allow_new_files: true
- [ ] 4.3 Author `openspec/opsx-gates.yaml` (agent-independent validation source, required at M): `npm run typecheck` (required), `npm run test:unit` (required), scenario s31 (required). Verify `opsx gate` picks it up.
  - intent: infra
  - files_allowed:
      - openspec/opsx-gates.yaml
  - allow_new_files: true

## 5. Docs

- [ ] 5.1 README: document `/claude-peek`, the mirror-file diagnostics location/cleanup, and the read-only guarantee; CHANGELOG entry.
  - intent: feature
  - files_allowed:
      - README.md
      - CHANGELOG.md
  - allow_new_files: false
