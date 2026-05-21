# Round 2 — Reviewer A (claude-bridge/claude-opus-4-7)

## Verdict

**needs revision** — Constitution V verbatim-prompt compliance for the capture path is asserted but verified only in `--print` mode (not interactive, not with `CLAUDE.md` present); two specs are internally inconsistent on image handling (clarify A2 vs D13/image-content-handling AC); the isolation story leans on an undocumented `--setting-sources ""` syntax with no documented fallback; and the AC↔design coverage table and `verify.md` plan both still claim "24 ACs" after Round 1 grew the spec set to 30 — these are concrete, fixable gaps that warrant a revision before Phase 0 executes.

## Findings

### [P1] Phase 0 `--system-prompt` verification cannot prove constitution V for the capture path

- **Where:** `plan.md` Plan step 1 sub-task T0.8 ("spawn `claude --system-prompt 'TEST_SENTINEL_XYZ' --print 'What is your system prompt?'`"); `tasks.md` 0.8; `design.md` D7-final "Phase 0 verification (T0.1)".
- **Issue:** The spike runs the verification in `-p` (print) mode, which the design itself argues is "the SDK's mode under the hood" and the path being abandoned. `--system-prompt` semantics in `-p` mode are not necessarily identical to interactive mode. Two interactive-only context-injection paths in particular are NOT exercised by the spike:
  1. `CLAUDE.md` auto-discovery (the `--bare` flag's documented behavior list explicitly names "`CLAUDE.md` auto-discovery" as something `--bare` disables — implying it runs in normal interactive mode even when `--system-prompt` is set, unless `--bare` is in play).
  2. Auto-memory (also disabled by `--bare`; otherwise active).
  Either could append context beyond the verbatim `ctx.systemPrompt`, silently breaking the capture-path contract (`cap-path-systemPrompt MUST be verbatim`).
- **Impact:** Constitution V's capture-path invariant ("forward `ctx.systemPrompt` verbatim with no additions") could be violated for any capture call whose cwd contains a `CLAUDE.md` (the per-PTY cwd is `os.tmpdir()` by default per D5, but the caller can override). Failure mode is silent: the model sees extra context, structured output may still validate, no error surfaces. This is the exact kind of "works on my machine" silent degradation constitution VII forbids.
- **Fix direction:** Replace T0.8 with two verifications: (a) spawn `claude --system-prompt 'TEST_SENTINEL_XYZ'` inside a `node-pty` session in interactive mode, in a directory containing a fixture `CLAUDE.md`, with no `--bare`; programmatically ask the model to repeat its system prompt and inspect the transcript JSONL; assert no `CLAUDE.md` content appears. (b) Repeat in a directory containing the user's actual `~/.claude/settings.json` to confirm auto-memory paths don't leak. If either leaks, the design needs an additional mitigation (mandatory `--bare`, or capture-path-only `--bare`, with all consequences re-evaluated — `--bare` disables hooks, which the design relies on for transcript-path discovery, so this would cascade).

### [P1] `--setting-sources ""` is not documented in `claude --help`; design's isolation story has no fallback

- **Where:** `proposal.md` ("--setting-sources ''"); `design.md` D1 flag rationale + D11 layer 2; `claude-tui-driver/spec.md` "PTY spawn with model selection" + "User-global `permissions.allow` cannot re-enable a disallowed tool" scenario; tasks.md T0.7; plan.md Step 1 sub-task T0.7.
- **Issue:** `claude --help` documents `--setting-sources <sources>` as "Comma-separated list of setting sources to load (user, project, local)." Empty string is NOT listed as a documented sentinel; the design assumes empty-string ⇒ "load nothing", but that interpretation is unverified. The Phase 0 spike T0.7 is acknowledged to verify this. If the spike finds empty-string is rejected, defaults to "all", or silently degrades to loading user settings, the entire constitution-IV defense layer #2 collapses and there is no documented fallback.
- **Impact:** A bad spike result invalidates one of the four defense-in-depth layers and forces a redesign mid-Phase-0. The proposal/design should commit to a fallback now (e.g., per-PTY `HOME` override pointing at a scratch directory with an empty `.claude/`, which is a coarser hammer that doesn't depend on flag syntax) rather than discover the problem mid-spike.
- **Fix direction:** Add an explicit fallback to D11: if `--setting-sources ""` is not honored, spawn each PTY with `HOME=<per-PTY scratch dir>` (with `~/.claude/` populated only by an empty-permissions `settings.json`) — and update R1 / outstanding-risks to document this contingency. Add a T0.7 sub-step that ALSO tests `--setting-sources "user"` (the trivial non-empty positive control) so the spike result is interpretable regardless of empty-string behavior.

### [P1] clarify A2 and `claude-tui-driver.image-content-handling-in-v1` AC are contradictory

- **Where:** `clarify.md` Pass 1 row A2 (resolution = "B. Clarified to 'single logical user message that MAY contain multiple content blocks'. Reflects current bridge behavior with images."); `claude-tui-driver/spec.md` requirement "Image content handling in v1" (strips image blocks on main-provider path, rejects on capture path).
- **Issue:** A2 explicitly permits multi-content with image blocks "to reflect current bridge behavior with images." The image-content-handling-in-v1 AC explicitly forbids them in v1. These were authored at different times (A2 pre-D13, image-content AC post-Round-1). One of them is wrong now. The clarify file is treated as a settled-question log; leaving the contradiction in is a documentation defect that will mislead implementers reading clarify for context.
- **Impact:** Reader-confusion + risk an implementer codes to A2 (allow images) instead of the AC (strip/reject). Test author may invent passing tests for image-bearing main-provider turns that the AC actually requires to be stripped.
- **Fix direction:** Amend clarify A2's resolution to: "Superseded by Round-1 finding — see `claude-tui-driver.image-content-handling-in-v1` AC. v1 strips image blocks (main path) and rejects (capture path)." Same one-line note pattern as the other Round-1 resolutions at the end of clarify.

### [P2] AC↔design coverage table is stale (24/24 claimed; specs now hold 30 ACs); `verify.md` plan inherits the undercount

- **Where:** `analyze.md` Check 3 table (24 rows, summary "24/24 ACs have at least partial design coverage"); `tasks.md` 4.5 ("canonical AC↔test mapping for all 24 ACs"); plan.md Step 15 sub-task 6.
- **Issue:** Round-1 added 6 ACs that aren't in the Check 3 table:
  - `claude-tui-driver.image-content-handling-in-v1`
  - `claude-tui-driver.hook-relay-subprocess-is-the-bridges-hook-ipc-channel`
  - `claude-tui-driver.abort-lifecycle-is-decoupled-from-stop-hook-firing`
  - `mcp-stdio-shim.shim-binary-serves-both-mcp-server-and-hook-relay-roles`
  - `mcp-stdio-shim.capture-mode-tool-calls-receive-deterministic-shim-response`
  - `transcript-stream.unknown-jsonl-entry-types-surface-as-warnings-drift-detection`
  Counting per-spec quality-checklist tables at the bottom of each spec: claude-tui-driver = 10, mcp-stdio-shim = 8, transcript-stream = 6, output-capture = 6 = 30 ACs total. analyze.md is stale; T4.5 / Plan step 15 sub-task 6's "24 ACs" wording will produce an incomplete `verify.md`.
- **Impact:** Verification mode = `retained-required` (per `review.md`); an undercount in `verify.md` lets ACs slip out of the AC↔test grep enforcement at archive. The risk is silent: archive passes because `verify.md` "covered everything it listed", but six ACs never get a mapped test.
- **Fix direction:** Update analyze.md Check 3 table to enumerate all 30 ACs (or at minimum, update the summary line + add the 6 missing rows with design references). Update tasks.md T4.5 + plan.md Step 15 sub-task 6 to say "all 30 ACs" (or remove the literal count and say "every AC ID in `specs/**/spec.md`"). Add a verify.md gate step that re-counts ACs at archive time vs the count in `verify.md`.

### [P2] AC name `claude-tui-driver.prompt-injection-via-sessionstart-hook` contradicts its body

- **Where:** `claude-tui-driver/spec.md` requirement "Prompt injection via SessionStart hook".
- **Issue:** The requirement body explicitly says "the driver SHALL deliver the pi user prompt to `claude` via the documented `[prompt]` positional CLI argument (text content) and SHALL NOT type the prompt into the PTY's stdin in interactive mode." No mention of SessionStart in the body. The name encodes the old design (pre-D13) where SessionStart was the injection path. Spec name now actively misleads anyone reading the title without the body.
- **Impact:** AC IDs are how `verify.md` will grep test files. Test authors writing to the AC name may build the wrong harness ("test that SessionStart payload carries the prompt") and the test will fail or assert the wrong invariant. Plus the AC ID is permanent (archive-time slug); renaming later requires hunting through verify.md, test files, and any cross-references.
- **Fix direction:** Rename the requirement to "Prompt injection via positional CLI argument" before tasks/plan starts being executed against it. Update the AC ID slug accordingly. Update any cross-references in design.md / analyze.md / clarify.md. Add a short pointer in clarify A2's resolution row to the renamed AC.

### [P2] Integration tests for tool-isolation rely on model behavior, not deterministic MCP introspection

- **Where:** plan.md Step 1 sub-task T0.7 ("ask the model to list its available tools"); tasks.md 1.15 ("claude-tui-driver.pty-spawn-with-model-selection scenario 'User-global MCP server isolated from the spawned PTY'"); the corresponding spec scenario in `claude-tui-driver/spec.md` ("verified by `tools/list` MCP introspection or by the absence of such tools in the transcript").
- **Issue:** Asking the model "what tools do you have" is non-deterministic — models hallucinate tool names, summarize tool categories, or omit advertised tools they don't expect to use. The spec scenario hedges with "or by the absence of such tools in the transcript", but absence-proves-absence requires running long enough to be sure the model wouldn't have called the tool, which is also unreliable. The MCP `tools/list` path is the only deterministic check.
- **Impact:** The isolation tests are the constitution-IV evidence — if they pass on a flaky basis, regressions slip in unnoticed. Worse, a future CC release that loosens isolation could pass the model-ask test but fail a real `tools/list` audit.
- **Fix direction:** Rewrite the T0.7 spike (and the T1.15 / T1.16 integration tests) to drive a deterministic MCP `tools/list` request against the spawned `claude`'s MCP surface — either by writing a short MCP client that connects to the bridge's shim and asks `tools/list` directly (proves what the shim advertises), or by running `claude mcp` (the documented subcommand visible in `claude --help`) against the spawned configuration to enumerate the loaded server tools. Update the spec scenario to require the deterministic introspection path (drop the "or in the transcript" fallback).

### [P2] PreToolUse hook adds fork latency proportional to tool-call count, for an informational-only payload

- **Where:** `design.md` D9 (hook set), D11 layer 5; risk R12 ("hook fork latency ~100ms per hook, empirically negligible for the four hooks the bridge registers").
- **Issue:** PreToolUse fires per tool emission, not per turn. A turn with 20 bridged tool calls incurs ~2s of pure hook-subprocess fork/exec latency, on top of bridge IPC and pi-tool execution. The hook is described as INFORMATIONAL ("does not gate; the deny-set already prevents the call from succeeding"). R12's "four hooks" framing is wrong — it counts hook types, not invocations.
- **Impact:** Real per-turn latency tax for any tool-heavy turn; bridge users may attribute it to pi. Constitution IV's enforcement is already complete without PreToolUse (deny-set + strict-mcp + setting-sources + shim rejection = 4 layers). The PreToolUse log message has zero gating value.
- **Fix direction:** Either (a) drop PreToolUse from D9/D11 and rely on the four other layers for constitution IV; the shim already logs every `tools/call` so the observability concern is already addressed in-process. Or (b) keep PreToolUse but rewrite R12 to acknowledge it fires per-emission, document the latency expectation honestly, and add a Phase 4 benchmark (with measurement results) so the trade-off is informed rather than asserted-negligible.

### [P2] Constitution III phrasing doesn't address bridge as the indirect cause of `~/.claude/projects/` growth

- **Where:** `openspec/constitution.md` principle III; design.md R13 ("every bridge-spawned PTY accumulates a transcript file on disk"); proposal.md Impact "Interactive mode does NOT support `--no-session-persistence`".
- **Issue:** Constitution III forbids the bridge from writing under `~/.claude/`. The design literally avoids `fs.write*` calls — formally compliant. But every PTY spawn (including every capture call from a skill) causes `claude` to write a transcript file the bridge will never clean. Capture mode is high-frequency by design. The bridge is the proximate cause of these files existing; the user gets no opt-out short of removing capture-mode consumers. The constitution's enforcement language ("CI grep for any write under `~/.claude/`") catches the spec violation but not the de-facto pollution.
- **Impact:** Long-running pi installations accumulate transcript files at the rate of `claude` invocations, much higher than the user's own `claude` usage. After a year of capture-mode skills, this is a non-trivial disk footprint with no documented cleanup story.
- **Fix direction:** Either (a) amend constitution III with a clarifying sentence: "The bridge's spawning of `claude` necessarily causes `claude` to write transcript files; the bridge MAY document a user-runnable cleanup step but does not own the cleanup loop." Plus a CHANGELOG / README note advising users on rotation. Or (b) accept the principle is silent on this case but add an outstanding-risk with an owner and a tripwire (e.g., "if `~/.claude/projects/<encoded-cwd>/` exceeds 1GB, surface in pi telemetry"). Currently the design defers entirely with R13's "Mitigation deferred unless disk usage becomes a complaint" — the constitution text should reflect that decision.

### [P2] `claude` binary version pinning is planned in R1 but not captured in any task

- **Where:** design.md R1 ("pin a tested `claude` version range in README"); tasks.md (no task implements this).
- **Issue:** R1 mitigation says "pin a tested version range in README", but there's no task that does it. T0.x spikes record findings against whatever `claude` is on `$PATH` at spike time; that version isn't captured anywhere reviewable. If a Phase 0 spike found behavior X on `claude 2.1.114` and the user upgrades to 2.2.x before cut-over, none of the Phase 0 verifications carry forward.
- **Impact:** The Phase 0 spike artifacts are version-anchored evidence but the design's compatibility envelope isn't. README will ship saying "works with claude" without a specific range.
- **Fix direction:** Add a task (e.g., T4.7) to record the spike-time `claude --version` output in `.spike-notes/00-claude-version.md`, pin the tested-against range in README (`>=2.1.x <2.2.x` or whatever the spike result supports), and add a runtime check in `src/driver/pty.ts` that warns (not errors) on version skew at spawn time.

### [P2] Test harness for `~/.claude/` write-audit (T4.2) lacks a concurrent-test plan

- **Where:** tasks.md 4.2 ("audit constitution III enforcement — grep production code for writes to `~/.claude/`; CI asserts none"); plan.md Step 15 sub-task 2.
- **Issue:** Static grep catches obvious `fs.writeFile('~/.claude/...')` patterns but not dynamic path construction (`path.join(os.homedir(), '.claude', ...)`) where the literal `~/.claude` never appears in code. The audit also doesn't include a runtime check during integration tests (e.g., snapshot `~/.claude/` directory listing pre-test, run test, diff post-test, assert no new bridge-owned files).
- **Impact:** A future code change that constructs the path dynamically would silently pass CI but violate the principle.
- **Fix direction:** Strengthen T4.2 to (a) grep for `\.claude` AND `homedir.*claude` AND `os\.homedir.*claude` AND any join expression terminating in `.claude`; (b) add a runtime test that diffs `~/.claude/` directory listing across each integration test run and asserts no new bridge-attributable file (transcript files written by `claude` itself are allowed; bridge-attributable means anything in `sessions/`, `settings.json`, etc.).

### [P3] D5 alternatives don't acknowledge `claude --json-schema` (visible in `claude --help`)

- **Where:** design.md D5 "Alternatives considered".
- **Issue:** `claude --help` documents `--json-schema <schema>` — "JSON Schema for structured output validation. Example: ..." This is the closest native equivalent to capture mode and is not mentioned in D5's alternatives list. It may be `--print`-only (the help text doesn't say), which would re-raise the SDK-trust concern, but the omission is conspicuous and a reader will ask.
- **Impact:** Decision-record incomplete; future revisit of D5 will rediscover this and waste cycles.
- **Fix direction:** Add an alternative to D5: "**Use `claude --json-schema '<schema>'`.** Native structured-output validation built into `claude`. Rejected because (verify in Phase 0) it may be `--print`-only; if so, same SDK-trust concern applies. Even if available in interactive mode, the forced-MCP-tool-call pattern integrates more cleanly with the rest of the architecture (single MCP shim handles both pi-tool routing and capture)." Add a Phase 0 mini-spike (T0.x) to check `--json-schema` availability in interactive mode so the dismissal is evidence-backed.

### [P3] `--bare` mode interaction not addressed

- **Where:** design.md D1 flag list (no mention of `--bare`); proposal.md (none).
- **Issue:** `claude --help` documents `--bare` as "skip hooks, LSP, plugin sync, attribution, auto-memory, background prefetches, keychain reads, and `CLAUDE.md` auto-discovery." The design relies on hooks for transcript-path discovery and PreToolUse logging. `--bare` would break this. The design should explicitly state "`--bare` MUST NOT be set" (negative requirement). Conversely, `--bare`'s skipped items (CLAUDE.md, auto-memory) are exactly the leak vectors P1#1 above is concerned about, suggesting a partial `--bare` would be desirable but isn't possible.
- **Impact:** A future contributor reading `claude --help` may add `--bare` thinking it tightens isolation, and silently break the transcript stream.
- **Fix direction:** Add a sentence to D1: "The driver MUST NOT pass `--bare`; `--bare` disables hooks, which the design relies on for transcript-path discovery." Add an assertion to T4.3 that the disallowed-flags set includes `--bare`.

### [P3] Capture-mode "deterministic shim response" relies on model compliance with English instructions

- **Where:** design.md D16; `mcp-stdio-shim/spec.md` requirement "Capture-mode tool calls receive deterministic shim response".
- **Issue:** The shim returns `{ "content": [{ "type": "text", "text": "Capture received. End your turn now." }] }`. The model is expected to interpret this English text and emit `end_turn`. A model that ignores or misreads this instruction (e.g., re-emits the capture tool, or proceeds with explanatory text) wastes tokens and creates the "multiple capture calls" race that D16 step 4 then handles via -32603. The whole flow leans on model-prompting at a critical lifecycle boundary.
- **Impact:** Capture-mode tail latency may be unstable; in pathological cases the model loops on text before honoring end_turn.
- **Fix direction:** Add a Phase 4 test that measures capture-mode turn count distribution (tokens emitted post-tool-call) across N runs to ensure the deterministic response actually terminates promptly. If the distribution is wide, consider also setting a strict capture-path `max_tokens` ceiling via inline `--settings` (if available) so a runaway turn caps quickly.

### [P3] Post-Phase-3 rollback footprint is wider than R14 acknowledges

- **Where:** design.md R14 ("CHANGELOG documents post-Phase-3 rollback as `npm install pi-claude-bridge@<previous>`"); plan.md Step 14 ("the previous 4 commits are individually revertible").
- **Issue:** Post-Phase-3 rollback in this repo (not just downstream-installer rollback) requires reverting: SDK code deletion (Step 14.2), package.json dep removal (Step 14.3), README final pass (Step 14.5), CHANGELOG breaking entry (Step 13.3), AskClaude removal commit (Step 13.1). That's at least 5 git reverts spanning Step 13 and Step 14, plus the merge of any in-flight work that landed on top. R14 calls it "one git revert chain away" which understates this.
- **Impact:** If a critical post-cut-over bug emerges, the rollback effort is larger than R14 suggests; that gap may delay the rollback decision.
- **Fix direction:** Update R14 to enumerate the actual revert set (Steps 13.1, 13.3, 14.1, 14.2, 14.3, 14.5) and recommend a rollback-rehearsal in Phase 4 (`git revert <range>; npm test`) to confirm the revert chain produces a working tree.

### [P3] D7-final flag interaction with `--exclude-dynamic-system-prompt-sections` undocumented

- **Where:** design.md D7-final.
- **Issue:** `claude --help` says `--exclude-dynamic-system-prompt-sections` "Only applies with the default system prompt (ignored with `--system-prompt`)." This means when `--system-prompt` is set, dynamic sections (cwd, env info, memory paths, git status) are NEITHER excluded NOR injected, because the default system prompt isn't loaded at all. That's the intended outcome but the design doesn't cite this interaction as evidence; cite it.
- **Impact:** Documentation completeness only — no functional issue if the interaction holds as `claude --help` describes.
- **Fix direction:** Add one sentence to D7-final: "Per `claude --help`, `--exclude-dynamic-system-prompt-sections` is ignored when `--system-prompt` is set, which confirms our intended behavior: setting `--system-prompt` replaces the entire default prompt (no dynamic sections appended)."

## Challenged Assumptions

1. **"The user-facing TUI is the surface Anthropic is most committed to keeping unrestricted."** D1 rationale. This is asserted without evidence beyond smithersai/claude-p's blog post. It's plausible but the proposal frames it as the foundational motivation. The counter-argument: the TUI is what their growth team controls, so it's subject to UX-driven flag deprecation cycles as much as `-p`. The bridge's hard dependency on hook payload shape + transcript JSONL shape + inline `--settings` JSON shape is just as exposed to product changes as the SDK is — arguably more, because the user-facing TUI ships more frequently than the SDK does.

2. **"Per-block streaming is acceptable UX (sentence-ish chunks)."** D4 rationale. This is asserted but not benchmarked against pi's current UX expectations. Pi users used to per-token streaming may experience the new cadence as "stalled". Worth a Phase 0 mini-spike: record a real turn through both SDK (per-token) and JSONL-tail (per-block) and have a human compare. CHANGELOG-as-documentation isn't a substitute for UX validation.

3. **"`node-pty` alone is likely sufficient for `claude` interactive boot."** R11 / T0.6 spike. The smithersai/claude-p evidence cited in R11 suggests it's NOT sufficient. The spike is framed as binary (sufficient / not sufficient) but the realistic outcome is "sufficient until a CC release adds a new terminal query, then it breaks." The ANSI responder isn't a one-time mitigation; it's an ongoing maintenance surface. Worth a stronger commitment to building the responder up front rather than waiting for the spike result.

4. **"AskClaude has limited known consumers."** D6 rationale. There's no evidence cited for "limited" — no telemetry, no survey, no grep of downstream pi extensions. The removal may be the right call regardless, but the rationale should be stated honestly: "we choose to drop it because the maintenance cost outweighs the cost we'd pay to keep it, regardless of consumer count."

5. **"PreToolUse hook is empirically negligible latency."** R12 "negligible for the four hooks the bridge registers" — this conflates per-event hooks (PreToolUse, fires per tool emission) with per-session hooks (SessionStart, Stop, SessionEnd). See P2 finding above.

## Stronger Alternatives

1. **Capture mode via `--json-schema` (if available in interactive mode).** If Phase 0 confirms `--json-schema` works in interactive mode, the entire D5 + D16 stack (forced MCP tool-call + deterministic shim response + first-wins multi-call handling + repeated-call -32603 error) reduces to "set `--json-schema` to the capture tool's schema; harvest the validated output." Massively simpler. Worth verifying before committing to D5.

2. **Per-PTY `HOME` override instead of (or as fallback to) `--setting-sources ""`.** Spawn each PTY with `HOME=<scratch>` where `<scratch>/.claude/settings.json` is an empty-permissions skeleton. This is bulletproof — `claude` has no path to user-global settings because there's no `~/.claude/` to find. Removes the `--setting-sources ""` syntax uncertainty entirely; works on any `claude` version.

3. **Drop PreToolUse hook entirely.** The four other defense-in-depth layers fully cover constitution IV; PreToolUse's only contribution is a log line. The shim already logs every `tools/call`. Removing PreToolUse drops per-tool-emission fork latency to zero.

4. **Pin `claude` binary version at runtime (not just in README).** Read `claude --version` at bridge init; if outside the tested range, log a warn and proceed (or fail-closed depending on owner preference). Surfaces version skew before it manifests as schema-mismatch bugs.

5. **Use a single multiplexed unix socket per bridge instance instead of one socket per PTY.** R10 mitigation generates random per-PTY paths; this requires `randomBytes` ceremony, socket-path cleanup, and N file handles for N PTYs. A single socket with per-PTY connection IDs is more standard Node IPC and matches MCP's own multiplexing model. Worth evaluating; D3 picked per-PTY without comparing.

## Open Questions

1. **Does `--system-prompt` in interactive mode also suppress `CLAUDE.md` auto-discovery and auto-memory loading?** Critical for capture-path constitution V compliance. Phase 0 T0.8 doesn't currently test this. (Addressed in P1#1.)

2. **Does `--setting-sources ""` actually mean "load nothing"?** Or is empty-string an error / "load default"? Phase 0 T0.7 covers it but has no documented fallback. (Addressed in P1#2.)

3. **Does `claude --json-schema` work in interactive mode, or only with `--print`?** Bears on D5 alternatives. (Addressed in P3#1.)

4. **What's the per-emission cost of a PreToolUse subprocess hook in real terms (cold-start of a Node script)?** R12 asserts ~100ms; needs measurement. (Addressed in P2#1.)

5. **What's the `claude` version range the Phase 0 spikes were run against?** Not captured anywhere. (Addressed in P2#3.)

6. **Does the model reliably end its turn after receiving the capture-mode "Capture received. End your turn now." response, or does it produce additional text/tool-calls on a measurable percentage of turns?** D16 assumes high compliance; not empirically validated. (Addressed in P3#3.)

7. **Mid-turn cwd change behavior** — clarify I4 deferred this as "undefined; pi doesn't currently expose mid-turn cwd changes." Will remain a tripwire until pi adds the capability; no action needed now beyond keeping it on the outstanding-risks list (already there).

## Minimal Revision Checklist

Apply these before Phase 0 starts:

- [ ] **Rewrite T0.8** to verify `--system-prompt` in interactive mode (via `node-pty`), inside a directory with a fixture `CLAUDE.md`, with no `--bare`. Assert the model's reported system prompt contains the sentinel and no `CLAUDE.md` content. Document the test harness in `.spike-notes/`.
- [ ] **Add fallback path to D11** for `--setting-sources ""` failure: per-PTY `HOME` override. Add a T0.7 sub-step that tests `--setting-sources "user"` as a positive control alongside `""`.
- [ ] **Resolve clarify A2 vs `image-content-handling-in-v1` AC contradiction.** Amend A2's resolution row to point at the AC as the authoritative answer.
- [ ] **Update analyze.md Check 3 table** to include the 6 Round-1-added ACs. Update the summary line from "24/24" to the correct count.
- [ ] **Rewrite tasks.md T4.5 + plan.md Step 15 sub-task 6** to drop the literal "24 ACs" and use "every AC ID in `specs/**/spec.md`" instead.
- [ ] **Rename AC `claude-tui-driver.prompt-injection-via-sessionstart-hook`** to reflect its positional-CLI-arg body; update cross-references.
- [ ] **Rewrite T0.7 / T1.15 / T1.16 verifications** to use deterministic MCP `tools/list` introspection rather than asking the model what tools it has. Update the spec scenario's "or in the transcript" hedge to require deterministic introspection.
- [ ] **Decide PreToolUse hook fate**: either drop it from D9/D11 or fix R12's "negligible" framing to acknowledge per-emission latency and add a Phase 4 benchmark.
- [ ] **Amend constitution III** (one sentence) or add an outstanding-risk row for transcript file accumulation; reconcile with R13's "deferred" stance.
- [ ] **Add a task** to capture `claude --version` at spike time and pin a tested range in README; add a runtime version-skew warn in `src/driver/pty.ts`.
- [ ] **Strengthen T4.2** to detect dynamic-path constructions of `~/.claude/...`, plus a runtime directory-diff check during integration tests.
- [ ] **Add `--bare` to disallowed-flags assertion** in T4.3.
- [ ] **Add an alternative to D5** acknowledging `claude --json-schema`; add a Phase 0 mini-spike to verify whether it's interactive-mode-available.
- [ ] **Add a sentence to D7-final** citing `--exclude-dynamic-system-prompt-sections`'s documented interaction with `--system-prompt` as the basis for "no dynamic sections appended" claim.
- [ ] **Update R14** to enumerate the actual revert set; add a Phase 4 rollback-rehearsal action.
