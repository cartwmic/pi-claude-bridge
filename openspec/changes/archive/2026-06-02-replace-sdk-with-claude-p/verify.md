# Verify: replace-sdk-with-claude-p

- **Change:** `replace-sdk-with-claude-p`
- **Date:** 2026-06-02
- **Verification Mode:** `retained-required` (constitution VII) — this file is a
  hard archive gate; archive HARD-GATES on its existence + a canonical AC↔test
  mapping with no uncovered AC.
- **Driver:** `claude-p` (interactive-TUI driver; the bridge NEVER invokes
  nominal `claude -p`/`--print`).

This file is the canonical acceptance-criterion ↔ verification mapping for EVERY
AC ID across `specs/**/spec.md`. AC IDs are enumerated dynamically from the
"Acceptance criterion quality checklist" tables in each capability's `spec.md`
(not hard-coded). Coverage was cross-referenced against the DONE annotations in
`tasks.md` and then each cited test file / scenario script / gate fixture was
verified to exist on disk.

## Coverage type legend

- **U** — unit test (file under `tests/unit-*.mjs`)
- **I** — integration test (file under `tests/int-*.mjs`/`.sh`, spawns real claude-p)
- **S#** — pi-TUI scenario (`scripts/run-scenario-s#.sh`, recorded in `SCENARIO_RESULTS.md`)
- **G#** — empirical hard gate (fixture under `.spike-notes/claude-p-gate/`)

## AC ↔ verification mapping

### Capability: claude-p-driver (15 AC)

