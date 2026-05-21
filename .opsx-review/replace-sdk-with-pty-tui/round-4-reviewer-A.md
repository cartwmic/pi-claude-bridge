# Round 4 — Reviewer A (claude-bridge/claude-opus-4-7)

## Verdict

**needs revision** — D18's deterministic transcript-path computation literally violates constitution III's enforcement clause as written; argv-overflow fallback candidates listed in R15 do not actually escape the ARG_MAX budget; and `--system-prompt`-vs-CLAUDE.md isolation risk has no cascade plan that preserves D9/D12.

## Findings

### [P0] D18 deterministic transcript path violates constitution III as written

- **Where:** `openspec/constitution.md:30-44` (principle III + enforcement clause); `openspec/changes/replace-sdk-with-pty-tui/proposal.md:18-19` ("path the bridge deterministically computes... hook-delivered `transcript_path` is treated as a confirmation cross-check, not the discovery mechanism"); `design.md` D18 / `specs/claude-tui-driver/spec.md:24-29` (scenario "Transcript path is computed deterministically from the pre-generated UUID"); `analyze.md` Check 1 row III ("compliant").
- **Issue:** Constitution III says the bridge "MAY read a transcript JSONL file whose path was delivered to the bridge via a `SessionStart` or `Stop` hook payload — **and only that path**." Its enforcement bullet adds: "plus an assertion that the only paths the bridge opens for reading under `~/.claude/projects/` are those received in a hook payload." The proposal now opens a path the bridge **computed itself** from `--session-id <uuid>` + encoded cwd; the hook-delivered value is demoted to "cross-check." That is the path-discovery mechanism the principle was written to prevent (bridge encoding hard knowledge of `~/.claude/projects/` layout). `analyze.md` Check 1 marks III "compliant" without flagging this.
- **Impact:** Either the proposal violates the constitution and the CI enforcement check (per III) will fail by design, or `analyze.md` is silently treating III as relaxed. Per Governance ("Amendments require a dedicated change with Scale ≥ L and adversarial-review-cycle invoked"), a relaxation of III needs its own change, not a silent reinterpretation inside this one.
- **Fix direction:** Pick one:
  (a) Amend constitution III in a sibling change explicitly permitting deterministic path computation when the path is anchored to a UUID the bridge passed via `--session-id` (and update the enforcement clause to match). Cite it from this change's design.
  (b) Revert D18: keep hook-delivered `transcript_path` as the sole discovery mechanism, and document the failure mode if `SessionStart`/`Stop` lack the field (the OQ7 Round-3 "obsolete" annotation must be undone).
  Update `analyze.md` Check 1 either way so reviewers can trace the decision.

### [P1] R15 argv-overflow fallback candidates share the same ARG_MAX budget

- **Where:** `proposal.md:24` (note about R15); `specs/claude-tui-driver/spec.md` Requirement "Prompt injection via CLI positional argument" (fallback paragraph naming candidates "extending `--system-prompt`", `--add-dir <file-with-context>`); `design.md` R15 row; `tasks.md` T0.11.
- **Issue:** The listed fallbacks ("extending `--system-prompt` to carry overflow context" or `--add-dir`) all live in `argv` of the same `execve()` call. `ARG_MAX` on macOS (~256 KB) and Linux (varies; commonly ~128 KB stack-derived for a single arg even when total is 2 MB) bounds the **combined** argv+envp. Moving bytes from positional to `--system-prompt` does not buy capacity; it just relocates them inside the same ceiling. `--add-dir` accepts a *directory*, not a file (per `claude --help`: "Additional directories to allow tool access to"), so "referencing a temp file the bridge writes" is not a documented use of that flag and would require the model to subsequently call a Read-equivalent tool — but the bridge disallows native Read and the shim exposes only pi-bridged tools, so the model has no way to consume the file unless the bridge bridges a `read` tool and *instructs* the model to call it (which is the cold-start replay problem in disguise, plus a steering risk).
- **Impact:** Phase 0 T0.11 may correctly conclude "no fallback works" and the v1 limitation becomes "long-history pi sessions error out." That is allowed by constitution VII but is a load-bearing user-visible regression that the proposal currently softens with hopeful candidates. Implementation risks: time burned on T0.11 testing dead-end candidates; spec AC's "implementation-defined size threshold... default 200 KB" creates a brittle precision that contributors will assume *can* be tuned upward when the ceiling is OS-fixed.
- **Fix direction:** Either:
  - Identify a real non-argv channel for prompt bytes in interactive mode and pin it (candidate: write a `prompt.txt` to a path *outside* `~/.claude/` and have the positional arg be a short instruction like "Read the user's request from {path} and answer it" — but this couples to whether the model honors the indirection without a Read tool, which is dubious), or
  - Acknowledge in `proposal.md` Impact section and `design.md` R15 that "no argv-bypass fallback is known" and document the hard limit explicitly with an estimate of how many real pi sessions T0.11 sampled and how many would overflow. The current wording implies a fallback will be found; the audit should not depend on that.

