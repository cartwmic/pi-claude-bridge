## 0. Spike & baseline

- [x] 0.1 Commit the reproduction harness + proof fixture (`stoptimeout-proof.mjs`, `stoptimeout-rootcause-PROVEN.md`) and a recorded stock-binary baseline (dropped-prompt failures under 16-worker/concurrency-10 load).
  - intent: infra
  - files_allowed:
      - .spike-notes/claude-p-gate/**
  - allow_new_files: true
- [ ] 0.2 Spike the echo signal against REAL `claude-p`: confirm `SharedState.recent` holds the prompt echo on success and not on a dropped turn, and that clear-line (Ctrl-U) fully resets a partially-filled Ink input (clarify / risk R6). Record findings.
  - intent: infra
  - files_allowed:
      - .spike-notes/claude-p-gate/**
  - allow_new_files: true

## 1. Fork & patch (repo: ~/git/claude-p — NOT the bridge repo)

- [ ] 1.1 `gh repo fork smithersai/claude-p`, clone to `~/git/claude-p`, ensure `upstream` remote, track `origin` (per `forking-for-custom-patches`). (External repo.)
- [ ] 1.2 Patch `src/driver.zig`: replace the blind `ink_enter_debounce_ms` sleep with the echo-confirm-or-retype loop (snapshot `recent` len → type → poll new ANSI-stripped bytes for a distinctive prompt token → clear-line + retype on miss, bounded → Enter only on confirm); add `RunError.PromptNotAccepted` (D1/D3). Satisfies claude-p-fork.echo-confirmed-prompt-commit, .bounded-retype-on-dropped-prompt, .fail-fast-when-the-prompt-cannot-be-confirmed. (External repo.)
- [ ] 1.3 Build with Zig 0.15.2 for the dev platform; verify it still drives the interactive TUI and forwards `--disallowedTools`/`--strict-mcp-config`/`--setting-sources` unchanged (claude-p-fork.patch-preserves-the-interactive-tui-driving-model). (External repo.)
- [ ] 1.4 Commit on the fork default branch, `custom:`-prefixed with upstream URL + reason; push to `origin` (claude-p-fork.fork-is-maintained-against-upstream). (External repo.)

## 2. Integrate & validate (gate G-echo)

- [ ] 2.1 Repoint the bridge `package.json` `claude-p` dependency to the fork; ensure `resolveClaudePBin()` (main + capture paths) runs the patched binary; fail loudly if the platform binary is absent. Satisfies claude-p-driver.driver-runs-the-patched-claude-p-binary.
  - intent: infra
  - files_allowed:
      - package.json
      - package-lock.json
      - index.ts
      - scripts/**
  - allow_new_files: true
- [ ] 2.2 Add the patched-binary identity check (extend `checkClaudePVersionsOnce` in `index.ts`): warn on stock-binary fallback. Satisfies the identity half of claude-p-driver.driver-runs-the-patched-claude-p-binary.
  - intent: feature
  - files_allowed:
      - index.ts
      - tests/**
  - allow_new_files: true
- [ ] 2.3 Run `stoptimeout-proof.mjs` against the patched binary at the SAME load: assert 0 dropped-prompt failures (G-echo); record the before/after fixture (stock 2/60 → patched 0). Implements D4.
  - intent: infra
  - files_allowed:
      - .spike-notes/claude-p-gate/**
      - tests/**
  - allow_new_files: true

## 3. Tests, constitution re-verify & verification

- [ ] 3.1 Test that `resolveClaudePBin()` resolves the patched binary on both paths and the identity check warns on a stock binary; wire G-echo into the suite where the runner can drive real `claude`/`claude-p`.
  - intent: feature
  - files_allowed:
      - tests/**
      - index.ts
      - package.json
  - allow_new_files: true
- [ ] 3.2 Re-verify constitution III (no `~/.claude` writes) and IV (disallow flags forwarded) hold post-swap; document the fork + `sync-custom-forks` re-validation workflow in README/TODO.
  - intent: feature
  - files_allowed:
      - tests/**
      - index.ts
      - README.md
      - TODO.md
  - allow_new_files: true
- [ ] 3.3 Author `verify.md`: map each AC (claude-p-fork.* + claude-p-driver.*) to its validating test/gate (G-echo for reliability; unit tests for resolution + identity), carry the clarify clear-line result, record the Completion Decision.
  - intent: infra
  - files_allowed:
      - openspec/changes/fork-claude-p-echo-confirm-input/**
  - allow_new_files: true