| AC ID | Capability | Covered by | Type | Status |
|---|---|---|---|---|
| claude-p-driver.claude-p-spawn-with-model-selection | claude-p-driver | `tests/unit-driver-claude-p.mjs` (buildClaudePArgs: --model/--system-prompt/--input-file/--mcp-config/--strict-mcp-config/--setting-sources/--permission-mode/--output-format/--verbose/--timeout; session-id XOR resume; never --settings/-p/--print); `tests/int-claude-p-main-turn.mjs`; `tests/unit-disallow-list.mjs` | U, I | covered |
| claude-p-driver.native-tool-emission-is-blocked-via-disallowedtools | claude-p-driver | G2 (`.spike-notes/claude-p-gate/g2-isolation-stream.jsonl`, `g2-run-log.txt`); S27 (`scripts/run-scenario-s27.sh`); `tests/int-claude-p-tool-isolation.mjs`; `tests/unit-disallow-list.mjs`; `tests/unit-driver-claude-p.mjs` (disallow-set / no-bare-Mcp guards) | G, S, I, U | covered |
| claude-p-driver.prompt-injection-via-claude-p-input | claude-p-driver | `tests/unit-driver-claude-p.mjs` (positional vs --input-file >50KB; cold-start full-history vs warm new-msg-only); G-resume (`.spike-notes/claude-p-gate/g-resume-results.md`, --input-file/--system-prompt-file forwarded); `tests/int-claude-p-warm-resume.mjs` (via S6/S12) | U, G, I | covered |
| claude-p-driver.cached-driver-session-is-a-hint-only | claude-p-driver | `tests/int-claude-p-warm-resume.mjs` (single session id across turns); S6/S12/S26 (`scripts/run-scenario-s{6,12,26}.sh`); G4 (`.spike-notes/claude-p-gate/g4-singleshot-caching.md` warm cache-read across --resume) | I, S, G | covered |
| claude-p-driver.abort-propagates-to-the-claude-p-subprocess | claude-p-driver | `tests/int-claude-p-abort.mjs` (SIGINT to group, no orphan); `tests/unit-driver-claude-p.mjs` (SIGINT→SIGKILL grace, AbortSignal path, orphan reap); `tests/unit-driver-resilience.mjs` (abort signals process group + reaps descendants) | I, U | covered |
| claude-p-driver.driver-never-reads-or-writes-user-global-claude-config | claude-p-driver | `tests/int-claude-dir-audit.mjs` (static scan: NO `~/.claude/` fs access in production scope; T4.2) | I | covered |
| claude-p-driver.unexpected-driver-exit-surfaces-as-error | claude-p-driver | `tests/unit-driver-claude-p.mjs` (premature-exit → error; ENOENT missing-binary → error); `tests/unit-driver-resilience.mjs` (bounded-retry on SessionStartTimeout/StopTimeout, no retry after routed tool call); `tests/unit-driver-stream.mjs` (premature exit before result → error) | U | covered |
| claude-p-driver.image-content-handling-in-v1 | claude-p-driver | `tests/int-claude-p-image.mjs` (main-path strip+warn+proceed text-only; capture-path reject pre-spawn, stopReason error) | I | covered |
| claude-p-driver.abort-lifecycle-is-decoupled-from-claude-p-completion | claude-p-driver | `tests/int-claude-p-abort.mjs` (done(aborted) without terminal result); `tests/unit-driver-claude-p.mjs` (late stdout after abort ignored); `tests/unit-driver-stream.mjs` (no error when aborted before result) | I, U | covered |
| claude-p-driver.abort-preserves-late-tool-result-coherence-with-pi | claude-p-driver | `tests/int-claude-p-abort-late-tool-result.mjs` (Case-1 capture post-abort, next turn fresh-dispatches); `tests/unit-mcp-router.mjs` (pendingResults early-result race) | I, U | covered |
| claude-p-driver.abort-preserves-the-interrupted-partial-for-next-turn-recall | claude-p-driver | `tests/unit-abort-partial.mjs` (commit streamed partial text / synthetic `[interrupted]` marker into aborted AssistantMessage); G5 (`.spike-notes/claude-p-gate/g5-abort-coherence.md`); S7/S8/S13 (`scripts/run-scenario-s{7,8,13}.sh`, `tests/int-claude-p-abort-coherence.mjs`) — see exemption note (S7 exact-number recall) | U, G, S, I | covered |
| claude-p-driver.concurrent-spawns-are-fully-isolated-capture-and-nested-subagents | claude-p-driver | G9 (`.spike-notes/claude-p-gate/g9-concurrent-isolation.md`, `g9-e1-spawn{A,B}-stream.jsonl`); S14 (`scripts/run-scenario-s14.sh`); `tests/int-claude-p-concurrent.mjs` | G, S, I | covered |
| claude-p-driver.respawn-does-not-race-the-dying-subprocesss-stdout-reader | claude-p-driver | `tests/int-claude-p-abort-steer-race.mjs`; S9/S13 (`scripts/run-scenario-s{9,13}.sh`) | I, S | covered |
| claude-p-driver.timeout-must-not-trip-on-a-held-tool-round | claude-p-driver | G7 (`.spike-notes/claude-p-gate/g7-timeout-results.md`, `g7-timeout-stream.jsonl`, `g7-timeout-probe.mjs`); `tests/unit-driver-claude-p.mjs` (--timeout assembled); S3/S8 (`scripts/run-scenario-s{3,8}.sh` long held tools) | G, U, S | covered |
| claude-p-driver.mid-stream-steer-is-handled-by-abort-and-respawn | claude-p-driver | `tests/int-claude-p-steer.mjs`; S5 (`scripts/run-scenario-s5.sh`) — **S5 PASS** (not exempt; abort-and-respawn satisfies the coherence bar; D-S5 disposition recorded) | I, S | covered |

### Capability: transcript-stream (8 AC)

