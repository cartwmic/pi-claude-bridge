# Round 3 — Reviewer A (claude-bridge/claude-opus-4-7)

## Verdict

**needs revision** — Three internal contradictions and one unverified flag dependency block confident execution; the rest is solid and one or two days of edits away from approve.

## Findings

### [P1] PreToolUse hook contradicted between proposal/spec and design

- **Where:**
  - `proposal.md:12` — "hook handlers (`SessionStart`, `Stop`, `PreToolUse`)"
  - `design.md:194-216` D9 — "**`PreToolUse` was originally in this set but dropped per Round-2 review**"
  - `design.md:218-237` D11 — "**`PreToolUse` hook DROPPED**"
  - `specs/claude-tui-driver/spec.md:21` — scenario asserts "the spawned arguments include `--settings` carrying inline hook handlers for `SessionStart`, `Stop`, and `PreToolUse`"
  - `specs/claude-tui-driver/spec.md:113-117` — full requirement "Hook-relay subprocess is the bridge's hook IPC channel" lists "(`SessionStart`, `Stop`, `PreToolUse`)" as the three hooks the driver registers
  - `specs/claude-tui-driver/spec.md:131-138` — scenario "PreToolUse hook observes non-bridged tool emission" is asserted as a documented behavior
  - `tasks.md` T1.7 — implements hook-relay for `SessionStart`/`Stop`/`PreToolUse` (per `plan.md` step 7)
