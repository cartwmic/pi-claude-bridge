# Phase 0 Spike Status

Session: 2026-05-21 (continuation of openspec apply for `replace-sdk-with-pty-tui`).

## Completed spikes

| Spike | Status | Headline |
|---|---|---|
| T0 (binary version) | ✓ | `claude 2.1.114 (Claude Code)`; tested-against range = `>=2.1.x <2.2.x` |
| T0.8 (--system-prompt + CLAUDE.md isolation) | ✓ PASS | `--system-prompt` REPLACES (verbatim per constitution V); CLAUDE.md does NOT leak |
| T0.14 (interactive liveness HARD GATE) | ✗ **FAIL — design update required** | Workspace trust dialog blocks fresh-cwd boot; not bypassed by `--dangerously-skip-permissions` |

## Critical findings affecting the design

### F1. Transcript path encoding uses REALPATH cwd

**Where it matters:** D18 (deterministic transcript path).

**Detail:** macOS `/var/folders/...` resolves to `/private/var/folders/...` via realpath. `claude` encodes the realpath, not the lexical cwd. The bridge MUST `fs.realpath(cwd)` before encoding `/` → `-`.

**Action:** add a sentence to D18 + the `claude-tui-driver.pty-spawn-with-model-selection` "Transcript path is computed deterministically" scenario.

### F2. node-pty 1.1.0 prebuild missing +x on spawn-helper

**Where it matters:** D2 (PTY library), T1.2 (deps install).

**Detail:** `node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper` is installed `-rw-r--r--` (no execute bit). All `posix_spawnp` calls fail until `chmod +x` is applied. Likely a packaging bug in node-pty 1.1.0; possibly fixed in a later release. Worth filing upstream.

**Action:** add a postinstall script to `package.json` that `chmod +x`'s the helper. Document the bug + workaround. Consider pinning node-pty to a version with confirmed prebuild integrity.

### F3. Workspace trust dialog blocks interactive mode for untrusted cwds (HARD BLOCKER)

**Where it matters:** D1, D5 (capture mode cwd), D9 (hooks), the entire main-provider liveness assumption.

**Detail:** see `.spike-notes/14-liveness.md`. Interactive `claude` presents a workspace-trust dialog when the cwd is untrusted. The dialog is NOT bypassed by `--dangerously-skip-permissions`. Only `-p` mode skips it.

**Affects:**
- Capture mode (cwd = `os.tmpdir()`): every call hits the dialog. BROKEN.
- First-time pi project (cwd untrusted): first turn blocks until user trusts. BROKEN UX.
- Normal use in already-trusted cwd: WORKS.

**Action:** new D-decision required before Phase 1 starts. Recommended approach is combination of (A) PTY-output scanning + auto-answer for first-time pi projects + (C) capture mode uses a single pre-trusted dir under `os.tmpdir()` or similar.

### F4. Interactive `claude` injects `attachment.skill_listing` regardless of `--system-prompt`

**Where it matters:** capture-path constitution V (V is satisfied for the system prompt itself; but additional model context is provided via attachments).

**Detail:** the transcript JSONL shows an `attachment.skill_listing` entry listing the user's 9 globally-configured skills. This is delivered as model context separate from the system prompt. The system prompt remains verbatim (constitution V OK), but the model has more context than the caller intended on the capture path.

**Action:** for capture mode, also pass `--disable-slash-commands` (skips skill resolution per `--help`). Verify in a follow-up spike. Document in design.

## Skipped spikes (deferred until trust-dialog story is settled)

T0.1, T0.2, T0.3, T0.4, T0.5, T0.6, T0.7, T0.10, T0.11, T0.12, T0.13. Each of these requires a live interactive `claude` invocation; the trust dialog blocks all of them in the current setup unless run in a pre-trusted cwd.

## Recommended next steps

1. **Owner decision required** on trust-dialog handling approach (A / B / C / E from `.spike-notes/14-liveness.md`).
2. **Re-run remaining spikes** in a pre-trusted cwd (e.g., this repo's worktree directory — already trusted by prior `claude` usage).
3. **Update design.md** with the chosen trust-dialog handling + F1 (realpath) + F2 (chmod) + F4 (--disable-slash-commands for capture).
4. **Then proceed to Phase 1.**

This is a clean stop point. The adversarial review log + Phase 0 partial spike evidence is persisted under `.opsx-review/replace-sdk-with-pty-tui/` and `.spike-notes/`. Owner can resume from here.