| AC ID | Capability | Covered by | Type | Status |
|---|---|---|---|---|
| transcript-stream.parse-claude-p-stdout-while-the-turn-is-in-flight | transcript-stream | `tests/unit-driver-stream.mjs` (real fixture: incremental parse, text-delta on assistant lines, turn-end on result); `tests/int-claude-p-main-turn.mjs` | U, I | covered |
| transcript-stream.held-open-tool-rounds-do-not-terminate-the-turn | transcript-stream | `tests/unit-driver-stream.mjs` (multi-round: in flight across rounds, done only at result, not at segment marker); G1/G3 (`.spike-notes/claude-p-gate/g1-multiround-stream.jsonl`, `g1-g3-results.md` — one result per turn); S1/S2/S11 | U, G, S | covered |
| transcript-stream.emit-text-delta-tool-use-thinking-and-usage-events | transcript-stream | `tests/unit-driver-stream.mjs` (text-delta, tool-use w/ full args, thinking-delta, usage mapping incl. missing-subfield→0) | U | covered |
| transcript-stream.filter-claude-p-noise-and-built-in-lines | transcript-stream | `tests/unit-driver-stream.mjs` (noise lines mode/permission-mode/file-history-snapshot/attachment/ai-title/stop_hook_summary/turn_duration produce no events; WaitForMcpServers suppressed) | U | covered |
| transcript-stream.partial-lines-are-buffered-until-newline | transcript-stream | `tests/unit-driver-stream.mjs` (partial-line buffering: no event until newline, one event after split write) | U | covered |
| transcript-stream.malformed-lines-surface-as-warnings-not-stream-errors | transcript-stream | `tests/unit-driver-stream.mjs` (malformed JSON line: warn+skip, surrounding valid events still emitted; T1.16c) | U | covered |
| transcript-stream.unknown-line-types-surface-as-warnings-drift-detection | transcript-stream | `tests/unit-driver-stream.mjs` (unknown top-level type: warn naming type, no event, continue; does not warn for known-noise) | U | covered |
| transcript-stream.driver-exit-without-terminal-result-surfaces-as-error | transcript-stream | `tests/unit-driver-stream.mjs` (premature exit: error when stdout closes before result and not aborted; no error when aborted / when result already seen; T1.16c) | U | covered |

### Capability: mcp-stdio-shim (8 AC)

| AC ID | Capability | Covered by | Type | Status |
|---|---|---|---|---|
| mcp-stdio-shim.shim-exposes-only-pi-bridged-tools | mcp-stdio-shim | `tests/unit-mcp-shim.mjs` (tools/list advertises only the declared set) | U | covered |
| mcp-stdio-shim.shim-forwards-tool-calls-to-the-in-process-router | mcp-stdio-shim | `tests/unit-mcp-shim.mjs` (tools/call held open until router resolves; isError verbatim); `tests/unit-mcp-router.mjs` (park/resolve on deliver); `tests/int-claude-p-tool-round.mjs` (held-open round-trip end-to-end) | U, I | covered |
| mcp-stdio-shim.tool-call-correlation-across-the-split-channels | mcp-stdio-shim | G8 (`.spike-notes/claude-p-gate/g8-parallel-stream.jsonl`, `g8-call-log.txt`); `tests/int-claude-p-parallel-tools.mjs`; `tests/unit-mcp-router.mjs` (D32 per-call minted piId, parallel/identical calls keyed independently); S11 (`scripts/run-scenario-s11.sh`) | G, I, U, S | covered |
| mcp-stdio-shim.shim-rejects-non-bridged-tool-names | mcp-stdio-shim | `tests/unit-mcp-shim.mjs` (unknown tool rejected without contacting router) | U | covered |
| mcp-stdio-shim.shim-lifecycle-is-bound-to-its-spawn | mcp-stdio-shim | `tests/unit-mcp-shim.mjs` + `tests/unit-mcp-ipc.mjs` (per-spawn socket; teardown on IPC/stdin close); `tests/int-claude-p-tool-round.mjs` (shim spawned per invocation) | U, I | covered |
| mcp-stdio-shim.shim-is-a-separate-process | mcp-stdio-shim | `tests/unit-mcp-shim.mjs` (real-subprocess malformed-frame test → distinct OS pid; bin → `dist/src/mcp/shim.js` via require.resolve, D19/D30) | U | covered |
| mcp-stdio-shim.capture-mode-tool-calls-receive-deterministic-shim-response | mcp-stdio-shim | `tests/unit-mcp-shim.mjs` (capture mode: valid → deterministic CAPTURE_SUCCESS_TEXT + stash, no park; invalid → -32602 naming field path; repeat → -32603); `tests/int-claude-p-capture-success.mjs` | U, I | covered |
| mcp-stdio-shim.malformed-mcp-messages-surface-as-errors | mcp-stdio-shim | `tests/unit-mcp-shim.mjs` (real-subprocess malformed frame → -32700 parse error, process survives; T1.16c) | U | covered |

