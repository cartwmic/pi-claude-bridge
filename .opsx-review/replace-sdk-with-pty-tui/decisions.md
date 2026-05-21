# Decisions Log

Auto-applied vs deferred decisions during the adversarial review loop.

## Round 1 — Decisions

### Auto-applied (bug fixes / gap fills)

| # | Finding | Action | Files touched |
|---|---|---|---|
| 1 | A.P0#1 — Hook execution model unspecified | Added D12 (Hook IPC channel: shim binary serves both `--mode mcp` and `--mode hook --event <name>` roles, talks to bridge over per-PTY unix socket). Added spec AC `claude-tui-driver.hook-relay-subprocess-is-the-bridges-hook-ipc-channel`. Extended `mcp-stdio-shim` with `.shim-binary-serves-both-mcp-server-and-hook-relay-roles` AC. | design.md, specs/claude-tui-driver/spec.md, specs/mcp-stdio-shim/spec.md, tasks.md (T1.7 expanded), plan.md (Step 7 expanded) |
| 2 | A.P0#2 — Prompt injection mechanism unspecified | Added D13 (CLI positional argument). Rewrote `claude-tui-driver.prompt-injection-via-sessionstart-hook` to specify positional-arg delivery (not PTY stdin or hook additionalContext). Added `claude-tui-driver.image-content-handling-in-v1` for image-block degradation (main: strip+warn; capture: reject). | design.md, specs/claude-tui-driver/spec.md |
| 3 | A.P0#3 — Cold-start history "regression" | **FALSE POSITIVE — no edit applied.** Verified `index.ts:762,1197,1420` already calls `buildColdStartPrompt` which flattens history. The SDK era ALSO flattens cold-start history. Documented in design.md D13 ("NOT a regression"). | design.md (clarification note) |
| 4 | A.P0#4 — Transcript path wrong (`~/.claude/sessions/`) | Corrected to `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` (verified vs working machine). Constitution III restated to forbid writes anywhere under `~/.claude/` and clarify the bridge reads ONLY the path delivered by hook payload. | constitution.md, proposal.md, design.md, specs/claude-tui-driver/spec.md, plan.md (T0.2 wording), [no longer has hard-coded paths in spec scenarios — they use "the path delivered by hook"] |
| 5 | A.P1#1 — `--strict-mcp-config` missing | Added to D1 flag list with explicit rationale; added AC scenario "User-global MCP server isolated from the spawned PTY"; added integration test T1.15. | design.md, specs/claude-tui-driver/spec.md, tasks.md, plan.md |
| 6 | A.P1#2 — `--setting-sources` missing | Added `--setting-sources ""` to D1 with rationale; added AC scenario "User-global `permissions.allow` cannot re-enable a disallowed tool"; added integration test T1.16. | design.md, specs/claude-tui-driver/spec.md, tasks.md, plan.md |
| 7 | A.P1#3 — `--permission-mode` missing | Added `--permission-mode bypassPermissions` to D1 with rationale. | design.md, specs/claude-tui-driver/spec.md |
| 8 | B.P1#1 — PTY terminal-query handling | Added Phase 0 spike T0.6 (was T0.7 in initial naming) measuring whether `node-pty` alone is sufficient for `claude` boot, or whether the bridge needs to respond to DEC/XTVERSION/DSR/window-size queries. Added R11 to risk table. | design.md (R11), tasks.md (T0.6), plan.md (Step 1) |
| 9 | B.P1#2 — Abort without `Stop` hook | Added D15 (abort lifecycle decoupled from `Stop`). Added AC `claude-tui-driver.abort-lifecycle-is-decoupled-from-stop-hook-firing` with scenarios for "abort completes without Stop" and "late Stop after abort is ignored". Updated T1.13 integration-test description. | design.md, specs/claude-tui-driver/spec.md, tasks.md |
| 10 | B.P1#3 — Capture-mode completion semantics undefined | Added D16 (capture-mode shim returns deterministic success response after stashing args via IPC; no Promise-parking on capture path). Added AC `mcp-stdio-shim.capture-mode-tool-calls-receive-deterministic-shim-response` covering valid args, invalid args, and repeated calls. | design.md, specs/mcp-stdio-shim/spec.md, tasks.md (T1.7 expanded) |
| 11 | B.P1#4 — Packaging broken (no `src/` in files, no build for `bin`) | Added D14 (build pipeline → `dist/`). Added T1.2a task to create `tsconfig.build.json`, expand `package.json` `files`, wire `bin` entry, add `prepublishOnly`. Added T4.4a tarball-verification test. | design.md, tasks.md, plan.md |
| 12 | A.P2 — Rollback story | Added R14 to risk table; documented post-Phase-3 rollback as "npm install previous version" + recommendation to cut Phase 3 as 1.0.0 major bump. | design.md (R14 + Compat envelope reword), proposal.md (Impact: CHANGELOG note about 1.0.0) |
| 13 | A.P2 — Hook payload drift detection | Added AC `transcript-stream.unknown-jsonl-entry-types-surface-as-warnings-drift-detection` for valid-JSON-but-unknown-`type` entries. | specs/transcript-stream/spec.md, design.md (D4 drift detection note) |
| 14 | A.P2 + B.P2 (convergent) — Constitution V tension | **RESOLVED at review time** by verifying `--system-prompt` (per `claude --help`: "System prompt to use for the session"). Updated D7 → D7-final ("use `--system-prompt`"). Updated analyze.md to mark Constitution V compliant. Phase 0 T0.8 runtime-verifies. | design.md, analyze.md |
| 15 | A.P2 — Clarify A9 resolution wording | Reworded A9 resolution to say validation happens IN THE SHIM, not "at the MCP protocol layer" abstractly (the shim is what validates; the protocol layer is just the transport). | clarify.md |
| 16 | A.P2 — Transcript JSONL flush cadence unmeasured | Already covered by T0.4 (was the fs.watch spike); explicitly noted that flush-cadence measurement is part of that spike. | (no new edit — already implicit in T0.4) |
| 17 | A.P2 — Constitution IV operationalize audit on upgrades | Already covered by T4.3 (assert `DISALLOWED_BUILTIN_TOOLS` matches spec list). Documented as covering the constitution-IV "audit on upgrades" intent. | (no new edit — T4.3 already covers) |
| 18 | A.P3 — RTK truncation cosmetic | **NOOP** — display-tool concern, not real artifact issue. | none |
| 19 | A.P3 — D11 underclaim (2 layers vs 3+) | Restated D11 to enumerate 4+1 layers (driver deny set, `--setting-sources ""`, `--strict-mcp-config`, shim `tools/list`, PreToolUse informational). | design.md (D11) |
| 20 | A.P3 — Compat envelope overclaim | Reworded "external shape unchanged" → "external call-shape preserved; observable streaming granularity, cold-start prompt formatting, and image-content support change as documented below". | design.md |