- **Issue:** Design.md explicitly drops PreToolUse on cost/value grounds (Round-2 A.P2#4) and even forbids it implicitly (D11's observability replacement is the shim's `tools/call` log). The proposal, the claude-tui-driver spec, and the implementation plan all still register it. Pick one. The scenarios in `specs/claude-tui-driver/spec.md:131-138` assert behavior that the design forbids.
- **Impact:** Implementer will hit conflicting acceptance criteria during Phase 1. Either the wrong code gets written (PreToolUse registered, contradicting D9/D11) or correct code is written and a spec scenario remains untestable. Verify gate (Verification Mode = retained-required) will fail because no test can satisfy the asserted PreToolUse scenario without violating the design.
- **Fix direction:** Strip PreToolUse from `proposal.md:12`, from the `Fresh turn spawns one PTY…` scenario in spec.md, from the "Hook-relay subprocess is the bridge's hook IPC channel" requirement body, from its dedicated scenario, and from `tasks.md` T1.7 description + `plan.md` step 7 enumerations. Restate D9's hook set as `SessionStart` + `Stop` + `SessionEnd` (per design.md:200) consistently in all artifacts.

### [P1] Transcript-stream spec asserts behavior gated on a BLOCKING Phase 0 spike

- **Where:**
  - `specs/transcript-stream/spec.md:1-8` preamble — "The transcript path is delivered to the bridge via the `Stop` hook payload contract, and the tailer begins reading earlier (immediately after `SessionStart`) by deriving the path from the same payload."
  - `specs/transcript-stream/spec.md:14` — "WHEN the driver's `SessionStart` hook fires and provides a `transcript_path`"
  - `specs/transcript-stream/spec.md:18-21` — scenario "WHEN `SessionStart` reports a transcript path"
  - `design.md` OQ7 / `tasks.md` T0.12 — "**BLOCKING** — verify `SessionStart` hook payload contains `transcript_path` in interactive mode. If only `Stop` carries it, document the directory-listing-snapshot fallback design + delta to `design.md`."
- **Issue:** The spec asserts as a normative WHEN/SHALL that `SessionStart` carries `transcript_path` — but per design.md the proposal authors explicitly do not yet know whether that's true in interactive mode, and the fallback design (pre-spawn directory snapshot + mtime-based identification post-spawn) is materially different (different IPC contract, different race window). Specs encode unverified hypotheses; if T0.12 returns "Stop only", every transcript-stream AC needs rewriting before Phase 1 can start, but the schema treats specs as the source of truth for downstream artifacts.
- **Impact:** Verify gate would treat the SessionStart wording as canonical. If T0.12 finds otherwise, plan step 1 (T0.9) must rewrite the spec — but `tasks.md` T0.9 lists `files_allowed: [design.md, analyze.md]`, NOT `specs/**/spec.md`. The plan therefore lacks permission to fix the spec when the spike says it must be fixed.
- **Fix direction:** Either (a) phrase the AC defensively, e.g., "WHEN the driver receives a hook payload whose `transcript_path` field is the active turn's transcript (delivered via `SessionStart` if present, else discovered per the design.md transcript-discovery fallback), THE transcript stream SHALL…", and document both branches as design alternatives; OR (b) add `openspec/changes/replace-sdk-with-pty-tui/specs/**/spec.md` to T0.9's `files_allowed` AND mark plan step 2 (worktree + deps) as blocked on T0.9's spec-update branch when T0.12 is negative. (a) is preferable because it makes the spec stable across either outcome.

### [P1] Argv-overflow fallback path is not actually viable in interactive mode

- **Where:**
  - `specs/claude-tui-driver/spec.md:53-55` — "IF the assembled positional argument exceeds an implementation-defined size threshold… THE driver SHALL fall back to a temp-file path: write the prompt to a unique file under `os.tmpdir()`, pass that file to `claude` via the documented `--input-format` + stdin pipe path (or another bounded mechanism Phase 0 spike T0.11 identifies)"
  - `design.md:R15` — "the driver writes the prompt to a temp file in `os.tmpdir()` and passes it to `claude` via a stdin-driven `--input-format` path"
  - Ground truth from `claude --help`: "`--input-format <format>  Input format (only works with --print)`"
- **Issue:** `--input-format` is explicitly `--print`-only per the binary's own help text. The same applies to `--no-session-persistence`, `--include-hook-events`, `--include-partial-messages`, `--max-budget-usd`, `--fallback-model`. The argv-overflow fallback names a mechanism that the binary refuses to honor in the mode the bridge actually uses. The "(or another bounded mechanism Phase 0 spike T0.11 identifies)" hedge admits no concrete fallback exists.
- **Impact:** Long-history cold-starts (R15 medium-likelihood) will hit argv ceilings on macOS (~256 KB) with no working escape hatch. The spec mandates a fallback that the binary will reject; the implementer will either ship a stubbed-out branch that raises `error` (which is the only honest option but is what the spec already covers via the final "IF neither argv nor the fallback path can carry the prompt" clause), or attempt `--input-format` and get a runtime rejection.
- **Fix direction:** Either (a) drop the `--input-format` mention from the spec text and reword the fallback as "an implementation-defined bounded mechanism if Phase 0 T0.11 identifies one; otherwise resolve with `stopReason: "error"` per constitution VII"; or (b) re-scope T0.11 to identify a genuinely interactive-mode-compatible carry mechanism (e.g., `--add-dir` with a context file referenced via the system prompt, or splitting the cold-start replay across `--system-prompt` + positional, or accepting that long histories require a separate "compact" path). Whichever, do not name `--input-format` as the answer when `claude --help` says it isn't.

### [P2] `--setting-sources ""` syntax is unverified and `claude --help` does not document empty-string acceptance

- **Where:**
  - `claude --help`: `--setting-sources <sources>  Comma-separated list of setting sources to load (user, project, local).`
  - `proposal.md:12`, `design.md:50`, `design.md:67-68` — relies on `--setting-sources ""`
  - `design.md:228-232` D11 layer #2 — acknowledges as Phase 0 risk with HOME-override fallback
  - `tasks.md` T0.7 — "if `""` is rejected/silently-ignored, design the per-PTY `HOME=<scratch>` fallback"
  - `specs/claude-tui-driver/spec.md:32-34` — "THEN the spawned `claude` still blocks `Bash` (because `--setting-sources ""` excludes user settings)"
- **Issue:** Same pattern as P1#2 above: spec asserts as fact a flag-syntax behavior that the design acknowledges as a deferred spike. `claude --help` describes valid values as `user, project, local` — empty string is undocumented. Commander.js (claude's CLI lib) often treats empty-string `<arg>` as either "argument required" error or as the literal empty string with library-specific handling. Either way, the scenario asserts the spec writes the conclusion before the experiment.
- **Impact:** If T0.7 finds `""` is rejected or silently ignored, the spec scenario in `claude-tui-driver.pty-spawn-with-model-selection`'s "User-global `permissions.allow` cannot re-enable a disallowed tool" needs amending to reference the HOME-override fallback. Same `files_allowed` problem as P1#2 — T0.9 cannot edit specs.
- **Fix direction:** Reword the spec scenarios in `specs/claude-tui-driver/spec.md:28-34` to assert the isolation outcome ("the spawned `claude` still blocks `Bash`") without naming the specific flag mechanism. Keep the flag-name commitment in design.md only. Add `specs/**/spec.md` to T0.9's `files_allowed` for the case where flag rotation does require a spec edit.

### [P2] Directory-snapshot transcript-discovery fallback has a real race with concurrent user `claude` invocations

- **Where:**
  - `design.md` OQ7 fallback — "snapshot `~/.claude/projects/<encoded-cwd>/` listing pre-spawn, identify the newly-created file post-spawn via mtime"
  - `tasks.md` T0.12 — same wording
- **Issue:** The bridge runs in the user's actual cwd. Per constitution III the user may be running their own `claude` interactively in the same project at the same time. If the user's `claude` and the bridge's `claude` produce new transcript files in the same `~/.claude/projects/<encoded-cwd>/` directory within the snapshot window, mtime-based identification cannot reliably attribute the new file to the bridge's spawn. The bridge could tail the user's transcript by mistake, which would conflate two sessions and surface bizarre behavior on either side. R10 mentions socket collision but not this directory-listing race.
- **Impact:** If T0.12 fails, the documented fallback has a known correctness gap in exactly the scenario the constitution explicitly anticipates ("safe to run alongside the user's own `claude` usage"). Severity is Medium because the race window is small and the bridge has no current code path that exercises this — but the fallback is a real possible Phase 0 outcome.
- **Fix direction:** Strengthen the fallback specification: (a) require capturing the spawned `claude`'s pid and matching against `~/.claude/sessions/<pid>.json` to discover the session id, then resolve the transcript path deterministically rather than mtime-guessing; (b) fail loudly if multiple new transcripts appear in the snapshot window. Document at least one of these in design.md before relying on the fallback. Add risk row R-NEW for the race.

### [P2] T4.7 `claude --version` runtime check spawns a process per extension load

- **Where:**
  - `tasks.md` T4.7 — "Add a runtime check in `src/driver/pty.ts` that reads `claude --version` at bridge init and logs a warn-level entry if outside the tested range pinned in README"
  - `plan.md` step 15 step 9 — same
- **Issue:** "At bridge init" means every time pi loads the claude-bridge extension. Spawning a child process and parsing its output on every extension load adds 30-100ms to pi startup and creates a hard dependency on `claude` being on `$PATH` at load time (a state that R9 says is itself a `stopReason: "error"` condition, not a load-time abort). If `claude` is missing at load, this check has to decide between failing-load (bridge becomes unloadable, even for capture-only flows or for a user who wants to inspect logs without inference) and silent-warn (defeats the check). Neither is great.
- **Impact:** Increased startup latency and a non-obvious failure mode if `claude` is missing or slow to spawn at load. Constitution VII says failures surface — at load time, surfacing means "extension does not load", which is a stronger statement than R9's per-turn surface-on-failure.
- **Fix direction:** Defer the version check to first PTY spawn rather than bridge init. Cache the result in the bridge process. Move from "log warn at init" to "log warn on first turn if outside range; do not block load when `claude` is missing — let the first turn surface the error per R9".

### [P2] Hook subprocess response format is asserted but not Phase-0-verified

- **Where:**
  - `design.md:251` D12 — "writes the response to its stdout (in the JSON format `claude` expects for hook output — e.g., for `SessionStart` a `hookSpecificOutput.additionalContext` or empty object; for `PreToolUse` a permission verdict)"
  - `specs/claude-tui-driver/spec.md:121` — "write any required response (e.g. `hookSpecificOutput.additionalContext` for `SessionStart`)"
  - `tasks.md` T0.3 — "register a `Stop` hook capturing the payload" — only inspects payload, not the expected RESPONSE shape
- **Issue:** D12 asserts hook subprocesses must write a specific JSON response shape to stdout. No spike task verifies what `claude` actually requires the hook subprocess to write back (vs. what it accepts as "no response needed"). The `hookSpecificOutput.additionalContext` form is named only as an example. The constitution requires hook contract stability assumptions to be explicit.
- **Impact:** If the hook subprocess's stdout shape is wrong (or expected to be absent), `claude` may either silently ignore it or treat it as a `denied` permission verdict, both of which would surface as cryptic mid-turn behavior.
- **Fix direction:** Add a Phase 0 task (T0.3b or extend T0.3) explicitly verifying the hook subprocess RESPONSE shape `claude` expects for each registered hook (`SessionStart`, `Stop`, `SessionEnd`). Pin the answer in design.md D12 with a concrete schema.

### [P2] Capture-mode termination relies on English instruction to model; no concrete SLA

- **Where:**
  - `design.md` D16 — shim returns `{ "content": [{ "type": "text", "text": "Capture received. End your turn now." }] }`
  - `design.md` R17 — "model ignores capture-mode's 'end your turn now' English instruction"
  - `tasks.md` T4.8 — "Capture-mode termination latency benchmark: measure tokens emitted post-tool-call across N capture runs; surface median + p99 in CI output; alert if median diverges materially from 'end_turn immediately after first call'"
- **Issue:** "Materially" is undefined. The benchmark exists but has no pass/fail threshold. The whole capture path's termination guarantee is a model-instruction-following guarantee, which is fundamentally less robust than the SDK's `outputFormat` mechanism that this design replaces.
- **Impact:** No hard guarantee that capture mode terminates promptly. A future model regression could silently inflate capture-mode cost without tripping a CI gate.
- **Fix direction:** Either (a) define a concrete threshold (e.g., "median ≤ 50 tokens post first-valid call; p99 ≤ 200 tokens; CI fails if exceeded") in design.md and T4.8; or (b) prefer the `--json-schema` alternative (per D5 alternatives) if T0.10 confirms interactive-mode availability — it shifts enforcement back to a protocol layer instead of English instructions. D5's rejection rationale ("reuses the SDK trust-surface concern") is weak: `--json-schema` is a CLI flag of the same `claude` binary the design is otherwise committing to, not the SDK.

### [P2] Constitution III audit attribution heuristic is fuzzy

- **Where:**
  - `tasks.md` T4.2 — "snapshots `~/.claude/` pre-test and asserts no new BRIDGE-ATTRIBUTABLE file post-test (transcript files written by `claude` itself under `~/.claude/projects/` are allowed; the assertion targets only files the bridge would have written: anything in `~/.claude/sessions/`, `~/.claude/settings.json`, etc.)"
- **Issue:** The audit relies on the bridge being able to distinguish writes-by-bridge-spawned-`claude` from writes-by-user-spawned-`claude`. Practically the test just checks that no file appears in `~/.claude/sessions/` or `~/.claude/settings.json`. But the user's own `claude` spawned during the test would also write to `~/.claude/sessions/<pid>.json`, which the audit would flag as a bridge violation falsely.
- **Impact:** Flaky test or false-negative coverage. The check name promises more than the implementation can deliver.
- **Fix direction:** Tighten the check to enumerate by pid: only flag `~/.claude/sessions/<pid>.json` whose `<pid>` matches a bridge-spawned `claude` process. The bridge has the pid in hand from PTY spawn, so this is feasible. Or, narrow the audit to a hermetic environment where no other `claude` is running.

### [P3] T0.2 ordering inside plan step 1 (not blocking)

- **Where:** `plan.md` step 1 lists "1. T0.1 … 2. (jump to T0.2 missing in numbering — exists in `tasks.md:23` but is item #3 in plan step 1's narrative under T0.2)"
- **Issue:** Plan step 1's narrative is numbered 1, 2, 3, …, 11, 12, 13 but T0.2 appears between T0.1 and T0.3 only in `tasks.md`, not in plan.md's body which jumps from "1. T0.1 — …" to "3. T0.3 — …" with no T0.2 line. Confirmed by reading `plan.md` lines 13-27.
- **Impact:** Minor — implementer following `tasks.md` will hit T0.2 anyway; reader following `plan.md` will not see the thinking-blocks spike enumerated.
- **Fix direction:** Add the T0.2 line ("invoke claude with a thinking-eligible model + reasoning effort; tail transcript; record whether thinking blocks appear and their JSON shape") to plan.md step 1 between item 1 and item 3 to restore parity with `tasks.md`.

### [P3] Spec AC quality checklists all unchecked

- **Where:** Bottom of each `specs/*/spec.md` file — every Testable/Solution-free/Unambiguous/Consistent/Complete checkbox is empty.
- **Impact:** Indicates either the checklists have not been reviewed, or they have but the checkmarks weren't transcribed. Either way, downstream verification cannot tell.
- **Fix direction:** Either fill them or remove the table form — partial-empty is worse than absent.

### [P3] `--allowedTools` vs `permissions.deny` not pinned

- **Where:** `specs/claude-tui-driver/spec.md:42` — "the allow set, if expressed, includes only `mcp__custom-tools__*`". Design.md D11 uses `permissions.deny` only.
- **Impact:** Implementer has to choose between `--allowedTools "mcp__custom-tools__*"` (CLI flag, narrows positively) and `permissions.deny: ["Bash", "Read", …]` (settings, negates). Belt-and-suspenders is also possible. Spec's phrasing ("if expressed") is ambiguous about whether to express it.
- **Fix direction:** Pin in design.md D11 the canonical mechanism (probably both for defense-in-depth: `--allowedTools` positive list + `permissions.deny` negative list). State explicitly in the spec how the allow expression is structured.

## Challenged Assumptions

1. **Assumption:** `SessionStart` hook payload contains `transcript_path` in interactive mode. (`design.md` OQ7 / spec asserts as fact)
   **Challenge:** The hook contract is documented for `-p` mode where `--include-hook-events` controls stream-json hook output. Interactive-mode hook payload shape is less documented. T0.12 is correctly marked BLOCKING but the spec preceded the spike.

2. **Assumption:** `--setting-sources ""` is honored as "load nothing".
   **Challenge:** `claude --help` documents valid values as `user, project, local`. Empty-string handling is library-implementation-defined. Design correctly hedges with HOME-override fallback but spec wording does not.

3. **Assumption:** Capture-mode termination via English instruction in the deterministic MCP response is reliable enough.
   **Challenge:** This regresses from SDK `outputFormat`'s protocol-level termination to a model-instruction-following dependency. The alternative — native `--json-schema` — is rejected on weak grounds (D5 alternative #1: "reuses the SDK trust-surface concern"). `--json-schema` is a CLI flag on the same `claude` binary the design commits to, not the SDK package; the trust-surface argument doesn't actually apply.

4. **Assumption:** The argv-overflow fallback can use `--input-format` + stdin.
   **Challenge:** `claude --help` says `--input-format` only works with `--print`. Not viable in interactive mode. The fallback as written is a dead path.

5. **Assumption:** Per-block streaming via transcript JSONL tail is "sufficient for pi's UX" without measurement (`design.md` D4).
   **Challenge:** Worth a single user-experience datapoint before locking in. The SDK's per-token streaming was a deliberate UX choice; flipping it without a side-by-side comparison is taking on UX debt sight-unseen.

6. **Assumption:** Three per-turn hook subprocess fork/exec invocations (`SessionStart`, `Stop`, `SessionEnd`) at 50-100ms each are acceptable overhead (R12).
   **Challenge:** Combined with PTY boot (~1-3s, R2), the per-turn fixed cost on the main path is 1.15-3.3s before any inference. For capture mode invoked many times per skill execution, this compounds. Worth measuring vs the SDK baseline (which is ~50-200ms per call) before declaring acceptable.

## Stronger Alternatives

1. **Capture path: re-evaluate `--json-schema` as primary.** If T0.10 confirms interactive-mode availability, `--json-schema` is strictly more robust than the forced-MCP-tool-call pattern (protocol-level enforcement at the `claude` boundary, no English instruction reliance, no shim deterministic-response gymnastics). The "SDK trust-surface" argument in D5's rejection is misapplied — it's a `claude` CLI flag, not an SDK API. Make T0.10's positive result a path to switch D5 in a follow-up; or even in this change.

2. **Transcript discovery: skip the hook path entirely.** If the bridge constructs a deterministic `--session-id <uuid>` per spawn (the flag exists per `claude --help`: `--session-id <uuid>  Use a specific session ID for the conversation (must be a valid UUID)`), the transcript path is fully derivable from `(cwd, sessionId)` without needing any hook payload. This sidesteps OQ7 entirely. It also makes the cache invariant (D1 cache hint) trivially symmetric with the spawned session. Worth a Phase 0 spike alongside T0.12.

3. **Argv overflow: chunk via `--system-prompt` rather than positional.** History compaction into the system prompt is messy semantically but trivially carries 100KB+ of text via the documented `--system-prompt` flag without the argv ceiling problem. Constitution V's "verbatim" requirement applies only to the capture path; the main path can compose freely. This is a real interactive-mode-compatible fallback that the current design does not consider.

4. **Hook IPC: drop the hook subprocess entirely if `--session-id` is adopted.** With deterministic session id, the bridge no longer needs `SessionStart` for transcript-path discovery. `Stop` could be replaced by watching PTY exit + a final transcript drain. This eliminates D9, D12, and the dual-mode shim binary — leaving only the stdio MCP shim. Substantial simplification at the cost of one Phase 0 spike + spec rewrite.

## Open Questions

- **OQ-A:** What is the concrete capture-mode termination SLA (median tokens post first valid call)? T4.8 measures but defines no threshold.
- **OQ-B:** What is `claude`'s exact hook subprocess RESPONSE format requirement per registered hook event? T0.3 covers payload but not response shape.
- **OQ-C:** Does `--session-id <uuid>` allow the bridge to construct the transcript path deterministically without any hook payload? (Stronger alternative #2 above.)
- **OQ-D:** Is `--system-prompt` size-bounded in any way `claude` enforces, vs. `[prompt]` positional? (Argv overflow alternative.)
- **OQ-E:** What attribution mechanism does the constitution-III audit (T4.2) use to distinguish bridge-spawned `claude` from user-spawned `claude` writes to `~/.claude/sessions/`?

## Minimal Revision Checklist

- [ ] **P1.1** Strip PreToolUse from `proposal.md:12`, `specs/claude-tui-driver/spec.md:21,113-138`, `tasks.md` T1.7, `plan.md` step 7 — replace with `SessionStart` + `Stop` + `SessionEnd` consistent with D9/D11.
- [ ] **P1.2** Reword `specs/transcript-stream/spec.md` preamble + first AC + first scenario to phrase transcript-path discovery as "via the hook payload contract OR per the design.md transcript-discovery mechanism" — defer the specific hook name to design.md.
- [ ] **P1.3** Remove `--input-format` from `specs/claude-tui-driver/spec.md:53-55` argv-overflow fallback. Replace with "an implementation-defined bounded mechanism if Phase 0 T0.11 identifies one; otherwise resolve with `stopReason: error`". Re-scope T0.11 to consider `--system-prompt`-based or `--add-dir`-based carries (Stronger Alternative #3).
- [ ] **P2.1** Reword `specs/claude-tui-driver/spec.md:28-34` scenarios to assert outcome without naming `--setting-sources ""`. Add `openspec/changes/replace-sdk-with-pty-tui/specs/**/spec.md` to T0.9's `files_allowed`.
- [ ] **P2.2** Strengthen `design.md` transcript-discovery fallback for OQ7-negative case: pid-keyed transcript identification rather than mtime-based. Add R-NEW (concurrent user-claude transcript race) to risk table.
- [ ] **P2.3** Move T4.7 `claude --version` check from "bridge init" to "first PTY spawn".
- [ ] **P2.4** Add T0.3 sub-task (or T0.3b) verifying hook subprocess RESPONSE format per hook event; pin in D12.
- [ ] **P2.5** Set concrete capture-mode termination SLA (median + p99 token thresholds) in `design.md` D16/R17 and T4.8.
- [ ] **P2.6** Tighten T4.2 directory-diff to pid-keyed attribution.
- [ ] **P3.1** Add T0.2 entry to plan.md step 1 narrative.
- [ ] **P3.2** Either fill spec AC quality checklists or remove the tables.
- [ ] **P3.3** Pin `--allowedTools` vs `permissions.deny` mechanism in D11; reflect in `specs/claude-tui-driver/spec.md:42`.

(Optional but recommended) Phase 0 spike additions:
- **T0.13** Verify `--session-id <uuid>` allows deterministic transcript path construction. If yes, evaluate dropping hook-based discovery entirely (Stronger Alternative #2).
- **T0.14** Compare `claude` argv vs `--system-prompt` size limits empirically (Stronger Alternative #3).