### [P1] `--system-prompt` is documented as replace but is not documented to disable CLAUDE.md / auto-memory injection; the cascade plan invalidates D9/D12

- **Where:** `claude --help` output: `--system-prompt` says "System prompt to use for the session" with no mention of CLAUDE.md or auto-memory; `--bare` explicitly enumerates "skip hooks, LSP, plugin sync, attribution, auto-memory... CLAUDE.md auto-discovery"; `design.md` D7-final Phase 0 verification paragraph; `tasks.md` T0.8.
- **Issue:** Constitution V demands the capture path forward `ctx.systemPrompt` **verbatim**. If `--system-prompt` replaces only the base prompt string but `claude` continues to auto-discover `CLAUDE.md` in cwd and append it as additional context (or to load auto-memory as a separate user-context block), constitution V is violated regardless of `--system-prompt`'s value. The design's only escape hatch is `--bare`, which the design itself notes "disables hooks; this would invalidate D9/D12" (transcript discovery via `Stop`, hook-relay subprocess). If T0.8 finds leakage, the proposal's "hard blocker / consider amending constitution V" sentence is doing all the work — there is no decided cascade.
- **Impact:** A Phase 0 spike result could force re-architecting both the hook channel and the transcript-discovery mechanism. That is a substantial design rewrite, not a tweak. The current artifacts treat this as a contingency without a worked Plan B.
- **Fix direction:** Before approving execution, write the conditional Plan B in `design.md` D7-final: "IF `--system-prompt` does not isolate AND `--bare` is required, THEN hooks are replaced by [X] and transcript discovery uses [Y]". Candidates for [X] include polling-only transcript tail (no hooks needed at all once D18 commits to deterministic paths — see [P0] above), and [Y] is the same deterministic path. This converts a hand-waved risk into a designed contingency.

### [P2] Disallow list not validated against the real Claude tool surface

- **Where:** `specs/claude-tui-driver/spec.md` Requirement "Native tool emission is blocked at driver configuration" (lists `EnterPlanMode`, `ExitPlanMode`, `Skill`, `ToolSearch`, `AskUserQuestion`, `ScheduleWakeup`, `TaskOutput`, `TaskStop`, `BashOutput`, `Monitor`, `Mcp`); `tasks.md` T4.3 ("assert `DISALLOWED_BUILTIN_TOOLS` matches the spec list").
- **Issue:** T4.3 verifies code-matches-spec but not spec-matches-Claude. Tool names like `Skill`, `Mcp`, `Monitor`, `BashOutput`, `ScheduleWakeup` are not documented anywhere I can find in `claude --help`. If a name is misspelled or stale, layer-1 (deny in `--settings`) silently no-ops; layers 2–4 still catch, but the constitution IV enforcement clause ("CI test asserts the disallow list... includes the documented set") loses meaning without a documented set to assert against.
- **Impact:** False sense of defense-in-depth at layer 1.
- **Fix direction:** Add a Phase 0 spike that enumerates Claude's actual native tool registry (e.g., spawn `claude` and ask it via the deterministic `tools/list` introspection T0.7 already uses, or inspect the binary's strings, or pin to Anthropic documentation). Pin the disallow list against that. README's "Maintenance" note already calls this out for upgrades — formalize the audit cadence.

### [P2] Wire protocol between shim and bridge router is undefined