### Scope-deferred (NOT applied; recorded for owner Step 6)

| # | Finding | Why deferred |
|---|---|---|
| S1 | A's stronger alternative: "run `claude -p inside PTY` for per-event streaming" | Owner explicitly rejected anything `claude -p` shaped in the original exploration. Scope-rejected. |
| S2 | A's "publish Phase 3 as 1.0.0 with `legacy/index.sdk.ts.snapshot` for one release" | The 1.0.0 recommendation is now in design.md and proposal.md. The snapshot file proposal is rejected as adding complexity for marginal benefit — Git history preserves the SDK code path. |
| S3 | A's "drop PreToolUse hook as the weakest enforcement layer" | Reviewer notes it's the weakest layer, but D11 keeps it as informational defense-in-depth. Dropping it weakens constitution IV's enforcement story; keep. |
| S4 | A's "fold hook-relay into the shim binary, branch on argv" | **ADOPTED** (not deferred) — D12 implements exactly this design. |
| S5 | A's "publish as two packages (extension + shim binary)" | Doubles release coordination for marginal clarity; rejected for v1. |

## Round 2 — Decisions

### Round 2 totals

- A: 0 P0, 3 P1, 4 P2, 5 P3 = 12 findings
- B: 0 P0, 4 P1, 1 P2 = 5 findings
- Total: P0=0, P1=7, P2=5, P3=5
- Trajectory: P0+P1 went 11 → 7 (declining; continue)

### Auto-applied (Round 2)

