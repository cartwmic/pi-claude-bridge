# Scenario validation results

Branch: `refactor/sdk-native-inference-only`. New `index.ts` is **963 lines**
(down from 1852 — ~48% reduction). Run scenarios via
`bash scripts/run-all-scenarios.sh`.

## Run summary — 2026-04-25

Bridge commit at this run: see `git log refactor/sdk-native-inference-only`.

| Scenario | Status | Coherence probe | Cache profile | Notes |
|---|---|---|---|---|
| S0 multi-turn text | **PASS** (auto) | "137 + prime" recalled | T1 creation=1291 read=5910 → T2 creation=489 read=7855 | 1 session_id |
| S1 single tool round-trip | **PASS** (auto) | T2 reused tool result, no re-call | T1 read=7214 → T2 creation=78 read=7962 | 1 session_id; read tool invoked exactly once |
| S6 follow-up multi-turn (via int-multi-turn.sh) | **PASS** | secret word "banana" recalled across 3 turns | n/a | covered by `tests/int-multi-turn.sh` |
| S7 abort during text | **PASS** (auto) | model acknowledged interruption | T1 cold (cacheRead=5910), T2 warm-resume after abort drops the id then re-resumes | 0 UUID rotations, 0 JSONL writes |
| S11 parallel tool_use | **PASS** | covered by `int-multi-turn.sh: single-turn: 3+ parallel tool calls` | n/a | regression test for the legacy index-based queue race — passes |
| S12 long convo / cache | **PASS** | covered by `int-cache.sh` | 7 turns, 96-99% cache hit rate | 1 cold-start, 4 warm-resumes, 1 unique session_id |

## Integration test totals (against new bridge)

```
unit-models           PASS (4 tests)
unit-import           PASS (26 tests, convert.ts)
int-smoke.sh          PASS (5 / 5)
int-multi-turn.sh     PASS (5 / 5)
int-cache.sh          PASS (1 / 1, 7-turn cache profile + session resume)
int-tool-message.mjs  PASS (5 / 5; 2 legacy "deferred replay" tests removed
                      per refactor charter — see file note)
int-session-resume.mjs (not run; requires CLAUDE_BRIDGE_TESTING_ALT_PROVIDER
                      env var — ALT model from .env.test was stale)
```

## Scenarios still requiring tmux-driven manual validation

These scenarios in `SCENARIOS.md` cannot be fully validated by the unit/int
test surface — they need interactive pi+tmux to test correctly. The harness
in `scripts/` is built but only S0, S1, S7 have wrappers so far.

- **S2** multi-step sequential tools — automated equivalent via `int-multi-turn.sh:single-turn` PASSES; tmux wrapper not yet written
- **S3** long-running tool (45s) — no automated test; architecturally handled (no bridge-level timeout, MCP handler awaits indefinitely)
- **S4** tool failure — not directly tested; architecturally handled (pi delivers `isError: true` toolResult, bridge passes through unchanged)
- **S5** mid-stream steering — supersedes by design (Case 3 in `streamSimple`); needs tmux to verify pane behavior + abandoned-topic recall
- **S8** abort during tool execution — needs tmux to verify orphan tool result handling (Case 2 in `streamSimple`)
- **S9** abort + immediate steer — needs tmux to verify rapid-fire interrupt+retype
- **S10** session resume across pi restart — pi's `--continue` / `--session` flag testing
- **S10b** warm cache resume within one process — implicitly verified by `int-cache.sh` (7 turns, 1 session_id)
- **S13** rapid abort+retype (typo-fix pattern) — needs tmux; supersession architecture in place
- **S14** subagent: claude-bridge → claude-bridge — needs subagent install + tmux
- **S15** subagent: claude-bridge → openai-codex — needs subagent install + tmux; bridge correctly stays out of the path
- **S16a** /fork — needs tmux + pi UI manipulation
- **S16b** /tree — needs tmux + pi UI manipulation
- **S17** /compact — pi compacts via the active provider; bridge requires zero compaction-specific code, replays the post-compact history naturally

## Cross-cutting invariants — current status

- **No bridge crash**: ✓ across all scenarios run
- **No silent message loss**: ✓ (no deferredUserMessages mechanism remains)
- **Bridge writes nothing to `~/.claude/sessions/`**: ✓ verified (no `cc-session-io` import, no `fs.writeFile` calls in `index.ts`)
- **CC session_id is in-memory only**: ✓ verified (only `cachedSessionId: string | null` lives at module scope)
- **No orphan subprocesses on abort**: ✓ verified (S7 — pi process exits cleanly, no leftover subprocesses observed)
- **Bridge logs are quiet**: ✓ no DIAG entries, no UUID rotation, no `pendingTruncate` (those code paths were deleted, not silenced)
- **Cache health**: ✓ 96-99% hit rates across long sessions; cache-creation events tied 1:1 to user-visible pi events (cold start, abort)

## How to run

```bash
# All unit + integration tests (existing tools + AskClaude path)
cd /Users/cartwmic/git/pi-claude-bridge
CLAUDE_BRIDGE_TESTING_ALT_MODEL="openai-codex/gpt-5.4-mini" \
CLAUDE_BRIDGE_TESTING_ALT_PROVIDER="openai-codex" \
npm test

# Tmux scenario harness (S0, S1, S7 currently)
bash scripts/run-all-scenarios.sh

# Single scenario
bash scripts/run-scenario-s0.sh
```

## Architecture invariants enforced by the new index.ts

These are the structural changes that make regressions hard:

1. **No `cc-session-io` dependency** — package.json no longer lists it. The
   bridge cannot accidentally write to `~/.claude/sessions/`.
2. **No `query-state.ts`** — the per-query state machine with `pendingToolCalls`,
   `pendingResults`, `nextHandlerIdx`, and the two-Map index-based queue is
   gone. Replaced by a single `Map<toolUseId, resolver>` per query frame.
3. **No `processAssistantMessage` fallback path** — only the
   `stream_event`-driven path remains (`includePartialMessages: true` makes
   stream events authoritative).
4. **No `syncSharedSession` Cases 1-4** — divergence is detected implicitly:
   if `cachedSessionId` is set we resume; if it's `null` (fork/restart/abort/
   compact) we cold-start.
5. **No `pendingTruncateOffset` / no UUID rotation** — abort path is
   `query.interrupt()` + drop `cachedSessionId`. That's it.
6. **No `deferredUserMessages` / continuation-query replay** — supersession
   is the architectural answer to mid-stream steering. New user message →
   interrupt active query → start fresh.
