# Verify

AC↔evidence mapping for `fork-claude-p-echo-confirm-input`. Verification Mode =
retained-recommended (S). Evidence is the patched-binary smoke test, gate G-echo,
the unit suite, and code review of the confined patch.

## Acceptance criteria

| AC ID | Evidence | Status |
|---|---|---|
| claude-p-fork.echo-confirmed-prompt-commit | Patched-binary real-turn smoke: `typing prompt … attempt 1` → `prompt echo confirmed; Enter sent` → `result: success`. `driver.zig` gates Enter on `promptEchoConfirmed` over the `recent` buffer. | ✅ PASS |
| claude-p-fork.bounded-retype-on-dropped-prompt | G-echo: **58/60** spawns dropped the first type and recovered via retype; sample `RETYPE-RECOVERY-sample.log` shows attempt 1→2→3 then confirmed. Ctrl-U clear-line precedes each retype; Enter only after confirm (no double-submit). | ✅ PASS |
| claude-p-fork.fail-fast-when-the-prompt-cannot-be-confirmed | `RunError.PromptNotAccepted` returned on budget exhaustion (code review: returns before any Enter); distinct stderr name via `main.zig` generic handler (exit 2). G-echo: 0 occurrences (budget sufficient at load) — fast-fail path is reachable but not needed. | ✅ PASS |
| claude-p-fork.patch-preserves-the-interactive-tui-driving-model | Smoke turn drives the interactive Ink TUI to a real result (no `-p`/`--print`). Disallow forwarding untouched (`git diff` shows no change to `CLAUDE_P_DISALLOWED_TOOLS`/`buildClaudePArgs`). | ✅ PASS |
| claude-p-fork.fork-is-maintained-against-upstream | `cartwmic/claude-p`: `custom:`-prefixed commits (`99934f9`, `54aa7af`, `415f4ba`) on `main`; `upstream` remote → `smithersai/claude-p`. | ✅ PASS |
| claude-p-driver.driver-runs-the-patched-claude-p-binary | `package.json` → `github:cartwmic/claude-p#415f4ba`; resolved launcher runs `zig-out/bin/claude-p` (patched, verified). Identity check (`checkClaudePVersionsOnce` + `claudePPatch`) warns on stock — **4 unit tests** (289 total pass). | ✅ PASS |
| claude-p-driver.prompt-injection-via-claude-p-input (MODIFIED) | G-echo: a dropped prompt now recovers (or would fast-fail), never the 600s wedge — 2/60 → **0/60**. Existing injection behavior preserved (full unit suite green). | ✅ PASS |

## Gates

| Gate | Result |
|---|---|
| `npm run test:unit` | **289/289 pass** |
| `npm run typecheck` | clean |
| **G-echo** (`npm run test:gecho`, 16-worker/c10 load) | **0/60** dropped-prompt failures (stock baseline: 2/60) |
| Constitution III (no `~/.claude` writes) | ✅ no new coupling (identity check reads `node_modules`) |
| Constitution IV (native disallow forwarded) | ✅ disallow set + arg builder unchanged |
| Patched binary builds (Zig 0.15.2) | ✅ `zig build -Doptimize=ReleaseSafe` |

## Clarify resolution

- **C3 / R6 (clear-line resets partial input):** empirically validated by G-echo —
  58/60 spawns retyped (Ctrl-U + re-type) and **all recovered with 0 corrupt-prompt
  failures and 0 `PromptNotAccepted`**, confirming clear-line is sufficient at this
  load. (A heavier load could still exhaust the budget → fast-fail + D33 respawn,
  never a wedge.)

## Completion Decision: **GREEN**

The proven root cause is fixed at its source. The patched fork is built, integrated
via build-on-install, guarded by an identity check, and **empirically validated**:
the exact load that wedged stock `claude-p` 2/60 now passes 0/60, with the retype
recovery path exercised 58/60 times. Unit suite 289/289; constitution III/IV intact.

**Deferred (documented follow-ups, out of scope):** multi-platform CI/release
pipeline for the fork binary (consumers currently need Zig 0.15.2 at install);
bridge-side defense-in-depth (same-provider concurrency cap + idle-watchdog).