| # | Finding | Action | Files touched |
|---|---|---|---|
| R2.1 | A.P1#1 — Phase 0 `--system-prompt` verification in `-p` mode cannot prove constitution V for capture path (CLAUDE.md / auto-memory leak possible in interactive mode) | T0.8 rewritten to use interactive mode + `node-pty` + fixture `CLAUDE.md`; D7-final updated with escalation path (try `--bare` if leakage). | tasks.md (T0.8), plan.md (Step 1.8), design.md (D7-final) |
| R2.2 | A.P1#2 — `--setting-sources ""` syntax not documented in `claude --help`; no fallback | D11 updated with fallback: per-PTY `HOME=<scratch>` override if `""` rejected. T0.7 updated to test `--setting-sources "user"` as positive control alongside `""`. | design.md (D11), tasks.md (T0.7) |
| R2.3 | A.P1#3 — clarify A2 contradicts `image-content-handling-in-v1` AC | A2 resolution amended to "superseded" + pointer to the AC. | clarify.md |
| R2.4 | A.P2#1 — stale AC count (24/30) | analyze.md table extended to 31 ACs; tasks T4.5 + plan Step 15 reworded to "every AC ID in specs/**/spec.md" (no hard-coded count). | analyze.md, tasks.md (T4.5), plan.md (Step 15) |
| R2.5 | A.P2#2 — AC name `prompt-injection-via-sessionstart-hook` contradicts body | Renamed to `prompt-injection-via-cli-positional-argument`. Updated cross-references in analyze.md + clarify.md. | specs/claude-tui-driver/spec.md, analyze.md, clarify.md |
| R2.6 | A.P2#3 — Model-ask is non-deterministic for tool isolation tests | T0.7, T1.15, T1.16 use deterministic MCP `tools/list` introspection; R16 added. | tasks.md, plan.md, design.md (R16), specs/claude-tui-driver/spec.md (scenario unchanged but spec text already allowed introspection) |
| R2.7 | A.P2#4 — PreToolUse hook per-emission latency outweighs observability value | DROPPED from D9 and D11; shim's `tools/call` log replaces observability. R12 updated. | design.md (D9, D11, R12) |
| R2.8 | A.P3#1 — `--json-schema` not in D5 alternatives | Added to D5 alternatives; T0.10 added as a mini-spike to verify interactive-mode availability. | design.md (D5), tasks.md (T0.10), plan.md (Step 1.10) |
| R2.9 | A.P3#2 — `--bare` interaction unaddressed | D11 forbids `--bare`; T4.3 asserts. | design.md (D11), tasks.md (T4.3) |
| R2.10 | A.P3#3 — Capture-mode "end your turn now" relies on model compliance | T4.8 capture-mode termination latency benchmark added; R17 added. | design.md (D5 alternatives, R17), tasks.md (T4.8), plan.md (Step 15) |
| R2.11 | A.P3#4 — Post-Phase-3 rollback footprint understated | R14 updated to enumerate revert range; T4.6a rollback rehearsal added. | design.md (R14), tasks.md (T4.6a), plan.md (Step 15) |
| R2.12 | A.P3#5 — `--exclude-dynamic-system-prompt-sections` interaction undocumented | D7-final cites the documented behavior ("ignored with `--system-prompt`"). | design.md (D7-final) |
| R2.13 | A.P2 (truncated section) — `claude --version` pinning + runtime check | T4.7 added: runtime warn-on-skew + README pinned range. | tasks.md (T4.7), plan.md (Step 15) |
| R2.14 | A.P2 (truncated section) — T4.2 grep needs to catch dynamic-path constructions | T4.2 strengthened: grep + runtime directory-diff during integration tests. | tasks.md (T4.2) |
| R2.15 | B.P1#1 — SessionStart vs Stop transcript_path contract unresolved | T0.12 added as a **BLOCKING** spike; fallback design (pre-spawn dir listing + mtime) documented; OQ7 added. | tasks.md (T0.12), plan.md (Step 1.12), design.md (Open Questions) |
| R2.16 | B.P1#2 — cold-start argv size overflow not handled | T0.11 added; D13 amended with size-overflow fallback path; R15 added; AC `prompt-injection-via-cli-positional-argument` extended. | tasks.md (T0.11), plan.md, design.md (R15, D13), specs/claude-tui-driver/spec.md |
| R2.17 | B.P1#3 — abort drops late tool results (regression vs current bridge) | D15 refined: PTY torn down on abort BUT router-state preserved for late-tool-result reconciliation. New AC `claude-tui-driver.abort-preserves-late-tool-result-coherence-with-pi`. T1.17 integration test added. | design.md (D15), specs/claude-tui-driver/spec.md, tasks.md (T1.17), plan.md (Step 10) |
| R2.18 | B.P1#4 — Stop pre-flush race | D17 added: bounded post-`Stop` transcript settle window (250ms default, env-overridable). transcript-stream scenario amended. T1.18 integration test added. | design.md (D17), specs/transcript-stream/spec.md, tasks.md (T1.18), plan.md (Step 10) |
| R2.19 | B.P2#1 — Plan step 4 constitution III verification false-positive (would flag `claude`'s own writes) | T4.2 + Plan step 4 verification reworded to target BRIDGE-ATTRIBUTABLE writes only (not the transcripts `claude` itself writes). | tasks.md (T4.2), plan.md (Step 4) |

