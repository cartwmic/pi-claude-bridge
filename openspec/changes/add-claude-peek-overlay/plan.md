# Execution Plan

## Plan step 1: Fork mirror tee

- **Covers:** T1.1
- **Pre-conditions:**
  - Fork checkout at `/Volumes/Workshop/git/claude-p` on its default branch, clean tree, Zig 0.15.2 available.
- **Action:**
  1. `src/args.zig`: parse `--mirror-file <path>` into args struct; reject empty path; thread into `driver.Options` (new `mirror_file: ?[]const u8 = null`).
  2. `src/driver.zig`: in the NativeSession reader/event path where PTY output chunks are already scanned, append each chunk to the mirror file. Open lazily on first chunk (create/truncate); on open/write error, disable mirroring for the rest of the turn and write one stderr note; never touch exit codes or stdout.
  3. README: add flag-table row.
  4. `zig build -Doptimize=ReleaseSafe && zig build test`.
  5. Add a Zig test: driver options with mirror path produce a file whose bytes equal the fed PTY chunks (pure tee, arrival order); absent flag → no file.
  6. Commit `custom: add --mirror-file write-only PTY output mirror (upstream smithersai/claude-p; for pi-claude-bridge claude-peek-overlay)`; push fork.
- **Verification:** `zig build test` green; manual `claude-p --help`/README shows the flag; stdout of a real short turn byte-identical with and without the flag.
- **Rollback:** revert the fork commit; bridge pin unchanged until step 2.

## Plan step 2: Pin bump + spawn plumbing

- **Covers:** T1.2, T2.1, T2.3
- **Pre-conditions:** step 1 pushed; bridge worktree created by apply (Diff Base SHA captured in review.md).
- **Action:**
  1. `package.json`: bump `claude-p` pin to step-1 SHA; add `@xterm/headless`; `npm install`.
  2. `src/driver/claudeP.ts`: add `mirrorFile?: string` to `ClaudePSpawnConfig`; `buildClaudePArgs` emits `--mirror-file <path>` when set.
  3. Unit tests: argv includes the flag when set, omits when unset (pure function test).
- **Verification:** `npm run typecheck`; `npm run test:unit`; `node_modules/claude-p` binary honors the flag (smoke: spawn `claude-p --help` or strings check).
- **Rollback:** revert pin + argv commit; no behavior change downstream since flag unused.

## Plan step 3: Mirror lifecycle in index.ts

- **Covers:** T2.2
- **Pre-conditions:** step 2 committed.
- **Action:**
  1. Diagnostics-dir helper: `peek/` subdir beside existing per-spawn debug files (bridge-owned; never `~/.claude/`).
  2. Main-provider spawn path only: set `mirrorFile` to `<peekdir>/<sessionId>-<ts>.raw`; capture path never sets it.
  3. Track "current main-turn mirror path" in module state; notify peek module on change (retarget hook).
  4. Keep-last-N cleanup (N=5) on each new spawn.
  5. Unit tests: capture-path config never carries mirrorFile; cleanup retains N newest; current-path tracking updates on new spawn. Cite `claude-peek-overlay.mirror-files-confined-to-bridge-owned-storage` and `claude-peek-overlay.peek-follows-latest-main-turn-spawn-only`.
- **Verification:** `npm run typecheck && npm run test:unit`.
- **Rollback:** revert commit; flag simply never set again.

## Plan step 4: Peek module (screen model)

- **Covers:** T3.1
- **Pre-conditions:** step 3 committed (`@xterm/headless` present).
- **Action:**
  1. `src/peek/screen.ts`: emulator wrapper — `Terminal({cols:120, rows:40, allowProposedApi:true})`; `feed(bytes)`; `snapshotRows(): string[]` via `buffer.getLine(viewportY+y).translateToString(true)`.
  2. `src/peek/tailer.ts`: follow a mirror file (fs.watch + poll fallback, 100ms); on retarget: reset emulator, replay file from byte 0, then follow appends.
  3. `src/peek/state.ts`: `idle | live | error` state machine + structured-log emission on error; every fs/emulator call wrapped — errors become `error` state, never propagate.
  4. Render coalescing: dirty flag + ≥50ms min interval between snapshot notifications (≤20/s).
  5. Unit tests citing AC IDs: replay spike capture `.spike-notes/claude-peek/capture/raw-pty-full-turn.bin` → final grid contains the known frame content ("3288", footer text); coalescing bound; retarget reset; unreadable file → error state; crop helper (120-col row sliced to viewport width).
- **Verification:** `npm run typecheck && npm run test:unit`.
- **Rollback:** module is unreferenced by stream path; revert commit.

## Plan step 5: /claude-peek overlay command

- **Covers:** T3.2
- **Pre-conditions:** step 4 committed.
- **Action:**
  1. `index.ts`: `pi.registerCommand("claude-peek", { handler: async (args, ctx) => … })` — NOTE signature `(args, ctx)` (spike gotcha).
  2. Toggle: first invoke → `ctx.ui.custom()` with `overlay: true`, `overlayOptions {anchor: "top-right", nonCapturing: true, width: min(122, viewport)}`; retain `done` for toggle-off; component `render(width)` returns bordered, cropped grid rows + state header (session id / IDLE / ERROR); `dispose()` clears tailer + timers.
  3. Subscribe component to peek-module snapshot notifications → `tui.requestRender()`.
  4. Retarget automatically on current-mirror-path change (step 3 hook).
- **Verification:** `npm run typecheck && npm run test:unit`; manual smoke in a dev pi session.
- **Rollback:** revert commit; command unregistered.

## Plan step 6: E2E scenario + gates manifest + docs

- **Covers:** T4.1 (any remaining), T4.2, T4.3, T5.1
- **Pre-conditions:** steps 1–5 committed; scenario harness available (`scripts/scenario-lib.sh`).
- **Action:**
  1. `scripts/run-scenario-s31-claude-peek.sh` (private tmux server, 140×42 pane): start pi with the built extension; `/claude-peek`; assert overlay marker; submit arithmetic prompt while overlay open; two mid-turn captures assert overlay content advances; completion wait via busy-footer regex (`Working...`); coherence probe positive (correct product) + negative (no refusal); toggle off asserted; assert bridge NDJSON/debug log shows clean completed turn (no PTY-pollution regression).
  2. `SCENARIOS.md`: S31 block.
  3. `openspec/opsx-gates.yaml`: `typecheck` (required), `unit` (required), `scenario-s31` (required).
  4. README `/claude-peek` section + CHANGELOG entry.
- **Verification:** s31 passes locally 2× consecutively; `opsx gate` runs the manifest.
- **Rollback:** scenario/manifest are additive; revert commit.

## Completion Verification

- `npm run typecheck` → exit 0
- `npm run test:unit` → exit 0 (includes AC-ID-cited peek tests)
- `scripts/run-scenario-s31-claude-peek.sh` → `ALL PASS`
- `openspec validate add-claude-peek-overlay --strict` → valid
- `opsx gate add-claude-peek-overlay --worktree <path>` → exit 0

## Manual Adjustments

- Execution Mode is `standard` (not TDD): plan steps use ordered actions with
  tests written alongside implementation rather than 5-step micro-tasks.
- Step 1 executes in the fork repo (`/Volumes/Workshop/git/claude-p`), outside
  the bridge worktree; its bridge-visible artifact is the pin bump in step 2.
  Fork push is required for the pin to resolve — recorded as in-scope for this
  change (matches the `echo-confirm-input` precedent). No push of the BRIDGE
  repo is performed by the loop.