- **Where:** `design.md` D3, D12, D16; `specs/mcp-stdio-shim/spec.md` Requirements "Shim forwards tool calls...", "Shim binary serves both MCP-server and hook-relay roles"; `plan.md` Step 6 (`src/mcp/ipc.ts`); `tasks.md` T1.6.
- **Issue:** The unix-domain socket carries: (a) `tools/call` forwards from shim, (b) per-frame router responses back, (c) hook-relay payload+event pushes from hook-mode shim, (d) hook-mode response shapes that the shim then writes to `claude`'s expected stdout. Nothing in design or spec defines framing, request/response correlation, error encoding, or message schema. T1.6 has to invent it; the resulting protocol is the bridge's most-internal contract and is invisible to the spec.
- **Impact:** Drift between MCP and hook modes; implementation-time decisions that should have been design-time decisions; harder code review.
- **Fix direction:** Add to `design.md` D12 (or a new D-section) a short wire-protocol definition: e.g., "newline-delimited JSON; each message has `{kind: 'mcp-call' | 'mcp-response' | 'hook-payload' | 'hook-response' | 'capture-stash', id, body}`; one connection per shim lifetime; framing is per-line." Doesn't have to be exhaustive — has to be specific enough that two engineers would implement compatible endpoints.

### [P2] Local dev loop requires `npm run build` before pi can load the extension

- **Where:** `proposal.md:46-48` ("top-level `index.ts` is NOT built; pi's loader handles it at runtime" but the impl lives in `dist/`); `plan.md` Step 2 action 4 (`prepublishOnly: npm run build`); `design.md` D14.
- **Issue:** Pi loads `index.ts` via its TypeScript-aware loader, but `index.ts` imports from `dist/`. During local development (`npm link` or git-checkout install) the bridge will fail to load until `npm run build` has run, and any edit to a file under `src/` requires a rebuild. The artifacts mention `prepublishOnly` (publish-time) but no dev-loop story.
- **Impact:** Contributors hit cryptic load failures on first checkout; iteration tax during refactor work.
- **Fix direction:** Either (a) document the `npm run build && npm run build -- --watch` dev loop in README contributing notes, or (b) make `index.ts` capable of resolving `src/` directly when `dist/` is absent (a `try { from dist } catch { from src }` dynamic import) — only if pi's loader handles `src/**/*.ts` deep, which is unverified.

### [P2] `--bare` is simultaneously forbidden and conditionally required

- **Where:** `design.md` D11 last paragraph ("`--bare` is forbidden... Test T4.3 asserts `--bare` is in the disallowed-flags set"); `design.md` D7-final Phase 0 verification ("if verification fails... D7-final escalates to ALSO setting `--bare`"); `tasks.md` T0.8, T4.3.
- **Issue:** T4.3 hard-asserts `--bare` is in the disallowed-flags set the driver builds, but T0.8's escalation path explicitly adds `--bare`. If T0.8 escalates, T4.3 will fail. The contradiction needs resolution before Phase 0 closes.
- **Fix direction:** Promote this to an open decision: T4.3 should assert `--bare` is in the disallow set **UNLESS T0.8 escalated** (and design.md records which branch was taken). Better: pin the Plan B from the previous [P1] finding and remove the contradiction.

### [P3] Per-PTY socket cleanup on bridge crash

- **Where:** `design.md` D12 ("Cleanup on PTY exit"); `risks` R7.
- **Issue:** If the bridge process crashes (not graceful), `pi-claude-bridge-*.sock` files in `$TMPDIR` orphan. R7's "shim exits on IPC close" handles process orphans but not socket-file orphans.
- **Fix direction:** Add a bridge-startup sweep that unlinks `$TMPDIR/pi-claude-bridge-*.sock` files older than N minutes. One-liner; harmless.

### [P3] Constitution III audit method underspecified

- **Where:** `tasks.md` T4.2 ("snapshots `~/.claude/` pre-test and asserts no new BRIDGE-ATTRIBUTABLE file post-test (transcript files written by `claude` itself under `~/.claude/projects/` are allowed; the assertion targets only files the bridge would have written)").
- **Issue:** The "bridge-attributable" vs "claude-attributable" distinction is asserted but not technically implemented. Filesystem audit cannot tell who opened the fd. The implicit rule is "anything in `~/.claude/projects/` is fine, anything in `~/.claude/sessions/` is forbidden" — that should be the literal check.
- **Fix direction:** Reword T4.2 to "snapshot `~/.claude/`, post-test diff allowed only inside `~/.claude/projects/`; any new path in `~/.claude/sessions/`, `~/.claude/settings*.json`, `~/.claude/skills/`, `~/.claude/plugins/` is a test failure."