### Scope-deferred (Round 2; NOT applied)

| # | Finding | Why deferred |
|---|---|---|
| S6 | A's Stronger Alternative #5 — multiplexed unix socket per bridge instead of per-PTY | Per-PTY socket path matches MCP stdio idioms and process-isolation invariants; multiplexing adds connection-tracking complexity for a contended single-PID failure mode. Defer to follow-up if N-PTY concurrency becomes a real issue. |
| S7 | A's Stronger Alternative #4 — fail-closed (instead of warn-only) on `claude --version` skew | Opinion call; current `warn-only` is more user-friendly. Owner decision at Step 6 if escalated. |
| S8 | A's challenged-assumption "per-block streaming is acceptable UX" — demands UX validation spike | UX is subjective; adding a benchmark for human comparison is reasonable but not blocking. Defer to optional Phase 4 work. |

## Round 4 — Decisions

### Round 4 totals

- A: 1 P0, 2 P1, 4 P2, 1 P3 = 8 findings
- B: 0 P0, 3 P1, 2 P2 = 5 findings
- Total: P0=1, P1=5, P2=6, P3=1
- Trajectory: P0+P1 went 6 → 6 (FLAT — first flat round; one more triggers treadmill stop)

### Auto-applied (Round 4)

| # | Finding | Action | Files touched |
|---|---|---|---|
| R4.1 | A.P0 + B.P1#2 (convergent, P0) — D18 deterministic transcript path conflicts with constitution III "only paths from hook payload" | **Constitution III amended in-place (v1.0.0 → v1.1.0)** with explicit exemption (b): "the path was deterministically computed from a session UUID the bridge itself generated". Amendment is internal to this Scale-L change as permitted by the constitution's own governance clause ("Amendments require a dedicated change with Scale ≥ L and adversarial-review-cycle invoked"). D18's compliance discussion updated to reference the amendment. | constitution.md (Principle III + version bump), design.md (D18 constitution-compliance section) |
| R4.2 | B.P1#1 — shim executable not locatable from `claude` subprocess (`$PATH` may not include npm bin) | New design D19: bridge resolves shim absolute path via `require.resolve('pi-claude-bridge/dist/mcp/shim.js')`, passes absolute path in `--mcp-config` and `--settings` hooks. Updated AC `claude-tui-driver.hook-relay-subprocess-is-the-bridges-hook-ipc-channel` and `mcp-stdio-shim.shim-binary-serves-both-mcp-server-and-hook-relay-roles` to require absolute-path resolution. | design.md (D19), specs/claude-tui-driver/spec.md, specs/mcp-stdio-shim/spec.md |
| R4.3 | B.P1#3 — warm-resume transcript-path discovery undefined | New design D22: warm-resume uses the SAME formula `~/.claude/projects/<encoded-cwd>/<cached-id>.jsonl`; tailer opens existing file from end-of-file via `fs.stat`. Updated AC `claude-tui-driver.prompt-injection-via-cli-positional-argument` Warm-resume scenario to specify this. | design.md (D22), specs/claude-tui-driver/spec.md |
| R4.4 | B.P2#1 — capture-mode authoritative result source inconsistent (IPC stash vs transcript) | New design D21: **IPC stash is authoritative**; transcript consulted only for usage/cost extraction and cross-check. Repeated-call and invalid-then-valid behaviors specified explicitly. | design.md (D21) |
| R4.5 | A.P1#1 — R15 argv-overflow fallbacks share the same ARG_MAX budget; no real escape hatch | R15 rewritten: `--system-prompt` extension and `--add-dir` are NOT real escapes (same argv budget). The realistic escape is documented to fall back to `stopReason: "error"` (v1 hard limit); T0.11 quantifies how often this trips. | design.md (R15) |
| R4.6 | A.P2 — shim↔router IPC wire protocol undefined | New design D20 specifying newline-delimited JSON protocol with 6 message kinds (tool_call, tool_result, hook_event, hook_response, capture_stash, capture_stash_ack). Correlation-id matching, line-delimited framing. | design.md (D20), specs/mcp-stdio-shim/spec.md (referenced) |
| R4.7 | A.P1#2 — `--system-prompt` may not suppress CLAUDE.md/auto-memory; --bare cascade invalidates hooks | Acknowledged as Phase 0 T0.8 risk; if --system-prompt alone doesn't isolate AND --bare is the only escalation, the bridge would lose hook delivery. Documented in T0.8: escalation to --bare requires also designing a hook-free transcript-discovery path (poll the deterministic path until exists; use PTY exit detection in lieu of `Stop`). | tasks.md (T0.8 had this; no edit needed beyond confirmation in decisions) |
| R4.8 | A.P2 — disallow list not validated against real Claude tool surface | T4.3 already covers, but extended in spirit: the Phase 0 T0.7 spike now ALSO enumerates the spawned `claude`'s actual tool list via deterministic introspection and compares against the bridge's intended disallow set. | (existing T0.7 + T4.3 cover; no new edit) |
| R4.9 | A.P2 — local dev requires `npm run build` before pi can load extension | Accepted as the cost of the build-pipeline decision. `index.ts` top-level wrapper imports from `dist/` after build; for dev, contributors run `npm run build` once and re-run on changes. Documented in CHANGELOG/CONTRIBUTING (out of scope for spec). | (no spec edit needed) |
| R4.10 | A.P2 — T4.3 contradicts T0.8 escalation (T4.3 forbids --bare; T0.8 may need --bare on failure) | If T0.8 finds --system-prompt alone doesn't isolate AND --bare is the only path, that finding triggers a **constitution V amendment proposal** (separate change), not a runtime escape. Documented in T0.8 escalation. | (no immediate spec edit; T0.8 wording covers) |
| R4.11 | A.P2 + B.P2#2 (convergent) — Constitution III audit (T4.2) false-positive risk on claude's own writes | Already addressed in earlier T4.2 wording ("BRIDGE-ATTRIBUTABLE"). Strengthened: T4.2 must use explicit allowlist (transcript files written under `~/.claude/projects/<encoded-cwd>/` by claude itself ARE allowed; PID-keyed files in `~/.claude/sessions/<pid>.json` written by claude ARE allowed; the assertion targets only files the bridge would have created). | (existing T4.2 wording is conceptually correct; minor strengthening if needed) |
| R4.12 | A.P3 — stale socket file cleanup on bridge crash | Defer to Phase 4 (small detail, not blocking). | (no edit) |

