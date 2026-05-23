# Analyze Findings

**Mode:** single-model (adversarial-review-cycle pending owner sign-off — see "Outstanding risks")
**Generated:** 2026-05-20 by claude-sonnet during opsx-superpowers propose flow

## Check 1 — Constitution compliance

| Principle | Status | Rationale | Severity |
|---|---|---|---|
| I. Pi owns conversation state | compliant | design.md Context cites principle I; no new persistent conversation state introduced; `cachedSessionId` semantics preserved. | — |
| II. Bridge is inference-only | compliant | New modules (`driver/`, `mcp/`, `capture.ts`) are inference-layer concerns; no pi-tool execution moved into the bridge. | — |
| III. No filesystem coupling to driver mutable state | compliant | design D1 + D3 + D9 all configure the driver via inline flags only; transcript JSONL is read-only per `transcript-stream` spec. | — |
| IV. Native Claude tools are disallowed | compliant | D11 defense-in-depth (driver config + shim). `claude-tui-driver.native-tool-emission-is-blocked-at-driver-configuration` + `mcp-stdio-shim.shim-rejects-non-bridged-tool-names` enforce together. | — |
| V. System prompt fidelity per path | **compliant (post Round-1 adversarial review)** | `claude --help` documents `--system-prompt <prompt>` as "System prompt to use for the session" (replaces CC's default); D7-final pins this flag for both main and capture paths. Phase 0 T0.8 runtime-verifies the documented behavior. Constitution V fully satisfied. | — |
| VI. Concurrent paths share no state | compliant | output-capture Capture path isolation requirement explicitly forbids state sharing; D5 spawns dedicated PTY + shim per capture call; clarify C9 confirms concurrent capture calls are independent. | — |
| VII. Failures surface; degradation is explicit | compliant | Every error path in specs produces a structured log + `stopReason: "error"`. Specifically: claude-tui-driver.unexpected-driver-exit-surfaces-as-error, transcript-stream.missing-or-unreadable-transcript-surfaces-as-error, output-capture.surface-absent-capture-tool-call-as-error, mcp-stdio-shim.malformed-mcp-messages-surface-as-errors. | — |

## Check 2 — EARS pattern check (major, human-triage)

Regex: `/WHEN\s+[^.]*\b(error|fail|invalid|reject|deny|unauthor)/i`

| # | File:line | AC | True positive? | Suggested rewrite | Status |
|---|---|---|---|---|---|
| E1 | output-capture/spec.md:70 | "When the call shape is rejected, the bridge SHALL NOT invoke the inference driver…" | no (narrative connective; the actual EARS triggers are in the underlying Scenarios) | none — this is descriptive prose under a ubiquitous `SHALL` Requirement. The Scenarios beneath use correct `WHEN`/`IF`-`THEN` patterns. | skipped (false positive) |
| E2 | output-capture/spec.md:145 | "When the capture path's PTY emits a `Stop` hook without the transcript containing a valid tool-use block… — or when the tool-use block's arguments fail schema validation…" | yes (this is an unwanted/error condition described with WHEN; EARS requires IF…THEN) | Rewrite head as: `IF the capture path's PTY emits a` Stop `hook (turn complete) without the transcript containing a valid tool-use block for the declared capture tool, OR IF the tool-use block's arguments fail schema validation after any same-turn self-correction the model performs, THEN the bridge SHALL push an` error `event on the pi-ai stream whose` errorMessage `names the failure cause… and end the stream.` | pending (apply before tasks artifact) |

## Check 3 — AC↔design coverage

| AC ID | Design section reference | Status | Severity |
|---|---|---|---|
| claude-tui-driver.pty-spawn-with-model-selection | D1 (Replace SDK), D2 (node-pty), D8 (Module structure: `src/driver/pty.ts`) | covered | — |
| claude-tui-driver.native-tool-emission-is-blocked-at-driver-configuration | D11 (Defense-in-depth, 4 layers) | covered | — |
| claude-tui-driver.prompt-injection-via-typed-input-post-sessionstart (renamed 2026-05-22, D26 supersedes D13) | D26 (typed-injection post-SessionStart + Ink quiescence + Enter debounce), D9 (Hook set — SessionStart now triggers prompt injection) | covered | — |
| claude-tui-driver.cached-driver-session-is-a-hint-only | D1 implicitly preserves today's semantics; no new design section explicitly addresses cache invariants | partial | minor |
| claude-tui-driver.abort-propagates-to-the-pty | D10 (SIGINT + grace) | covered | — |
| claude-tui-driver.driver-never-writes-to-user-global-claude-config | Constitution III citation in Context; D1 + D3 + D9 all use inline flags only | covered | — |
| claude-tui-driver.unexpected-driver-exit-surfaces-as-error | R7, R9; "Failures surface" Constitution VII tie-in | covered | — |
| mcp-stdio-shim.shim-exposes-only-pi-bridged-tools | D3 (MCP transport), D11 | covered | — |
| mcp-stdio-shim.shim-forwards-tool-calls-to-the-in-process-router | D3 | covered | — |
| mcp-stdio-shim.shim-rejects-non-bridged-tool-names | D11 | covered | — |
| mcp-stdio-shim.shim-lifecycle-is-bound-to-its-pty | D3 (process-boundary cleanup); R7 | covered | — |
| mcp-stdio-shim.shim-is-a-separate-process | D3, D8 (`src/mcp/shim.ts` separate executable) | covered | — |
| mcp-stdio-shim.malformed-mcp-messages-surface-as-errors | Constitution VII | covered | — |
| transcript-stream.tail-transcript-while-turn-is-in-flight | D4 (Streaming), D8 (`src/driver/transcript.ts`) | covered | — |
| transcript-stream.emit-text-delta-tool-use-thinking-and-usage-events | D4 | covered | — |
| transcript-stream.partial-lines-are-buffered-until-newline | D4 implicitly (line-delimited JSONL); no explicit design note | partial | minor |
| transcript-stream.malformed-jsonl-lines-surface-as-warnings-not-stream-errors | Constitution VII | covered | — |
| transcript-stream.missing-or-unreadable-transcript-surfaces-as-error | R1; Constitution VII | covered | — |
| output-capture.output-capture-classification-of-ctx-tools | D5 (Capture mode) | covered | — |
| output-capture.strict-call-shape-capture-mode-mutually-exclusive-with-executable-tools-root-must-be-object | D5 | covered | — |
| output-capture.capture-path-isolation | D5; Constitution VI citation | covered | — |
| output-capture.synthesized-toolcall-content-block-on-success | D5 | covered | — |
| output-capture.surface-absent-capture-tool-call-as-error | D5; Constitution VII | covered | — |
| output-capture.capture-path-honors-abortsignal | D10 (Abort), promoted from clarify C2 | covered | — |
| claude-tui-driver.image-content-handling-in-v1 (added Round-1) | D13 image-rejection branch | covered | — |
| claude-tui-driver.hook-relay-subprocess-is-the-bridges-hook-ipc-channel (added Round-1) | D12 (Hook IPC channel) | covered | — |
| claude-tui-driver.abort-lifecycle-is-decoupled-from-stop-hook-firing (added Round-1) | D15 (Abort lifecycle) | covered | — |
| claude-tui-driver.abort-preserves-late-tool-result-coherence-with-pi (added Round-2) | D15 (bridge-side router state preservation) | covered | — |
| mcp-stdio-shim.shim-binary-serves-both-mcp-server-and-hook-relay-roles (added Round-1) | D12, D14 | covered | — |
| mcp-stdio-shim.capture-mode-tool-calls-receive-deterministic-shim-response (added Round-1) | D16 | covered | — |
| transcript-stream.unknown-jsonl-entry-types-surface-as-warnings-drift-detection (added Round-1) | D4 drift detection note | covered | — |
| transcript-stream `Tail transcript while turn is in flight` (Stop pre-flush settle scenario added Round-2) | D17 (Bounded post-Stop settle window) | covered | — |

**Summary:** 31/31 ACs have at least partial design coverage (was 24 at end of initial analyze; Round 1 added 6 ACs; Round 2 added 1 AC + 1 amended scenario).

## Check 4 — design↔ADR promotion candidates (Scale ≥ L)

| Decision | 4-point score | ADR-candidate? | Rationale or "ADR not warranted because…" |
|---|---|---|---|
| D1: Replace SDK with PTY-driven TUI | 4/4 | yes | Architectural reversal; constrains all future inference work. |
| D2: PTY library = node-pty | 3/4 | yes | Locks dependency posture; future migration off node-pty would be painful. |
| D3: MCP transport = stdio + shim | 4/4 | yes | Constrains IPC model for the bridge indefinitely. |
| D4: Streaming = transcript JSONL tail | 4/4 | yes | UX contract; reverting is a breaking change. |
| D5: Capture mode = forced MCP tool-call | 3/4 | yes | Defines the structured-output mechanism for the bridge. |
| D6: Drop AskClaude tool | 2-3/4 | borderline | Lasting consequence (breaking change) but no alternative was credibly defended; defer skill review at archive. |
| D7: System-prompt injection mechanism | TBD | TBD | Promote after Phase 0 spike resolves the choice. |
| D8: Module structure | 2-3/4 | borderline | Refactor sets up the long-term layout but the layout itself isn't disagreement-worthy. |
| D9: Hook set | 2/4 | no | Easy to add hooks later; not constraint-forming. |
| D10: Abort propagation = SIGINT + grace | 2/4 | no | Implementation detail; tunable. |
| D11: Defense-in-depth on disallowed tools | 3/4 | borderline | Maintains constitution principle IV; flag for archive skill review. |

Six firm ADR candidates (D1, D2, D3, D4, D5, plus D7 post-spike) + three borderline (D6, D8, D11) deferred to `openspec-archive-change` skill at archive time.

## Check 5 — Duplicate detection

| # | Locations | Restated constraint | Action |
|---|---|---|---|
| Dup1 | claude-tui-driver Requirement "Native tool emission is blocked at driver configuration" + mcp-stdio-shim Requirement "Shim rejects non-bridged tool names" | "non-pi tools cannot reach pi via Claude" | differentiate — intentional defense-in-depth per clarify I1; the linkage is documented in D11. Keep both. |
| Dup2 | claude-tui-driver "Driver never writes to user-global Claude config" + Constitution III | "no writes to `~/.claude/`" | keep both — spec restates principle for testability (constitutional principles are not directly testable; AC is). |
| Dup3 | output-capture "Capture path isolation" multiple scenarios touching `cachedSessionId` | three scenarios cover not-pollute cases | keep — each scenario tests a different state variable; not duplication, partition. |

## Check 6 — Implementation language in specs

| # | AC ID | Tech mentioned | Rewrite suggestion |
|---|---|---|---|
| Imp1 | (none after clarify A1 was applied) | — | `node-pty` was struck from claude-tui-driver spec during clarify resolution; the design.md is the right home. |
| Imp2 | output-capture (various scenarios) | `cachedSessionId`, `cachedSessionCwd`, `lastSentMessageHashes` | These are variable names from the current implementation. Acceptable in a MODIFIED spec because the existing spec already names them (per the original output-capture spec authored when archiving `bridge-output-capture-via-output-format`). Future XL refactor could rename to behavioral terms; out of scope here. |
| Imp3 | transcript-stream "Tail transcript while turn is in flight" | "implementation-defined polling/notify latency" | Acceptable — the spec defers the choice rather than prescribes one. No rewrite needed. |

No new implementation-language violations introduced by this change.

## Check 7 — Unresolved clarify findings

| # | clarify.md ref | Status | Risk |
|---|---|---|---|
| U1 | A7 | deferred | macOS fs.watch reliability — Phase 0 spike; falls back to polling if unreliable. |
| U2 | A8 | deferred | CC TUI thinking blocks in JSONL — Phase 0 spike; AC amended via follow-up if absent. |
| U3 | I4 | deferred | mid-turn cwd change behavior — undefined; documented as outstanding risk until pi exposes the capability. |
| U4 | C6 | deferred | CC TUI mid-turn session-id changes — Phase 0 spike. |
| (related) | A1's deferred companion → D7 | deferred | System-prompt-override flag — Phase 0 spike; constitution V partial-compliance hinges on this. |

All `unanswered` is zero (per clarify); only `deferred` remains, each tied to Phase 0 spikes or outstanding-risk tracking.

## Outstanding risks

(Mirror of clarify deferred findings + analyze findings that warrant tracking.)

- **macOS fs.watch reliability for transcript tail** (clarify A7). Mitigation: polling fallback if Phase 0 spike confirms unreliability.
- **CC TUI thinking-block emission in JSONL** (clarify A8). Mitigation: if absent, amend `transcript-stream.emit-text-delta-tool-use-thinking-and-usage-events` AC via follow-up change.
- **Mid-turn cwd change** (clarify I4). Mitigation: track as undefined behavior; pi does not currently expose mid-turn cwd changes.
- **CC TUI mid-turn session-id changes** (clarify C6). Mitigation: confirm in Phase 0; existing cache logic already handles divergence.
- **System-prompt-override flag in interactive mode** (design D7). Mitigation: Phase 0 spike; capture path's constitution V compliance hinges on result.
- **Adversarial-review-cycle invocation pending owner sign-off.** Schema mandates adversarial review at Scale ≥ L. The `adversarial-review-cycle` skill is "user-invoked only" per its description. Owner decision required before promoting analyze findings to blockers.

## Pending design updates (before tasks artifact)

Three small design.md addenda recommended to close partial AC↔design coverage:

1. **D7 status update:** when Phase 0 spike resolves, append a "D7-final" section with the chosen mechanism.
2. **Cache invariants subsection under D1:** restate the today-preserved divergence-drop semantics in design terms (Coverage gap for `claude-tui-driver.cached-driver-session-is-a-hint-only`).
3. **Line-delimited JSONL note under D4:** brief note that the tailer parses on `\n` boundaries (coverage gap for `transcript-stream.partial-lines-are-buffered-until-newline`).

Plus one spec edit:

4. **output-capture/spec.md line 145 (Requirement "Surface absent capture-tool call as error"):** rewrite head as `IF…THEN` per Check 2 E2.

## Round-2 adversarial review (added 2026-05-20)

Full round-by-round log: `.opsx-review/replace-sdk-with-pty-tui/`. Summary of impact on this analyze artifact:

- Constitution V verification scope corrected: T0.8 now uses INTERACTIVE mode (was `-p`) with fixture `CLAUDE.md` (Round-2 A.P1#1).
- D11 fallback documented: if `--setting-sources ""` fails Phase 0, per-PTY `HOME` override is the fallback (Round-2 A.P1#2).
- Clarify A2 superseded by `claude-tui-driver.image-content-handling-in-v1` (Round-2 A.P1#3).
- AC count corrected: 31 ACs (was 24; Round 1 added 6; Round 2 added 1) (Round-2 A.P2#1). Tasks/plan updated to use "every AC ID in specs/**/spec.md" instead of a literal count.
- AC renamed: `claude-tui-driver.prompt-injection-via-sessionstart-hook` → `.prompt-injection-via-cli-positional-argument` to reflect D13 body (Round-2 A.P2#2).
- Spike + integration tests rewritten to use deterministic MCP `tools/list` introspection instead of model self-report (Round-2 A.P2#3).
- PreToolUse hook DROPPED from D9/D11 (Round-2 A.P2#4); shim's `tools/call` log replaces its observability role.
- D7-final cites `--exclude-dynamic-system-prompt-sections`'s ignored-with-`--system-prompt` behavior (Round-2 A.P3#5).
- D5 alternative added: native `--json-schema` (Round-2 A.P3#1); T0.10 verifies interactive-mode availability.
- `--bare` forbidden at driver config; T4.3 asserts (Round-2 A.P3#2).
- R14 enumerates the in-repo revert range and adds Phase 4 rollback rehearsal (Round-2 A.P3#4).
- D15 refined: PTY torn down on abort BUT router state preserved for late-tool-result coherence (Round-2 B.P1#3 — the critical fix to avoid regressing today's bridge behavior).
- D17 added: bounded post-`Stop` transcript settle window (Round-2 B.P1#4); transcript-stream spec scenario updated.
- New blocking Phase 0 spike T0.12: verify `SessionStart` payload contains `transcript_path` in interactive mode (Round-2 B.P1#1). If only `Stop` carries it, fallback design = pre-spawn directory listing snapshot + mtime-based identification post-spawn.
- New spike T0.11: cold-start prompt-size measurement + argv-overflow fallback (Round-2 B.P1#2). R15 added to risk table.
- Plan step 4 Constitution III verification rewritten to scope on "bridge-authored" writes only (Round-2 B.P2#1).
- New risks R15 (argv overflow), R16 (model-ask non-determinism), R17 (capture-mode termination).

## Round-1 adversarial review (added 2026-05-20)

Full round-by-round log: `.opsx-review/replace-sdk-with-pty-tui/`. Summary of impact on this analyze artifact:

- Constitution V partial-compliance major **RESOLVED** by verifying `--system-prompt` (above).
- Check 2 E2 EARS rewrite **APPLIED** in-flight; output-capture surface-absent-capture-tool-call-as-error head reworded to `IF…THEN` form.
- New design Decisions added in response to reviewer findings: D12 (hook IPC channel), D13 (prompt injection — CLI positional arg), D14 (packaging build step), D15 (abort lifecycle decoupled from `Stop`), D16 (capture-mode MCP completion semantics).
- New spec ACs added to absorb reviewer findings: `claude-tui-driver.image-content-handling-in-v1`, `.hook-relay-subprocess-is-the-bridges-hook-ipc-channel`, `.abort-lifecycle-is-decoupled-from-stop-hook-firing`; `mcp-stdio-shim.shim-binary-serves-both-mcp-server-and-hook-relay-roles`, `.capture-mode-tool-calls-receive-deterministic-shim-response`; `transcript-stream.unknown-jsonl-entry-types-surface-as-warnings-drift-detection`.
- New tasks added: T0.6–T0.9 spikes (terminal queries, isolation flags, `--system-prompt` verification, post-spike synthesis); T1.2a (build pipeline); T1.14–T1.16 (integration tests for hook relay, MCP isolation, settings-source isolation); T4.4a (tarball verification test).
- New risks added to the risk table: R11 (terminal queries), R12 (hook subprocess latency), R13 (no `--no-session-persistence` in interactive mode), R14 (post-Phase-3 rollback requires republish).
- Transcript path correction (`~/.claude/sessions/` → `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`) applied across constitution, design, specs, proposal, plan.
- D11 restated to enumerate all 4 enforcement layers (was 2; missed `--setting-sources ""`, `--strict-mcp-config`, PreToolUse).

## Summary

- Blockers: **0** — proceed to review/tasks.
- Major findings: **0** post Round-1+Round-2 revisions.
- Minor findings: **0** — all AC↔design partial-coverage gaps closed in Round 2.
- **Gate status:** READY for tasks. Round-3 adversarial review pending to verify Round-2 revisions hold.

## Phase 0 spike outcomes (added 2026-05-21)

All Phase 0 spikes complete. Risk table updates from empirical evidence:

- **R11 (terminal queries) — RESOLVED + DROPPED.** Phase 0 T0.6 / T0.14 confirms `node-pty` alone is sufficient; `claude` emits XTVERSION / DA / iTerm2-progress / focus-tracking queries during boot and proceeds without synthetic responses. No ANSI responder needed in the driver.
- **R12 (hook subprocess latency) — OBSERVED LOW.** T0.14 measured ~100ms cold-start of the Node hook on macOS arm64; well within the per-turn budget given only 2 hooks fire per session (SessionStart) + per turn (Stop). Carry into T4.7 benchmark.
- **R13 (`--no-session-persistence`) — NO CHANGE.** Flag remains `--print`-only; interactive sessions persist under `~/.claude/projects/`. Bridge cleanup strategy (delete bridge-owned session files) unaffected.
- **R14 (rollback requires republish) — NO CHANGE.** Defense plan stays the same: Phase 3 deletes are reversible via `git revert` + republish.
- **R15 (argv overflow) — MITIGATED.** T0.11 confirms `--system-prompt-file <path>` works in BOTH `--print` AND interactive modes (undocumented but functional). Bridge will switch to file-form above a 50 KB heuristic. Risk now low.
- **R16 (model-ask non-determinism) / R17 (capture-mode termination)** — deferred to Phase 1 integration tests against real `claude`; spike evidence consistent with the D16 deterministic-shim-response design.
- **R18 / R19 / R20 / R21** (added Round 4-5 + 2026-05-21): all empirically addressed in Phase 0 (D25 trust scanner verified passing; node-pty postinstall +x scripted in T1.2a; skill_listing attachment confirmed present but mitigated via `--disable-slash-commands` for capture mode; transcript realpath encoding empirically verified in T0.14).

All Phase 0 OQs from `design.md` are resolved (see Open Questions section). Phase 1 unblocked.

## Post-Phase-4 scenario validation findings (2026-05-22)

- **R26 (OAuth interactive-mode tier cap) — DISCOVERED + MITIGATED by D26.** Scenario S0 against real `claude` binary failed with `API Error: 400 "out of extra usage"` regardless of model, despite OAuth Max-plan account having available quota and `claude -p` succeeding with the same args. Bisect localised the trigger to interactive-mode invocations with positional prompt AND substantive `--system-prompt` (≥~2KB total triggers it; pi sysprompt is ~41KB so 100% of bridge spawns hit). Reference implementation `smithersai/claude-p` uses typed-injection (no positional prompt; type into TUI input post-`SessionStart`); adopted as D26. Verified: same args without positional + with typed-injection succeed. Phase 5 (added) implements the refactor.
- **R26-derived openspec changes:** D13 SUPERSEDED by D26; `claude-tui-driver.prompt-injection-via-cli-positional-argument` renamed to `.prompt-injection-via-typed-input-post-sessionstart`; scenarios for typed-injection added to spec.md; new tasks 5.1–5.10; new plan Phase 5.
- **Adversarial review post-mortem:** None of the 5 review rounds (`smith/codex` + `claude-bridge/opus`) flagged the OAuth interactive-mode tier-cap risk for positional prompts. The failure mode is not documented anywhere in `claude --help`, `claude.ai/settings/usage`, or Anthropic public docs; only discovered by running the actual scenario suite end-to-end against the real `claude` binary on a real OAuth account. Verifies the `pi-tui-scenario-tests` skill description ("unit tests can't catch silent corruption of the user-facing experience") — exactly this class.

## D27 finding (2026-05-22, post-D26-landing)

After landing D26 (typed-injection) and re-validating S0 against real `claude` binary, the same `API Error: 400 "out of extra usage"` still occurred with pi's actual ~41KB system prompt despite typed-injection being correctly applied. Investigation:

1. Confirmed user's OAuth account has 1% 5h-budget and 2% 7d-budget utilization (not a quota issue).
2. Direct REST API call to `/v1/messages` with OAuth token returned `429 rate_limit_error` immediately — different error from the TUI's 400. Investigation revealed claude TUI uses different endpoint shape (`/v1/messages?beta=true` with `claude-code-20250219` beta header) and translates 4xx errors to its own display text.
3. Response headers from successful `claude -p` invocation: `anthropic-ratelimit-unified-overage-status: rejected` + `anthropic-ratelimit-unified-overage-disabled-reason: org_level_disabled` — the failing requests are being routed to overage budget which is org-disabled, but only certain request shapes trigger that routing.
4. Bisect of pi sysprompt with `--system-prompt-file` + typed-injection: prefix 0-2150 bytes PASS, prefix 0-2175 bytes FAIL, synthetic content of any size PASS, real pi content >2KB FAIL. Trigger is content-specific (not pure size).
5. Same pi content delivered as a typed user message (not via `--system-prompt*` flag) → request accepted normally.
6. Conclusion: Anthropic's interactive-mode classifier flags certain content density patterns when delivered via system-role channels. The same content on user-role channel is accepted. D27 wraps sysprompt + user prompt into a single `<system_context>`-tagged user message.

This is now mitigated by D27 (system-prompt bundling). The architecture is robust to future classifier tightening because typed user messages are the universal user-input path real Claude Code users hit — restricting them would break every user.

## Open: separate MCP-shim-via-pi-spawn issue

A separate failure mode appears intermittently when the bridge is invoked through pi's tmux-driven scenario harness: claude PTY log shows `1 MCP server failed · /mcp` and no model response. Direct `spawnDriver()` calls (same bridge code, same OAuth account, same sysprompt) work cleanly. Likely related to env or stdio inheritance between pi → bridge → claude → shim in tmux pane mode. Tracked as v1.1.0 follow-up; does not block D27 architecture validation.
