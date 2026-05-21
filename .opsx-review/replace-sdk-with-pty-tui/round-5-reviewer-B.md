# Round 5 — Reviewer B (openai-codex/gpt-5.4)

## Verdict

needs revision — the change still has P1-level contract conflicts around system-prompt fidelity, transcript authority/discovery, and warm-resume replay.

## Findings

### [P1] Main-provider prompt contract drops `ctx.systemPrompt`
Constitution V says the main-provider path may append pi-derived material **to** `ctx.systemPrompt` (`openspec/constitution.md:94-96`). But D7 says the capture path passes `ctx.systemPrompt` verbatim while the main-provider path passes only pi-combined append text plus a minimal header (`openspec/changes/replace-sdk-with-pty-tui/design.md`, D7-final). Grounding shows the current implementation already has this bug (`index.ts:1200-1206` extracts append blocks, then sets `staticSystemPrompt = systemPromptAppend ?? "You are a helpful coding assistant."`). If carried forward, main-path callers lose their explicit system instructions entirely.

Impact: this violates the constitution and changes behavior for any upstream component relying on `ctx.systemPrompt` on normal turns.

Fix direction: make the main-provider contract explicit as `ctx.systemPrompt` plus documented append blocks in a defined order, and add a regression AC/test that the base prompt bytes are preserved on the main path.

### [P1] Transcript read authority still contradicts the deterministic-path design
The chosen architecture says transcript discovery is deterministic from bridge-generated `--session-id`, and the bridge does **not** depend on hook-delivered `transcript_path` for discovery (`claude-tui-driver/spec.md:30`; `transcript-stream/spec.md` intro). But the filesystem requirement still says the driver may read only the transcript path delivered by `SessionStart`/`Stop` (`claude-tui-driver/spec.md:94-100`), and the transcript error AC is still keyed to `Stop`'s reported `transcript_path` (`transcript-stream/spec.md:79-85`). That conflicts with Constitution III’s deterministic-path exemption and with the design’s stated mechanism.

Impact: an implementer cannot satisfy both contracts in the interactive-mode case this proposal is explicitly targeting, so tests/specs can fail even when the intended design is implemented correctly.

Fix direction: rewrite these ACs to allow exactly the two constitution-approved read sources: hook-delivered path or bridge-computed path from a bridge-generated session UUID. Error handling should key off the computed/selected path actually used, not the `Stop` payload field.

### [P1] Capture spec still makes the transcript authoritative after D21 moved authority to IPC stash
D21 explicitly says capture success is authoritative from the IPC-stashed, schema-validated arguments and that the bridge should trust the stash if transcript and stash disagree (`openspec/changes/replace-sdk-with-pty-tui/design.md:286-291`). But the output-capture success AC still requires a transcript tool-use block, and the failure AC still errors whenever `Stop` arrives without a valid transcript tool-use block (`openspec/changes/replace-sdk-with-pty-tui/specs/output-capture/spec.md:133-154`).

Impact: the very race/mismatch case D21 was added to handle cannot satisfy spec and design simultaneously; a valid capture can still be rejected if the transcript is late, truncated, or divergent.

Fix direction: update `output-capture/spec.md` so success is driven by the validated IPC stash, with the transcript used only for cross-checking and usage extraction; add an explicit divergence scenario (stash present, transcript missing/mismatched => succeed + warn).

### [P1] Warm-resume tailing has an unclosed event-loss race
D22 says resumed turns tail the existing transcript “from the END-OF-FILE position (via `fs.stat` size at spawn time)” (`openspec/changes/replace-sdk-with-pty-tui/design.md:296-299`). But the proposal never pins the ordering needed to avoid losing the first lines of the resumed turn, and the plan/tasks contain no acceptance test for “resume + immediate assistant/tool output” (only a spike for session-id rotation at `plan.md:20`). If Claude appends new-turn lines before the tailer captures its baseline offset, those lines can be skipped.

Impact: this can silently corrupt the hot resume path by losing initial text/tool-use events, which then breaks streaming or tool-round continuity only on resumed conversations.

Fix direction: specify that the baseline file size is captured before spawn and that the resumed tailer starts from that offset; add an integration test where a resumed turn emits output immediately and no events are lost.

### [P2] Phase-0 validation still relies on model self-report in places the design says must be deterministic
`plan.md` T0.7 verifies tool isolation by asking the model to list its tools, and T0.8 verifies system-prompt replacement by asking the model to repeat its system prompt verbatim (`openspec/changes/replace-sdk-with-pty-tui/plan.md:22-23`). But the same change set already recognizes model self-report as non-deterministic for tool-surface validation (`design.md:R16`), and `tasks.md:48`/`tasks.md:172` correctly call for deterministic MCP `tools/list` introspection.

Impact: the spike can produce false confidence and bless architecture choices on heuristic evidence.

Fix direction: align `plan.md` with the deterministic checks already described elsewhere; remove the model-self-report probes.

## Challenged Assumptions
- The main path can preserve existing behavior while omitting the base `ctx.systemPrompt`.
- Hook-delivered `transcript_path` can remain the normative read source after switching to deterministic discovery.
- Transcript and IPC stash will always agree in capture mode.
- Seeking to EOF on resume is race-free.
- Model narration is good enough to validate tool visibility or effective system-prompt composition.

## Stronger Alternatives
- Define main-path prompt composition as `ctx.systemPrompt` + appended pi material, with a byte-preservation test for the base prompt.
- Treat IPC stash as the capture commit record and the transcript as observability/usage only.
- On resume, record the transcript size before spawn and tail from that exact offset; if that cannot be made safe, cold-start instead of risking silent loss.
- Use deterministic MCP introspection / mechanical probes for Phase-0 validation, not model self-report.

## Open Questions
- What mechanical signal will the team use to prove that `--system-prompt` suppresses `CLAUDE.md`/auto-memory in interactive mode without relying on model narration?
- Does resumed interactive `claude` append any turn-start lines before the bridge can attach its tailer, and if so what is the safe attach sequence?

## Minimal Revision Checklist
- [ ] Amend D7 and the corresponding spec/tests so main-provider turns preserve `ctx.systemPrompt`.
- [ ] Reconcile all transcript-read ACs with Constitution III’s deterministic-path exemption.
- [ ] Rewrite capture success/failure ACs around IPC-stashed validated args, with a transcript-divergence scenario.
- [ ] Specify the warm-resume tail baseline ordering and add a no-loss resume integration test.
- [ ] Replace Phase-0 model-self-report checks in `plan.md` with deterministic probes already described in `tasks.md`/design.