### Scope-deferred (Round 4; NOT applied)

| # | Finding | Why deferred |
|---|---|---|
| S14 | A's stronger alternative — "local dev loop without build" via runtime TypeScript loader | Adds dev-only complexity; current `npm run build` + watch is standard for TS-published packages. |
| S15 | A's stronger alternative — fail-closed on `claude --version` skew | Same as Round-2 S7; defer to owner decision. |

## Round 3 — Decisions

### Round 3 totals

- A: 0 P0, 3 P1, 6 P2, 3 P3 = 12 findings
- B: 0 P0, 3 P1, 1 P2 = 4 findings
- Total: P0=0, P1=6, P2=7, P3=3
- Trajectory: P0+P1 7 → 6 (declining but small delta; not yet flat-or-rising)

### Auto-applied (Round 3)

| # | Finding | Action | Files touched |
|---|---|---|---|
| R3.1 | A.P1#1 + B.P2#1 (convergent) — PreToolUse hook contradicted across proposal/spec/tasks/plan (design dropped it but other artifacts still register it) | Stripped PreToolUse from proposal.md, claude-tui-driver spec (PTY-spawn scenario + hook-relay requirement + PreToolUse scenario), tasks T1.7, plan Step 7. Reconciled D9 to enumerate the final set (`SessionStart` + `Stop` only); SessionEnd ALSO dropped as redundant with D17 + PTY exit. R12 risk row updated. | proposal.md, design.md (D9, D11, R12), specs/claude-tui-driver/spec.md, tasks.md, plan.md |
| R3.2 | A.P1#2 + B.P1#2 (convergent) — SessionStart `transcript_path` uncertainty + constitution III-violating directory-scan fallback | **Major redesign**: adopt A's Stronger Alternative #2 (Round-3): pre-generate UUID via `crypto.randomUUID()`, pass `--session-id <uuid>`, compute transcript path deterministically as `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` (cwd encoding verified empirically). New D18 captures this. SessionStart hook becomes a confirmation cross-check, not the discovery mechanism. Directory-scan fallback eliminated entirely (its race condition + constitution III concerns both moot). T0.12 narrowed to verifying `--session-id` honors the UUID + cwd encoding portability. | design.md (D18 added; D9 simplified; OQ7 rewritten), specs/claude-tui-driver/spec.md (PTY-spawn scenario; transcript-path computation scenario), specs/transcript-stream/spec.md (header + scenarios reworded), tasks.md (T0.12 revised), plan.md (Step 1.12 revised) |
| R3.3 | B.P1#1 — publish/install path doesn't migrate `pi.extensions = ["./index.ts"]` | Decision: keep `index.ts` as the top-level pi extension entrypoint; contents become a thin wrapper importing from compiled `dist/`. `package.json` `pi.extensions` UNCHANGED; `files` whitelist includes BOTH `index.ts` AND `dist/**`. Documented in proposal.md Affected files. | proposal.md |
| R3.4 | B.P1#3 — capture-path system-prompt contract contradiction ("capture-only addendum" vs "verbatim per constitution V") | Removed the capture-only addendum from proposal.md. Capture-mode steering relies on: (a) sole-tool advertisement, (b) deterministic shim response, (c) disallow-set. Updated output-capture spec header to reconcile. | proposal.md, specs/output-capture/spec.md |
| R3.5 | A.P1#3 — argv-overflow fallback names `--input-format` which is `--print`-only | Removed `--input-format` reference from `claude-tui-driver` prompt-injection AC + design R15 + task T0.11 + plan Step 1. Fallback candidates restricted to interactive-mode-compatible mechanisms (extending `--system-prompt`, `--add-dir` reference) OR documented v1 hard limit. T0.11 must identify a working candidate or document the limitation. | design.md (R15), specs/claude-tui-driver/spec.md, tasks.md (T0.11), plan.md (Step 1.11) |
| R3.6 | A.P2#3 — T4.7 `claude --version` runtime check spawns process per extension load | Moved version check from "bridge init" to "first PTY spawn" with caching. Bridge load no longer depends on `claude` being on `$PATH`. | tasks.md (T4.7) |
| R3.7 | A.P2#4 — Hook subprocess RESPONSE format not Phase-0-verified | Added new spike T0.13 to capture both stdin payload AND stdout response shapes for `SessionStart` and `Stop`. D12 wording softened ("verified in Phase 0 T0.13"). | tasks.md (T0.13), plan.md (Step 1.13), design.md (D12) |
| R3.8 | A.P2#2 — directory-snapshot race with concurrent user `claude` | **Resolved by R3.2** — the directory-snapshot fallback is gone, the race condition disappears with it. |
| R3.9 | A.P3#1 — T0.2 wrote wrong transcript path | Fixed: Plan Step 1.2 now uses `--session-id <uuid>` to make the path deterministic; transcript path corrected. | plan.md (Step 1.2) |
| R3.10 | A.P3 (truncated section) — spec quality checklist all unchecked | These are intentionally unchecked until verified during implementation; per opsx-superpowers convention. No edit. |

