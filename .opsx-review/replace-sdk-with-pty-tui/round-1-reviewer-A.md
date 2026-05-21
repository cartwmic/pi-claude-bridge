# Round 1 — Reviewer A (claude-bridge/claude-opus-4-7)

## Verdict

**needs revision** — the design hand-waves the actual mechanism by which Claude Code hooks fire (they are out-of-process shell commands, not in-process callbacks), it silently regresses multi-turn message structure to a flat text blob, several factual references to the on-disk transcript location are wrong, and at least three constitution-relevant configuration surfaces (`--strict-mcp-config`, `--setting-sources`, `--permission-mode`) are unaddressed — any of which can defeat principle IV's defense-in-depth or principle III's "don't pollute the user's `claude` setup."

## Findings

### [P0] Hook execution model is unspecified and incompatible with the described "in-process handler" framing

- **Where:** `design.md` D9 (lines 163–174); `specs/claude-tui-driver/spec.md` "Prompt injection via SessionStart hook"; multiple references to "hook handlers (`SessionStart`, `Stop`, `PreToolUse`)" throughout the change.
- **Issue:** Claude Code hooks configured via `settings.json` (or `--settings`) are not in-process callbacks — they are **shell commands** that the `claude` binary spawns as child processes, receiving a JSON payload on stdin and communicating back via stdout/exit-code (verifiable: `~/.claude/settings.json` shows hook entries as `{ "type": "command", "command": "..." }`). The design talks about "the bridge's hook handlers" and "WHEN the driver's `SessionStart` hook fires and provides a `transcript_path`" — but there is no description of:
  - which executable the bridge writes to disk (or names inline) as the hook command,
  - how the hook process communicates the payload back to the long-lived bridge process (extra unix socket? piggyback the MCP shim's IPC channel? a temp file?),
  - what the latency budget of "fork-exec a node script per hook event" does to the per-turn cost,
  - how the bridge correlates multiple concurrent PTYs' hook events to the correct in-flight turn frame.
- **Impact:** This is the load-bearing IPC mechanism for *everything* downstream — prompt injection timing, transcript-path discovery, Stop-driven turn finalization, PreToolUse defense-in-depth. A capability spec that names hooks but no hook IPC contract is unimplementable as written. Risk of Phase 1 stalling on "how do we even get the transcript path back from the SessionStart hook subprocess?"
- **Fix direction:** Add a new design section ("D12: Hook IPC channel") that explicitly states (a) hook commands are short-lived child processes spawned by `claude`, (b) the bridge writes a per-PTY hook-relay executable (or reuses the shim's IPC socket + a `--hook-event=session-start` argument), (c) each hook process forwards its stdin payload to the bridge's in-process router and waits for any structured reply (e.g., for `SessionStart`'s `additionalContext` or `PreToolUse`'s deny verdict) before exiting. Then add an AC under `mcp-stdio-shim` (or a new `hook-relay` capability) covering the channel.

### [P0] "Inject the pi user prompt into the PTY" has no specified mechanism

- **Where:** `specs/claude-tui-driver/spec.md` "Prompt injection via SessionStart hook" (both Scenarios); `design.md` D9 ("SessionStart — capture transcript path; inject pi prompt into PTY").
- **Issue:** The interactive `claude` TUI does not accept user input through any documented programmatic channel besides typing characters into its prompt box. The spec/design name three semantically different injection points and never pick one:
  1. **CLI positional argument** — `claude [options] [prompt]` works for fresh invocations but cannot deliver multi-content (image) blocks; not viable for image-bearing turns flagged in clarify A2.
  2. **SessionStart hook's `hookSpecificOutput.additionalContext`** — that surface adds to the *system context*, not the user message; semantically wrong (and violates constitution V if used on the capture path).
  3. **Typing into the PTY** — fragile against TUI re-renders, multi-line content, paste-mode detection, and brackets-paste-mode escapes; no spec defines the byte sequence.
- **Impact:** The most basic operation in the new driver — "deliver pi's user message to claude" — is undefined. With multi-content blocks (text + image), there is currently *no* mechanism in interactive `claude` to inject an image inline; `--file <id:relative_path>` is for file uploads with their own ID. Phase 1 will hit this on day one.
- **Fix direction:** Pick the mechanism per content shape and lock it in the spec. At minimum: (a) text-only fresh turn → CLI positional arg; (b) text-only resumed turn → write to PTY stdin with an explicit byte protocol; (c) image content → list specific mechanism or amend the AC to say "text-only in v1, image content is rejected with `stopReason: error`." Phase 0 needs a sixth spike to prove the chosen mechanism works for multi-line input.

### [P0] Cold-start multi-turn history is silently flattened to one text blob — significant regression vs the SDK

- **Where:** `specs/claude-tui-driver/spec.md` "Prompt injection via SessionStart hook" → "Cold-start replay" scenario ("the injected prompt contains the full pi history flattened to text per the bridge's existing conversion contract"); design `Compat envelope` ("`piAi.complete()` external shape unchanged").
- **Issue:** Today's SDK accepts structured multi-message input — user, assistant, tool_result roles preserved, image blocks intact, tool-call/tool-result pairs structurally typed. The new driver has **no way to seed multi-message history** on a cold start; interactive `claude` accepts at most one initial prompt. The spec papers over this with "flattened to text per the bridge's existing conversion contract" but that contract today exists to convert pi messages to the SDK's structured input — not to flatten roles into a single string. Models perform worse on flat-text conversation transcripts vs proper role-tagged history. Any pi divergence event (fork, compact, cwd change, history-hash mismatch) re-flattens the entire history every time — i.e., the cache-miss path is now strictly worse than the SDK era.
- **Impact:** Capability regression on every cache-miss turn. The "preserved" claim in `compat envelope` is misleading; this is a non-trivial behavior change that downstream consumers will feel as quality degradation, especially on long pi conversations or right after a fork/compact.
- **Fix direction:** Either (a) demonstrate that `--resume <session-id>` + ability to seed `claude` with structured prior messages is feasible (it is not, AFAIK, in interactive mode); or (b) document the regression explicitly in `proposal.md` Impact + CHANGELOG as a known capability loss, and add a Phase 0 spike that measures eval-quality delta on a representative multi-turn benchmark; or (c) keep an SDK-backed cold-start path for cases with non-trivial history (defeats the "zero SDK" goal but is honest).

### [P0] Transcript JSONL on-disk location is misnamed throughout the change (factual error)

- **Where:** `specs/claude-tui-driver/spec.md:68` ("transcript JSONL files under `~/.claude/sessions/<id>/`"); `design.md:51` ("never reads `~/.claude/sessions/` for anything other than the transcript path"); `proposal.md` line 12 ("the latter may be read for transcript JSONL only"); `plan.md` step 1 ("`~/.claude/sessions/<id>/transcript.jsonl`"); `openspec/constitution.md:36` (same wording). Verifiable on this system: `~/.claude/sessions/` contains PID-keyed metadata files (`<pid>.json`), and the actual transcripts live under `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`.
- **Issue:** Every artifact in the change names the wrong directory. The constitution-level statement at `openspec/constitution.md:36` ("the inference driver's session store (`~/.claude/sessions/`)") is also miscalibrated, which means the principle that's supposed to be the load-bearing safety rail names a directory that has nothing to do with the artifact it's trying to protect.
- **Impact:** (a) Spike T0.2 in `plan.md` (`tail ~/.claude/sessions/<id>/transcript.jsonl`) will literally not find a file. (b) The Constitution III CI grep ("CI grep for writes to `~/.claude/`") may pass while the real risk surface (`~/.claude/projects/`) is unmonitored. (c) Implementer confusion if the path comes via the hook payload but the spec text suggests a different directory.
- **Fix direction:** Update all artifacts (proposal, design, specs, plan, constitution) to (i) name `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` as the real transcript location, (ii) make explicit that the bridge does not hardcode any path — it uses the hook-delivered `transcript_path` as the sole source of truth — and (iii) extend the constitution III enforcement check to grep for writes anywhere under `~/.claude/`, not just `~/.claude/sessions/`.

### [P1] `--mcp-config` without `--strict-mcp-config` leaks user-global MCP servers into the PTY

- **Where:** `design.md` D1 ("inline `--mcp-config`"); all spec scenarios that name `--mcp-config`; not mentioned in `D11` defense-in-depth.
- **Issue:** Per `claude --help`, `--mcp-config <configs...>` adds MCP servers; `--strict-mcp-config` exists precisely to "only use MCP servers from `--mcp-config`, ignoring all other MCP configurations." Without it, every PTY the bridge spawns inherits the user's globally-configured MCP servers — i.e., the user's editor MCP, browser MCP, custom analyze_image MCP, etc. — and exposes those tools to the model. That punches a clean hole through constitution principle IV.
- **Impact:** Constitution IV violation in the default configuration. Defense-in-depth via shim rejection only catches `mcp__custom-tools__*` impostors — it has no way to reject `mcp__user-global-server__*` tool calls because the shim never sees them; they go through the user's own MCP server processes.
- **Fix direction:** Add `--strict-mcp-config` to D1 + the `pty-spawn-with-model-selection` AC's spawn-arguments list. Add a scenario asserting that with a configured user-global MCP server present in `~/.claude/settings.json`, the spawned PTY exposes none of its tools.

### [P1] `--setting-sources` is unaddressed; user/project/local settings can override the bridge's inline `--settings`

- **Where:** `design.md` D1 / D7 / D11; `specs/claude-tui-driver/spec.md` "Native tool emission is blocked at driver configuration."
- **Issue:** `claude --help` documents `--setting-sources <sources>` ("Comma-separated list of setting sources to load (user, project, local)"). When `--settings '<json>'` is passed alongside default setting-source loading, the merge order can let user/project/local settings *override* the bridge's permissions or hook configuration (especially `permissions.allow` for native tools and additional hooks). The proposal does not pin `--setting-sources` to an empty or minimal value.
- **Impact:** A user with `~/.claude/settings.json` containing `permissions.allow: ["Bash(*)"]` could re-enable a tool the bridge believes it disallowed. Same for additional `PreToolUse` hooks that the user configured (e.g., the ones present in the reviewer's settings.json blocking `mcp__4_5v_mcp__analyze_image`) — these will fire alongside the bridge's hooks and may interact unpredictably.
- **Fix direction:** Add `--setting-sources ""` (or whatever the documented "load nothing" value is — verify in Phase 0) to every spawn. Add an AC scenario: with a user-global `permissions.allow` granting a disallowed tool, the bridge's PTY still blocks that tool.

### [P1] No `--permission-mode` selection; TUI may open interactive trust/permission dialogs that block the PTY

- **Where:** `design.md` D1 / D9; `specs/claude-tui-driver/spec.md` Requirement set.
- **Issue:** Interactive `claude` prompts the user for workspace trust on first-use, for MCP server trust when seeing a new `--mcp-config` entry, for OAuth refresh, and for tool-use permission (default mode requires confirmation). None of these dialogs can be answered programmatically by the bridge — they'll just block. The design says nothing about which `--permission-mode` to use (`default` / `acceptEdits` / `auto` / `bypassPermissions` / `dontAsk` / `plan`).
- **Impact:** First-run-on-fresh-cwd: every PTY spawn could hang indefinitely waiting for a permission dialog the bridge can't see (because we never parse the TUI screen). The "missing-binary surfaces as error" AC covers `claude` not on PATH, but not "claude on PATH but waiting for human input." Per constitution VII, this would need to surface as `stopReason: error` with a clear cause — currently it'll just look like an unresponsive PTY.
- **Fix direction:** Pin `--permission-mode bypassPermissions` (or equivalent) for bridge-driven PTYs in D1 + the PTY-spawn AC. Add an AC scenario for a fresh cwd that asserts the spawn completes without human interaction. Document the security implication in README (bridge-driven `claude` runs without per-tool permission prompts because the shim's allow-list is the security boundary).

### [P1] Capture mode is not actually "forced" — model can emit text and exit without calling the tool

- **Where:** `design.md` D5; `specs/output-capture/spec.md` "Synthesized `toolCall` content block on success" + "Surface absent capture-tool call as error"; clarify A9, A10, I3.
- **Issue:** Today's SDK `outputFormat` mode supplies the JSON Schema directly to the model as a constrained-decoding target (functionally close to a tool-only response). The proposed replacement registers the schema as the sole MCP tool and disallows native tools — but **there is no mechanism that compels the model to actually call the tool**. The model can produce a text-only reply (because the user's `ctx.systemPrompt` says nothing about being required to call a tool, per constitution V's "forward verbatim" requirement on the capture path) and exit. Then the bridge surfaces "model did not call capture tool" as an error — but that's not a faithful replacement of `outputFormat`'s guarantee class. Clarify A9 claims "MCP servers validate args at the protocol boundary" — true for *invalid args* once the model calls the tool, but irrelevant if the model never calls it at all.
- **Impact:** Capture-mode success rate may drop substantially vs the SDK era, especially for shorter / chatty prompts. "Same guarantee class as today's SDK `outputFormat`" (design D5 final paragraph) is not supported by the mechanism. Real consumers (skills relying on capture mode for digest extraction etc.) will see new error rates.
- **Fix direction:** Either (a) acknowledge the guarantee gap and document it (downgrade D5's "same guarantee class" claim, add a retry-with-nudge pass to the capture path); or (b) carve out a narrow exception to constitution V's "verbatim" rule for the capture path *only* — appending a short system suffix like "You MUST call the `<tool>` tool with your answer; do not produce any text reply" — and update principle V accordingly (this *is* a substantive principle change and should be done deliberately, not by accident); or (c) drop capture mode entirely as a clean break.

### [P1] Abort during mid-tool-round leaves the shim's parked Promise unanswered

- **Where:** `design.md` D10; `specs/claude-tui-driver/spec.md` "Abort propagates to the PTY"; `specs/mcp-stdio-shim/spec.md` "Shim forwards tool calls" (clarify A5 chose "handler stays parked indefinitely").
- **Issue:** Today's bridge parks the SDK handler's Promise until pi delivers the next tool result, and pi abort surfaces as the SDK throwing on its iterator. In the new design, abort SIGINTs the PTY, which kills claude. But the shim has a `tools/call` request *currently in flight* with a parked Promise. That call's result is never returned to the (now-dead) driver, which is fine — but the shim doesn't know to reject the Promise, the router holds onto a stale entry, and pi's tool-execution callback may still resolve later. There is no AC describing the abort-cleanup contract on parked router entries.
- **Impact:** Memory leak per aborted mid-tool turn; pi's delivered tool result (when it finally arrives via `streamSimple`) has nowhere meaningful to go and may either be silently dropped (constitution VII violation — silent degradation) or routed to a phantom frame.
- **Fix direction:** Add an AC under `mcp-stdio-shim` or `claude-tui-driver`: WHEN pi signals abort, THE router SHALL reject all parked tool-call Promises for the aborted PTY's turn with a structured error, AND the shim SHALL log a warn-level entry for each parked call dropped. Update `design.md` D10 to describe this cleanup explicitly.

### [P2] Spec wording ("MCP protocol validates args") misstates how MCP works

- **Where:** `clarify.md` A9 Resolution ("MCP servers validate args at the protocol boundary; the model receives a structured error and retries within the same turn"); echoed implicitly in `design.md` D5.
- **Issue:** MCP defines `tools/list` and `tools/call` and a tool's `input_schema`, but the protocol does not specify *who* validates args against the schema. In practice, the *server* (i.e., our shim) must validate and return a JSON-RPC error response with a meaningful message — the protocol itself doesn't enforce the schema. The clarify resolution language reads as if validation is automatic at the wire level; it is not.
- **Impact:** Implementer reading clarify A9 may rely on the MCP SDK to enforce schemas and skip validation in the shim. Capture mode then silently accepts invalid args.
- **Fix direction:** Rewrite the A9 resolution and the relevant spec scenarios to say "the shim's `tools/call` handler validates incoming args against the tool's declared `input_schema` and returns a JSON-RPC error if validation fails." Add an AC under `mcp-stdio-shim`: "Shim validates `tools/call` args against advertised `input_schema` before forwarding to router."

### [P2] `--include-hook-events` / `--include-partial-messages` / `--output-format=stream-json` are print-only — design's claim that the streaming contract has acceptable parity needs explicit testing

- **Where:** `design.md` D4 ("transcript JSONL tail … Per-block granularity is sufficient for pi's UX"); risk R6.
- **Issue:** All the rich streaming surfaces (`--include-hook-events`, `--include-partial-messages`, `--output-format=stream-json`) are explicitly print-only per `claude --help`. Interactive mode only writes transcript JSONL, which appears to be flushed on logical message boundaries (full assistant turn, tool block, etc.) — not on every token. So the latency between user-perceived characters and pi's stream may be substantially worse than "sentence-ish chunks." Phase 0 has no spike measuring write cadence on the transcript file during an in-flight assistant turn.
- **Impact:** UX regression may be larger than R6 acknowledges. Some pi consumers may rely on per-token feedback (e.g., progress indicators in the UI).
- **Fix direction:** Add a Phase 0 spike (T0.7) measuring transcript-file write cadence during a real claude assistant turn (lines per second, bytes per line, time between first and last byte of a logical block). Use that data to either (a) confirm "sentence-ish chunks" is real, or (b) adjust D4 and risk R6 severity.

### [P2] Disallow list is hard-coded and stale-by-design; constitution IV's "audit on upgrades" intent isn't operationalized

- **Where:** `specs/claude-tui-driver/spec.md` "Native tool emission is blocked at driver configuration" (lists 20+ specific tools); `tasks.md` 4.3 ("Audit constitution IV — assert `DISALLOWED_BUILTIN_TOOLS` matches the spec list").
- **Issue:** Constitution IV's `Maintenance` clause requires auditing new CC built-ins on upgrades. The proposed CI check just asserts the implementation's array equals the spec's array — that's tautological. There's no automated check against `claude --help`-derived tool inventory or against any external Anthropic tool catalog, so when Anthropic ships a new built-in (e.g., `MemoryStore`, `Fetch`, `Notebook` etc.) the disallow list silently goes stale and the new tool is allowed by default if it's not in the deny set.
- **Impact:** Constitution IV erosion the next time Anthropic ships a built-in tool. The "auditing on upgrades" intent quietly becomes "remembering to audit on upgrades."
- **Fix direction:** Add a CI job (or `tasks.md` 4.3) that (a) inspects `claude` for its currently-known tools (e.g., by inspecting the binary, running a fixture session, or — failing that — pinning a claude version range and reasserting the list on bump), and (b) fails closed when an unrecognized tool name appears in the model's emission (defense-in-depth in the transcript-stream consumer, in addition to driver-config + shim rejection). Document the audit cadence in README.

### [P2] Rollback story is asymmetric across phases and the post-Phase 3 path isn't actually clean

- **Where:** `design.md` "Rollback procedure" ("During Phases 1–2: `CLAUDE_BRIDGE_DRIVER=sdk` … After Phase 3 cut-over: rollback = revert the commits that remove the SDK path; the feature flag plumbing is the rollback seam"); `review.md` Worktree Mode "provides clean rollback."
- **Issue:** Once Phase 3 lands (SDK code deleted, deps removed, feature flag rejects `sdk` value with a deprecation error), there is *no* runtime rollback — only a code-revert + re-publish. Calling that "the rollback seam" overstates it. A bug found in production after Phase 3 release requires a forward-fix or a publish-the-previous-version. The "clean rollback" review-mode claim assumes pre-Phase-3 state.
- **Impact:** Downstream consumers who upgrade past Phase 3 and hit a regression have no in-band recovery. The CHANGELOG breaking-change entry should make this explicit.
- **Fix direction:** Either (a) keep the SDK path code (but not the dep) behind a removed env var for one release post Phase 3 as a safety buffer; or (b) honestly document that post-Phase-3 rollback requires `npm install pi-claude-bridge@<previous>`, and that the bridge ships a Phase-3 release as the next major version (`0.4.x` → `1.0.0`).

### [P2] No spec coverage for hook payload schema version pinning / drift detection

- **Where:** `design.md` R1; `specs/claude-tui-driver/spec.md`; `specs/transcript-stream/spec.md`.
- **Issue:** R1 ("Anthropic changes `SessionStart` / `Stop` / transcript JSONL schema") is acknowledged as Medium/High but the mitigation ("parse with explicit field guards; pin a tested `claude` version range in README") has no spec-level AC. There's no `transcript-stream` AC for "unknown JSONL entry type emits a structured warning naming the type" or similar drift-detection requirement. Just "malformed JSONL surfaces as warning" — but a *valid-JSON-but-unknown-schema* line is different from malformed.
- **Impact:** First time Anthropic adds a new JSONL entry kind (e.g., a new `system` notice), the bridge silently ignores it, possibly missing important state changes (like `system.session_id_rotated` per OQ4).
- **Fix direction:** Add an AC under `transcript-stream`: "WHEN the tailer encounters a JSONL entry whose top-level `type` is not in the known set {`user`, `assistant`, `result`, `system`, …}, THEN the tailer SHALL emit a `warn`-level log entry naming the offending type and SHALL continue tailing." Add a CI check that fails when `claude --version` is outside the README-pinned range.

### [P3] Tasks/plan inconsistency — task 0.2 exists but my initial read showed it stripped; verify the truncation in `tasks.md` is RTK display only

- **Where:** `tasks.md` Phase 0 (RTK-compacted output marker present at file head).
- **Issue:** The artifact is served as `[RTK compacted output: source:minimal]`. A re-read showed 0.2 *is* present, but the compacted view risks dropping tasks during downstream tooling. If `openspec-apply-change`'s diff checker also receives the compacted view, task IDs may go missing.
- **Impact:** Low; cosmetic for review but worth confirming.
- **Fix direction:** Confirm tooling reads the raw file, not the RTK-compacted view.

### [P3] D11's "three-layer" defense-in-depth (driver config + shim allow-list + PreToolUse hook) is undercounted as two layers

- **Where:** `design.md` D11 ("Native tools are blocked in two places: (a) the driver's inline `--settings` permissions config, (b) the shim's `tools/list` advertisement").
- **Issue:** D9 also registers a `PreToolUse` hook for the same purpose; clarify I1 confirms defense-in-depth is intentional. So there are actually three layers, but D11 names two and the third is buried in D9's hook list.
- **Impact:** Minor — but if a future edit drops the PreToolUse hook as "redundant," constitution IV's defense-in-depth loses a layer.
- **Fix direction:** Restate D11 to enumerate all three layers; cross-reference D9.

### [P3] "Compat envelope: external shape unchanged" overclaims given streaming granularity, history flattening, and missing-binary error class

- **Where:** `design.md` "Compat envelope."
- **Issue:** Three documented behavior changes (per-block vs per-token streaming, flattened cold-start history, new `stopReason: error` for missing-binary) are listed as "minor" or "documented" — but "external shape unchanged" reads as stronger than the reality. Downstream callers comparing message-content equality across SDK and PTY runs will see drift.
- **Impact:** Misleads CHANGELOG readers.
- **Fix direction:** Reword "external shape unchanged" → "external call-shape preserved; observable streaming granularity and cold-start prompt formatting change as documented."

## Challenged Assumptions

- **"Hook payloads are a documented contract."** — Challenged because hook *payload schemas* are documented (transcript_path, session_id, etc.) but the *hook execution model* (forking shell commands) is not the same as "in-process callback contract." The design conflates the two.
- **"Inline `--settings` configures the driver entirely without filesystem coupling."** — Challenged because, without `--setting-sources ""` and `--strict-mcp-config`, user-global `~/.claude/settings.json` and `~/.claude/mcp.json` still load *in addition*, creating implicit filesystem coupling the design claims to avoid.
- **"Per-block streaming is sufficient for pi UX."** — Challenged because transcript JSONL flush cadence in interactive mode is unmeasured. "Sentence-ish" is a guess; could be "whole-turn" in practice.
- **"Capture mode = forced MCP tool-call has same guarantee class as SDK `outputFormat`."** — Challenged because the model can choose to ignore the tool and respond with text; SDK outputFormat had a stronger guarantee (constrained decoding / functional equivalent).
- **"Capture path forwards `ctx.systemPrompt` verbatim (constitution V) AND the model reliably calls the capture tool."** — Challenged because these are in tension; one or the other must give.
- **"Driver session id is a cache hint only" preserves SDK-era semantics.** — Challenged because SDK-era semantics included the ability to pass *structured* multi-message input on cache-miss; the PTY-era cold start flattens history, so the cache-miss path is materially worse, not equivalent.
- **"Transcript file path is delivered via hook payload and we read only that path."** — Challenged because hook commands run as subprocesses; "we read" requires the hook subprocess to relay the path back over a defined IPC, which is unspecified (P0 #1).
- **"Worktree mode provides clean rollback."** — Challenged because the rollback seam only exists during Phases 1–2 when the SDK path is still present. Post-Phase-3, rollback = revert + republish.

## Stronger Alternatives

- **For D7 (system-prompt mechanism):** instead of a Phase 0 spike with three unknown candidates, write the spike *now* (it's a 10-minute experiment) and pin the answer before review closes. Phase 0 spikes that block design decisions should be done before specs go to review, not after.
- **For D3 (MCP transport):** consider folding the hook-relay command into the same shim executable, branching on `argv[2]` (`shim` vs `hook:session-start` vs `hook:stop` vs `hook:pre-tool-use`). Single binary, single IPC channel back to the bridge, fewer moving parts than separate executables.
- **For D4 (streaming):** if transcript flush cadence is too coarse, consider running `claude` in `--print --output-format=stream-json --include-partial-messages --include-hook-events` *inside a PTY*. The PTY contains a non-interactive `claude -p` invocation but appears to the bridge as a stream of JSONL events on stdout. This sidesteps the SDK (per smithersai/claude-p's observation) while keeping per-event granularity. It does re-introduce the print-mode trust concerns the proposal cites, but those are different from the SDK trust concerns (no `@anthropic-ai/*` dep needed).
- **For D5 (capture mode):** combine forced-tool-call with a single deterministic system-prompt suffix ("If you need to produce structured output, call the `<tool>` tool. Do not reply with text.") on the *capture path only*. Treat this as a constitution V exception scoped to capture, document it, and amend principle V to allow a documented capture-path-specific addendum.
- **For D9 (hook set):** drop `PreToolUse` for tool-name enforcement (it's the weakest layer — runs *after* the model has already decided to use the tool); rely on driver-config + shim, both of which prevent the call from being attempted at all. PreToolUse may still be useful for parameter-level inspection later, but not for the constitution-IV use case.
- **For rollback:** publish Phase 3 as `1.0.0` with prominent breaking-change documentation, and keep the deleted `index.ts` SDK path code in `legacy/index.sdk.ts.snapshot` (referenced but not imported) for one minor release as a documented buffer.

## Open Questions

- How does a SessionStart hook subprocess return data (transcript path, hook-specific output) to the long-lived bridge process? Reading hook stdout requires the bridge to be invoking `claude` *and* parsing each hook subprocess's exit — design says nothing about who runs the hook commands' lifecycle.
- Does interactive `claude` support a programmatic mechanism to deliver an image content block alongside a text prompt, or does the bridge need to fall back to "render image to disk + reference path in text"?
- Is `--no-session-persistence` available in TUI mode (it's documented as `--print`-only)? If not, every bridge-spawned PTY pollutes `~/.claude/projects/<encoded-cwd>/`. What's the cleanup story?
- When the user runs `claude` themselves in another terminal *while* the bridge is mid-turn, does that cause session-store contention (the user's PID file at `~/.claude/sessions/<pid>.json` vs the bridge's PTY)?
- What happens when `claude` shows a non-fatal modal (e.g., "auto-update available" notice) inside the PTY? Does it block until dismissed?
- After Phase 0 confirms (or refutes) `--system-prompt` replaces vs appends — what's the actual fallback if neither does? "Inject as first user message" violates constitution V; is principle V amendable in this change, or does it need its own dedicated principle-change proposal?
- The proposed `mcp-stdio-shim` runs in a separate process to satisfy the "separate process" AC. But why? Per analyze Check 6 there's no principle that requires it; an in-process MCP server library (called by the shim CLI command but spawned by the bridge per PTY) would be simpler. Is the process boundary a hedge against MCP-library quality issues, or a real architectural need?

## Minimal Revision Checklist

- [ ] **P0**: Add D12 "Hook IPC channel" section to design.md describing how hook subprocesses relay payloads back to the bridge. Add corresponding spec ACs (either under `mcp-stdio-shim` or a new `hook-relay` capability).
- [ ] **P0**: Pin the prompt-injection mechanism in `claude-tui-driver` spec (CLI positional arg vs PTY stdin vs hook additionalContext) per content shape; add Phase 0 spike for multi-content / image injection.
- [ ] **P0**: Document the cold-start history-flattening regression explicitly in proposal `Impact` and CHANGELOG; add a Phase 0 eval-quality spike or revise the spec to keep an SDK-backed cold-start fallback.
- [ ] **P0**: Fix every artifact's reference to `~/.claude/sessions/` for transcript JSONL (real path is `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`); broaden Constitution III's grep target to all of `~/.claude/`.
- [ ] **P1**: Add `--strict-mcp-config` and `--setting-sources ""` (or verified equivalent) to D1 + the PTY-spawn AC; add scenarios demonstrating user-global MCP/permission isolation.
- [ ] **P1**: Pin `--permission-mode bypassPermissions` (or equivalent); document the security implication in README; add an AC scenario for fresh-cwd workspace-trust suppression.
- [ ] **P1**: Reconcile the capture-mode "forced tool-call" guarantee with constitution V; either downgrade D5's guarantee claim, add a documented capture-path system-prompt addendum (and amend principle V), or drop capture.
- [ ] **P1**: Add a router/shim AC for "abort drains parked tool-call Promises with a structured error"; update D10.
- [ ] **P2**: Rewrite clarify A9 resolution to say schema validation lives in the shim (not "the MCP protocol layer"); add a corresponding `mcp-stdio-shim` AC.
- [ ] **P2**: Add Phase 0 spike measuring transcript JSONL flush cadence during in-flight turns; revise R6 severity based on results.
- [ ] **P2**: Operationalize Constitution IV's "audit on upgrades" with a concrete CI/test that detects unknown emitted tool names; document audit cadence in README.
- [ ] **P2**: Update rollback procedure: either keep SDK code in a snapshot file post-Phase 3, or honestly document "rollback = npm install previous version" and gate Phase 3 release on `1.0.0` major bump.
- [ ] **P2**: Add a `transcript-stream` AC for unknown-but-valid-JSON entry types (drift detection).
