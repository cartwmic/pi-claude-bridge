# Round 3 — Reviewer B (openai-codex/gpt-5.4)

## Verdict

needs revision — the artifact set still has a few high-impact contract mismatches that can break publishing or force a constitution-violating fallback.

## Findings

### [P1] Publish/install path does not migrate the actual pi extension entrypoint
- **Where:** `package.json:56-58`, `openspec/changes/replace-sdk-with-pty-tui/design.md:169-183`, `openspec/changes/replace-sdk-with-pty-tui/design.md:281-283`, `openspec/changes/replace-sdk-with-pty-tui/tasks.md:96-103`, `openspec/changes/replace-sdk-with-pty-tui/plan.md:45-46`
- **Issue:** The package is currently discovered by pi via `pi.extensions = ["./index.ts"]`, but the change moves the implementation to `src/index.ts` and only updates `dist/**`, `main`/`exports`, and the shim `bin`. No artifact updates the `pi.extensions` path or states that a stable top-level wrapper will remain.
- **Impact:** The tarball can publish successfully while pi no longer loads the extension/provider at all.
- **Fix direction:** Make the extension discovery path explicit in D14/T1.2a: either keep a stable top-level wrapper intentionally, or switch `pi.extensions` to the built artifact (for example `./dist/index.js`) and add a packaging verification that proves pi discovers the installed tarball through that path.

### [P1] The fallback for missing `SessionStart.transcript_path` violates Constitution III
- **Where:** `openspec/constitution.md:34-44`, `openspec/changes/replace-sdk-with-pty-tui/design.md:432-432`, `openspec/changes/replace-sdk-with-pty-tui/tasks.md:68-73`, `openspec/changes/replace-sdk-with-pty-tui/plan.md:26-27`
- **Issue:** If `SessionStart` lacks `transcript_path`, the proposed fallback is to snapshot/list `~/.claude/projects/<encoded-cwd>/` and infer the new transcript by mtime. Constitution III only permits reading the transcript file whose path came from a hook payload, and explicitly forbids broader filesystem coupling to `~/.claude/` state.
- **Impact:** A known blocking spike currently resolves to a constitution-breaking fallback instead of a valid stop-gate, so the plan has no compliant answer if the spike fails.
- **Fix direction:** Turn T0.12 into an explicit stop condition: if `SessionStart` does not carry `transcript_path`, halt this change or amend the governing contract in a dedicated follow-up change. Do not pre-approve directory scanning as an in-scope fallback here.

### [P1] Capture-path system-prompt contract is contradictory across artifacts
- **Where:** `openspec/constitution.md:71-83`, `openspec/changes/replace-sdk-with-pty-tui/proposal.md:11-12`, `openspec/changes/replace-sdk-with-pty-tui/design.md:152-159`
- **Issue:** The proposal says capture mode adds a capture-only system-prompt addendum telling the model to emit exactly one tool-use block and no text, but the constitution and design require the capture path to forward `ctx.systemPrompt` verbatim with no additions.
- **Impact:** Implementers can satisfy either the proposal or the constitution/design, but not both. That ambiguity sits on the public structured-output contract.
- **Fix direction:** Align all artifacts on one rule. If Constitution V is non-negotiable, remove the addendum language from the proposal and describe capture steering only through non-prompt mechanisms.

### [P2] Hook-surface edits were not propagated after `PreToolUse` was dropped
- **Where:** `openspec/changes/replace-sdk-with-pty-tui/design.md:195-203`, `openspec/changes/replace-sdk-with-pty-tui/design.md:225-233`, `openspec/changes/replace-sdk-with-pty-tui/specs/claude-tui-driver/spec.md:11-22`, `openspec/changes/replace-sdk-with-pty-tui/specs/claude-tui-driver/spec.md:124-138`, `openspec/changes/replace-sdk-with-pty-tui/proposal.md:12-13`, `openspec/changes/replace-sdk-with-pty-tui/tasks.md:124-131`, `openspec/changes/replace-sdk-with-pty-tui/plan.md:113-118`
- **Issue:** D9/D11 say `PreToolUse` was removed for latency reasons, but the driver spec still requires it, the proposal still lists it, and the tasks/plan still implement and test it.
- **Impact:** The hook contract is no longer single-source-of-truth; the team may reintroduce the per-tool subprocess overhead the design just removed, or waste time building/tests for a deleted hook.
- **Fix direction:** Reconcile every artifact around one hook set. If `PreToolUse` is truly gone, delete its AC/scenarios/tasks/tests and update D12 examples; if it stays, undo the D9/D11 drop and carry the latency trade-off explicitly.

## Challenged Assumptions

- `main`/`exports` updates are sufficient for pi package discovery.
- A transcript-discovery fallback can read `~/.claude/projects/` without violating the constitution.
- Capture behavior can add prompt text while still claiming verbatim system-prompt fidelity.
- The hook-surface change was fully propagated after the Round-2 `PreToolUse` removal.

## Stronger Alternatives

- Keep a deliberate top-level extension shim, or move `pi.extensions` to `dist/index.js` and verify installation through pi itself.
- Treat T0.12 as a hard architectural gate, not a fallback-to-directory-scan branch.
- Preserve capture-path fidelity strictly and rely on sole-tool advertisement + deterministic shim responses instead of prompt mutation.
- Define the hook set once and derive spec/tasks/plan language from that canonical list.

## Open Questions

- If `SessionStart` omits `transcript_path`, is the intended outcome to block the change, or is a constitution amendment expected?
- Should the published extension continue exposing a top-level entry file, or should pi load `dist/index.js` directly?
- Is `SessionEnd` actually required in the final hook set? If yes, why is it absent from the spec/task surface while `PreToolUse` remains?
- When proposal/design/spec disagree, which artifact is intended to be normative for implementers?

## Minimal Revision Checklist

- Add an explicit `pi.extensions` migration plan and packaging verification.
- Remove the `~/.claude/projects/` directory-scan fallback, or move it behind a separate governing-change decision.
- Align proposal/design/spec on capture-path prompt fidelity.
- Reconcile the final hook set across proposal, spec, tasks, and plan.
- While touching the plan, also fix stale spike instructions such as `~/.claude/sessions/<id>/transcript.jsonl` and the model-self-report variant of T0.7.