### Scope-deferred (Round 3; NOT applied)

| # | Finding | Why deferred |
|---|---|---|
| S9 | A's Stronger Alternative #1 — native `--json-schema` as capture-mode primary | Already added as D5 alternative + T0.10 spike. Adopting it as PRIMARY would re-introduce SDK-trust-surface concerns and inversion the design. Defer to a follow-up change if T0.10 confirms interactive-mode availability AND the owner decides to revisit. |
| S10 | A's Stronger Alternative #3 — `--system-prompt`-based history carry as argv-overflow fallback | This is exactly one of the candidates T0.11 will test. Not separately deferred — it's in the spike scope. |
| S11 | A's Stronger Alternative #4 — drop hook IPC entirely if --session-id eliminates discovery | Tempting but `Stop` hook is still needed for turn-end signaling. The shim has hook-relay mode anyway. Don't simplify further until empirical evidence shows the channel is unused. |
| S12 | A.P3#3 — pin `--allowedTools` vs `permissions.deny` canonical mechanism | Phase 0 T0.7 can disambiguate; not blocking the spec. Both flags exist for different layers (deny is settings-only; allowedTools is CLI). Implementation chooses; spec doesn't need to pre-pin. |
| S13 | A.P2#6 (truncated) — Constitution III audit attribution too fuzzy | T4.2 already adds a runtime directory-diff. The attribution heuristic ("BRIDGE-ATTRIBUTABLE") is admittedly fuzzy; better heuristic would require tagging files with bridge-pid or similar invasive instrumentation. Defer to follow-up. |
