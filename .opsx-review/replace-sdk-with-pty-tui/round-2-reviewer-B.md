# Round 2 — Reviewer B (openai-codex/gpt-5.4)

## Verdict

needs revision — the proposal still depends on unresolved hook/transcript behavior and regresses an important abort/tool-result coherence property.

## Findings

### [P1] Live streaming depends on an unresolved `SessionStart.transcript_path` contract
- **Where:** `openspec/changes/replace-sdk-with-pty-tui/proposal.md:9-12`; `openspec/changes/replace-sdk-with-pty-tui/specs/transcript-stream/spec.md:6-14`; `openspec/changes/replace-sdk-with-pty-tui/plan.md:17-18`
- **Issue:** The artifacts disagree on when the transcript path becomes available. The proposal says the path is delivered via the `Stop` hook, while the transcript-stream spec requires `SessionStart` to provide `transcript_path` so tailing can begin during the turn. Phase 0 only spikes the `Stop` payload, not `SessionStart`, so the one contract that makes live per-block streaming possible is not actually proven before implementation.
- **Impact:** If interactive `claude` only exposes the path at `Stop`, the core streaming design is not executable: no live text streaming, no live tool-round observation, and the main-provider path collapses into after-the-fact transcript parsing.
- **Fix direction:** Make `SessionStart` payload verification a blocking Phase 0 spike with an explicit go/no-go decision. If `SessionStart` does not carry the path, redesign the streaming architecture and update proposal/spec/design/tasks to a single consistent contract.

### [P1] Cold-start replay via a single positional CLI argument has no size-safety story
- **Where:** `openspec/changes/replace-sdk-with-pty-tui/design.md:257-271`; `openspec/changes/replace-sdk-with-pty-tui/specs/claude-tui-driver/spec.md:44-51`
- **Issue:** The design sends full cold-start history through the trailing `[prompt]` argv slot. That is fine for short prompts, but there is no treatment of OS argv limits or large serialized histories after restart, `/fork`, `/compact`, or cache drops. The current bridge can accumulate long text/tool history; flattening all of it into one argv string is a new hard limit.
- **Impact:** Long conversations can fail exactly on cold-start paths, turning normal divergence/restart handling into spawn failures or silently truncated prompts.
- **Fix direction:** Add a Phase 0 spike for prompt-size limits and define a non-argv fallback for large cold starts (e.g. controlled PTY paste, temp input file, or another bounded replay path). Add an explicit test for oversized-history cold starts.

### [P1] The abort design drops late real tool results and breaks next-turn coherence
- **Where:** `openspec/changes/replace-sdk-with-pty-tui/design.md:288-297`; `openspec/domain.md:38-49`; `index.ts:1008-1016`; `index.ts:1260-1336`
- **Issue:** The current implementation deliberately keeps aborted frames alive so a late `toolResult` can still resolve and be captured for next-turn resume. The new design instead closes the transcript tail immediately on abort and treats post-abort `Stop` as irrelevant. No replacement is specified for feeding a late pi tool result back into Claude or reconciling it on the next turn.
- **Impact:** Aborting during a tool round can leave pi’s canonical history containing a real tool result that the resumed Claude session never saw, causing divergence, confused follow-up turns, or regression in the existing “real tool result captured for next-turn resume” behavior.
- **Fix direction:** Add an explicit late-tool-result state machine for the PTY path and test it. Either keep the PTY/router alive until the next pi event resolves pending tools, or define how the next cold/warm start replays the real tool result so Claude and pi converge again.

### [P1] Finalization assumes `Stop` means the transcript is fully flushed
- **Where:** `openspec/changes/replace-sdk-with-pty-tui/specs/transcript-stream/spec.md:21-28,69-74`; `openspec/changes/replace-sdk-with-pty-tui/design.md:111-121`; `openspec/changes/replace-sdk-with-pty-tui/design.md:313-315`
- **Issue:** Main-provider usage extraction and capture success/error classification both depend on terminal JSONL lines being present when `Stop` fires, but the design only says “drain remaining buffered bytes and close.” There is no settle/retry window for the common race where the hook fires before the last transcript write hits disk.
- **Impact:** Intermittent truncated final output, missing usage, or false capture failures (“model did not call capture tool”) become likely, especially because capture success is keyed off the terminal transcript state.
- **Fix direction:** Add a bounded post-`Stop` retry/poll contract to the spec and plan, and test the case where `Stop` arrives before the terminal `result` / final tool-use bytes are readable.

### [P2] The execution plan verifies the wrong Constitution III invariant
- **Where:** `openspec/changes/replace-sdk-with-pty-tui/plan.md:73-76`; `openspec/changes/replace-sdk-with-pty-tui/proposal.md:74`; `openspec/constitution.md:35-54`
- **Issue:** Plan step 4 says to inspect `~/.claude/` after a real interactive spawn “to confirm no writes occurred.” But the proposal itself states that interactive mode necessarily writes transcript files under `~/.claude/projects/`; Constitution III forbids bridge-authored writes and config mutation, not Claude’s own documented transcript output.
- **Impact:** The plan contains a built-in false failure and can send implementation work in the wrong direction.
- **Fix direction:** Change verification to assert that the bridge does not directly write or mutate `~/.claude/`, and that any reads under `~/.claude/projects/` are limited to hook-delivered transcript paths.

## Challenged Assumptions

- `SessionStart` definitely exposes `transcript_path` in interactive mode.
- A full cold-start replay fits safely in one argv prompt.
- Aborting a PTY can sever the live turn without sacrificing late tool-result coherence.
- `Stop` firing implies the transcript is already complete enough to finalize against.

## Stronger Alternatives

- Treat transcript-path availability as a Phase 0 stop-gate, not a Phase 1 implementation detail.
- Use a hybrid prompt-injection strategy: argv only for short warm turns, with a separate bounded path for large cold starts.
- Add an explicit “aborted with pending tool results” state that preserves the current repo’s next-turn-resume semantics.
- Finalize turns only after a bounded “terminal transcript observed” check rather than immediately on `Stop`.

## Open Questions

- Does current interactive `claude` actually include `transcript_path` in `SessionStart`, or only in `Stop`?
- What maximum cold-start prompt size must the bridge support before argv becomes unsafe?
- Can the PTY/shim remain alive long enough after abort to accept a late real tool result?
- What bounded retry window is acceptable for transcript flush after `Stop`?

## Minimal Revision Checklist

- Add a blocking Phase 0 spike for `SessionStart` payload shape and transcript-path availability.
- Add a prompt-size spike and define a non-argv fallback for large cold starts.
- Specify and test late-tool-result behavior after abort during a tool round.
- Add a post-`Stop` transcript-settling/retry rule to the specs and plan.
- Fix Constitution III verification language so it checks bridge behavior, not Claude’s own transcript writes.