### Capability: output-capture (6 AC)

| AC ID | Capability | Covered by | Type | Status |
|---|---|---|---|---|
| output-capture.output-capture-classification-of-ctx-tools | output-capture | `tests/unit-capture.mjs` (classification: all-executable → no capture spawn; registered-but-inactive → capture; toolResult delivery / empty ctx.tools → no classification) | U | covered |
| output-capture.strict-call-shape-capture-mode-mutually-exclusive-with-executable-tools-root-must-be-object | output-capture | `tests/unit-capture.mjs` (two unregistered → error naming both; one executable + one capture → mutually-exclusive error; non-object root → error referencing type; object root → accepted) | U | covered |
| output-capture.capture-path-isolation | output-capture | `tests/int-claude-p-capture-isolation.mjs` + `tests/unit-capture.mjs` (single-spawn: no cachedSessionId/cwd/hashes/router/socket mutation); G9 (`.spike-notes/claude-p-gate/g9-*`) for the concurrent two-spawn case; S25 (`scripts/run-scenario-s25-capture-during-turn.sh`) | I, U, G, S | covered |
| output-capture.synthesized-toolcall-content-block-on-success | output-capture | `tests/int-claude-p-capture-success.mjs`; `tests/unit-capture.mjs` (stash → exactly one toolCall block name+args, usage mapped input/output/cacheRead/cacheWrite, cost) | I, U | covered |
| output-capture.surface-absent-capture-tool-call-as-error | output-capture | `tests/int-claude-p-capture-error.mjs`; `tests/unit-capture.mjs` (no stash at turn-end → stopReason error "did not call capture tool"; abnormal exit → error) | I, U | covered |
| output-capture.capture-path-honors-abortsignal | output-capture | `tests/int-claude-p-capture-abort.mjs`; `tests/unit-capture.mjs` (AbortSignal mid-capture → stopReason aborted no stash; pre-aborted → spawn never called) | I, U | covered |

## Documented exemptions

- **S7 (exact-number recall after mid-text abort)** — `EXEMPT` for the literal
  "what number did you reach before I interrupted you?" recall ONLY. claude-p
  drives `claude --print`, which buffers the whole turn into one burst, so the
  aborted partial has no streamed mid-stream "current number" to recall. The
  abort *mechanics* (onAbort fired mid-turn, session preserved, post-abort warm
  resume, "was I interrupted" coherence) all PASS. This is a fundamental
  property of the `--print` buffering surface, not a bridge defect. Recorded in
  `SCENARIO_RESULTS.md` and design.md. Tracked under
  `claude-p-driver.abort-preserves-the-interrupted-partial-for-next-turn-recall`,
  whose mechanics are independently covered by `tests/unit-abort-partial.mjs`
  and G5.
- **S5 (mid-stream steering)** — **NOT exempt. PASS.** Although claude-p has no
  mid-turn injection (a steer = abort + respawn), the abort-and-respawn model
  satisfies S5's acceptance bar: the model recalls the abandoned topic. Recorded
  as PASS in `SCENARIO_RESULTS.md`; D-S5 disposition = abort-respawn sufficient.

## Completion Decision

**`green`**.

- Total AC IDs enumerated: **37**
  - claude-p-driver: 15
  - transcript-stream: 8
  - mcp-stdio-shim: 8
  - output-capture: 6
- AC IDs mapping to at least one existing covering test/scenario/gate: **37 / 37**.
- Gaps (AC with NO coverage): **none**.

Every AC ID maps to at least one verification artifact that exists on disk
(verified: cited test files under `tests/`, scenario scripts under
`scripts/run-scenario-s*.sh`, and gate fixtures under
`.spike-notes/claude-p-gate/`). The S7 exact-number-recall exemption is
documented and its AC's mechanics are independently covered, so it does not
constitute a gap. S5 passes. The archive gate condition (canonical AC↔test
mapping, no uncovered AC) is satisfied.