## Challenged Assumptions

- **"Hook-delivered transcript path is just a cross-check."** Challenged: the constitution was written assuming hook-delivered discovery is the *only* path; demoting it requires constitutional work, not silent re-interpretation (see [P0]).
- **"`--system-prompt` is the verbatim-replace path."** Challenged: documented behavior is that it sets the session prompt; it is not documented to suppress CLAUDE.md auto-discovery or auto-memory. Without spike evidence, "verbatim" is an inference, not a fact.
- **"argv ceiling has a fallback inside argv."** Challenged: the proposed fallbacks all live in the same execve budget.
- **"PreToolUse cost outweighs value."** Accepted, with caveat: dropping PreToolUse means the shim's `tools/call` log is the only observability surface for tool emission. If a future drift surfaces (the model emits a native tool name and the driver-config layer fails to deny), the shim catches it but nothing emits a `claude`-side observable. Acceptable trade-off, documented at D11.
- **"D6: drop AskClaude."** Accepted; the proposal owns the breaking change in CHANGELOG.
- **"Per-block streaming UX is acceptable."** Accepted with R6 acknowledgement; this is a real but bounded regression.

## Stronger Alternatives

- **Constitution amendment as a sibling change.** If D18 is the right architectural call (and it probably is — deterministic discovery removes one moving part), commit to the constitutional amendment up front. Don't let `analyze.md` paper over it.
- **Prompt-overflow via tmpfile + bridged Read tool.** When the cold-start argv would exceed the threshold, the bridge writes the overflow to a tmp file outside `~/.claude/`, the positional arg becomes a short instruction referencing the file, and the bridge ensures a `read` pi-bridged tool is available with a hint to call it first. This survives ARG_MAX but adds a steering dependency on the first turn. Mention and reject explicitly in D13 if rejected; don't silently miss it.
- **Move the hook-relay socket protocol into a tiny `protocol.md` adjacent to design.md.** Single artifact, single source of truth for the IPC contract; both shim and router import from it.

## Open Questions

- **OQ-A:** Is the constitutional amendment in scope for *this* change (bumps Scale, requires another adversarial cycle on the amendment itself), or a strict prerequisite that lands first?
- **OQ-B:** If T0.11 finds no argv-bypass fallback, what fraction of historical pi sessions overflow? The risk severity depends on this number; without it, R15 is rated "Low likelihood" by guess.
- **OQ-C:** If T0.8 finds CLAUDE.md leakage even with `--system-prompt`, is the project willing to relax constitution V to "the bridge SHALL forward `ctx.systemPrompt` verbatim into `--system-prompt`; additional context that `claude` injects autonomously is out of bridge control"? That would be honest but constitutes a constitutional weakening.
- **OQ-D:** Does the shim↔router IPC need backpressure (one slow pi tool blocking the socket for other in-flight calls in the same PTY)? Probably no for v1 (one shim per PTY, calls serialize per the SDK's model), but worth a sentence.

## Minimal Revision Checklist

- [ ] Resolve [P0]: either submit a constitution III amendment sibling-change or revert D18 to hook-delivered discovery. Update `analyze.md` Check 1 with the decision.
- [ ] Resolve [P1] R15: replace the hopeful fallback candidates with either a real non-argv channel or an explicit "no fallback exists; T0.11 measures user impact" statement. Update `claude-tui-driver` spec's fallback paragraph and `design.md` R15.
- [ ] Resolve [P1] `--system-prompt` cascade: write Plan B in `design.md` D7-final naming the hook-replacement and transcript-discovery mechanisms used when `--bare` is forced.
- [ ] Add a Phase 0 spike (or amend T0.7) that enumerates Claude's real native tool surface and pins the disallow list against it.
- [ ] Add a wire-protocol section to `design.md` D12 (newline-delimited JSON message schema, message kinds, correlation ids).
- [ ] Reconcile T4.3 (`--bare` disallowed) with T0.8 escalation path. One source of truth.
- [ ] Document the dev loop (build-then-load) in README contributing notes.
- [ ] Reword T4.2's `~/.claude/` audit to use literal path-prefix rules instead of "bridge-attributable" heuristics.
- [ ] (P3) Add startup socket-file sweep.
