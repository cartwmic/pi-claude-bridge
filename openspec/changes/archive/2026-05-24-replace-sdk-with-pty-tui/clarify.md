# Clarify Findings

Three passes over the EARS acceptance criteria in `specs/**/spec.md`. Each
finding ends as a 2-option question. Answer A = keep as-is. Answer B = change
as proposed. Status: `unanswered | answered | deferred`. `deferred` items are
echoed into `analyze.md` outstanding-risks.

## Pass 1 — Ambiguity (semantic-entropy lite)

| # | AC ref | Question | Option A (keep) | Option B (change) | Status | Resolution |
|---|---|---|---|---|---|---|
| A1 | claude-tui-driver.pty-spawn-with-model-selection | The AC names `node-pty` directly. Should the spec name the implementation library, or only the behavior (any PTY abstraction)? | Keep `node-pty` named — locks the dep, fits constitution's bias toward concrete configurations. | Rephrase to "a pseudoterminal session"; library name lives in design.md only. | answered | B. Specs describe behavior, not the implementation library. node-pty is a design decision; moved to design.md. Spec text updated. |
| A2 | claude-tui-driver.prompt-injection-via-cli-positional-argument | "Inject the pi user prompt as a single user message" — does this permit multi-content (text + image blocks within one user message), or restrict to a single text block? | Keep current wording; ambiguous in practice means whatever node-pty + claude can carry. | Clarify: a single logical user message MAY contain multiple content blocks (text + image), but only one logical message is injected per `SessionStart`. | superseded | **SUPERSEDED by Round-1 finding** — see `claude-tui-driver.image-content-handling-in-v1` AC: v1 strips image blocks on the main path (text-only positional arg) and rejects on the capture path with `stopReason: "error"`. Also the prompt-injection AC was renamed to `prompt-injection-via-cli-positional-argument` (Round-2 A.P2). |
| A3 | claude-tui-driver.abort-propagates-to-the-pty | "Implementation-defined grace window" — no upper bound stated. Could be 50ms or 30s. | Keep open — bridge owner chooses; documented in design.md. | Fix a concrete upper bound in the spec (e.g. 5s, then SIGKILL). | answered | A. Concrete value belongs in design.md. Spec keeps the SHALL-terminate-before-SIGKILL invariant; design.md will pin the number. |
| A4 | claude-tui-driver.unexpected-driver-exit-surfaces-as-error | "Before the `Stop` hook fires" — what if the PTY exits AFTER Stop but during transcript drain? Is that still "unexpected"? | Keep — only pre-Stop exit is unexpected; post-Stop exit is normal teardown. | Tighten to "exits before Stop fires OR exits with non-zero status at any point". | answered | A. Post-Stop exit is normal. Non-zero exit status post-Stop is acceptable noise and logged at warn-level only. |
| A5 | mcp-stdio-shim.shim-forwards-tool-calls-to-the-in-process-router | "Implementation-defined timeout" — what does the driver see if the router never responds (pi UI never delivers `tool_result`)? | Keep — same as today's bridge (handler Promise stays pending indefinitely, abort unblocks). | Make the timeout explicit and have the shim respond with an MCP error. | answered | A. Today's contract is "handler stays parked until pi delivers a result or aborts". Preserving that contract on the shim. Constitution VII (failures surface) is satisfied by the existing abort path, not by a new timeout. |
| A6 | mcp-stdio-shim.shim-lifecycle-is-bound-to-its-pty | "When the IPC channel to the bridge closes" — does that close before or after PTY exit in normal teardown? Race possible? | Keep — sequence is irrelevant as long as the shim terminates. | Pin sequence: PTY exits first → shim's stdin closes → shim exits. | answered | A. Sequence is irrelevant; both orderings reach the same terminal state. Document in design.md, not spec. |
| A7 | transcript-stream.tail-transcript-while-turn-is-in-flight | "Implementation-defined polling/notify latency" — fs.watch on macOS is known-unreliable. Acceptable? | Keep — bridge owner picks the strategy. | Require polling-only on macOS for reliability. | deferred | Phase 0 spike: measure fs.watch reliability on macOS for the transcript file's typical write pattern. Decision pinned in design.md. |
| A8 | transcript-stream.emit-text-delta-tool-use-thinking-and-usage-events | "Thinking-content additions when present" — assumes CC writes thinking blocks to JSONL. Confirmed? | Keep — CC SDK exposed thinking via partial-message events; assume parity. | Add explicit "if CC TUI does not surface thinking in JSONL, emit no thinking events" disclaimer. | deferred | Phase 0 spike confirms CC TUI's JSONL thinking-block shape. If absent, spec is amended via follow-up change. |
| A9 | output-capture.synthesized-toolcall-content-block-on-success | "Tool-use block whose arguments validate against the capture tool's JSON schema" — where does validation happen: at the MCP shim layer (rejects bad calls inside the driver loop, model retries), or at the bridge synthesis layer (accepts what the model emitted, validates post-hoc)? | At the MCP shim — model retries via the driver's normal mechanism. | At synthesis layer — bridge validates after Stop. | answered | A. Validation happens IN THE SHIM (not "at the MCP protocol layer" as initially worded — corrected during Round-1 adversarial review). The shim validates `tools/call` arguments against the capture tool's JSON schema in its own process, returns MCP error `-32602` on failure (model self-corrects within same turn) and the deterministic success response per D16 on success. |
| A10 | output-capture.surface-absent-capture-tool-call-as-error | "The driver's own internal retries" — in the SDK era, the SDK retried internally up to N times. The PTY-driven path has no equivalent built-in retry. Vestigial? | Keep — the model self-corrects within the same turn when MCP rejects bad args; this is the "internal retry" equivalent. | Strike the phrase "after the driver's own internal retries"; it leaks SDK-era semantics. | answered | B. Phrase struck. Reworded to "after any same-turn self-correction the model performs". |

## Pass 2 — Inconsistency (pairwise antecedent overlap)

| # | AC pair | Shared antecedent | Conflict on output | Option A (keep both) | Option B (resolve) | Status | Resolution |
|---|---|---|---|---|---|---|---|
| I1 | claude-tui-driver.native-tool-emission-is-blocked-at-driver-configuration ∧ mcp-stdio-shim.shim-rejects-non-bridged-tool-names | Both fire when the model attempts a non-bridged tool. | No conflict — defense-in-depth. Concern: enforcement gaps if one is updated and the other isn't. | Keep both as defense-in-depth; flag the linkage in design.md. | Pick one canonical enforcement point. | answered | A. Defense-in-depth is constitution principle IV's explicit intent. Linkage will be documented in design.md so future edits keep them aligned. |
| I2 | claude-tui-driver.unexpected-driver-exit-surfaces-as-error ∧ transcript-stream.missing-or-unreadable-transcript-surfaces-as-error | PTY exits pre-Stop AND transcript path was never written. | Both fire; could push two `error` events. | Keep both — orthogonal paths; one will fire first depending on timing. | Pin precedence: PTY-exit error wins; transcript-error suppressed if PTY already errored. | answered | B. PTY-exit error wins. If PTY already pushed `error`, the transcript-stream MUST NOT push a second `error` for the same turn. Recorded as a design constraint. |
| I3 | output-capture.synthesized-toolcall-content-block-on-success ∧ output-capture.surface-absent-capture-tool-call-as-error | What if the transcript contains BOTH text content AND a valid capture tool-use block? | Both ACs partially apply; success AC has no "text must be absent" clause. | Treat as success; the text is ignored. | Treat as error; capture mode is "tool-call only". | answered | A. Treat as success and ignore text. Constitution V (system prompt fidelity) does not forbid model text. Document the behavior in design.md and add a test. |
| I4 | claude-tui-driver.prompt-injection-via-sessionstart-hook (warm-resume scenario) ∧ claude-tui-driver.cached-driver-session-is-a-hint-only | Cached id was valid at turn-start; cwd changes mid-turn (rare). | Warm-resume scenario assumes the cache is valid for the full turn. | Keep — mid-turn cwd change isn't a supported scenario. | Add: cwd change mid-turn aborts the active turn. | deferred | Pi does not expose mid-turn cwd changes today, but it could. Mark as a known undefined behavior in analyze outstanding-risks. |
| I5 | mcp-stdio-shim.shim-is-a-separate-process ∧ mcp-stdio-shim.shim-lifecycle-is-bound-to-its-pty | Bridge crashes while PTY still running. | Shim's parent (bridge) gone; PTY orphaned with live shim. | Keep — bridge crash is out-of-scope for these ACs. | Add: shim exits when bridge IPC closes regardless of PTY state. | answered | B. The "IPC channel closes → shim exits" branch already covers this. Spec is already correct; clarify wording in design.md. |

## Pass 3 — Completeness (event/state combination enumeration)

**Events declared:** fresh turn start, SessionStart hook, Stop hook, PreToolUse hook, pi abort, PTY exit, model tool-call via shim, new JSONL line, malformed JSONL line, malformed MCP message, cwd change, pi history-hash divergence, capture call invoked.

**States:** idle, main-provider in-flight, capture in-flight, mid-tool-round (waiting on pi tool_result), aborted, driver-exited-unexpectedly.

Capping at 10 highest-impact uncovered combinations:

| # | Combination | Question | Option A (intentional silence) | Option B (add new AC) | Status | Resolution |
|---|---|---|---|---|---|---|
| C1 | (capture call invoked) × (main-provider mid-tool-round) | Can a capture call start while the main provider is awaiting a pi tool_result? | Yes — isolation requirement covers it; no extra AC needed. | Add explicit AC: capture call invoked mid-tool-round MUST NOT affect the parked main-provider tool handler. | answered | A. Isolation AC (output-capture.capture-path-isolation) covers it. Add a test in tasks. |
| C2 | (pi abort) × (capture in-flight) | Does pi's `AbortSignal` cancel a capture call the same way it cancels a main-provider turn? | Yes — same abort propagation AC applies. | Add explicit AC on capture path mirroring claude-tui-driver.abort-propagates-to-the-pty. | answered | B. Add ADDED requirement to output-capture spec for "capture path honors AbortSignal". Update spec in next pass before clarify is final. |
| C3 | (driver emits multiple tool-use blocks for the capture tool) | First wins? Or error? | First wins; remaining ignored. | Error: capture mode forbids multiple capture-tool calls. | answered | A. First wins. Remaining tool-use blocks logged at warn-level. Document in design.md. |
| C4 | (transcript file deleted/truncated while tailing) | What does the tailer do? | Surface as error per transcript-stream.missing-or-unreadable-transcript-surfaces-as-error. | Add specific AC for mid-tail file disappearance. | answered | A. Existing missing-or-unreadable AC covers the case; tailer treats EOF-then-file-gone as an error. |
| C5 | (shim's IPC channel times out / disconnects) | Bridge restart but shim still running. | Shim exits (lifecycle AC). | Bridge restart aborts active turn explicitly. | answered | A. Lifecycle AC covers shim shutdown; bridge restart already drops sessions via `clearSession` per constitution III. |
| C6 | (driver session id changes mid-flight) | CC has been observed to emit a new session_id mid-turn (cache invalidation). | Bridge accepts the new id silently and updates cache. | Bridge logs the change as an unexpected event but continues. | deferred | Phase 0 spike: confirm whether CC TUI mid-turn session_id changes still occur. Resolution will be a design.md addendum. |
| C7 | (model emits zero text AND zero tool-use blocks at Stop) | What does the bridge return to pi? | Surface as error: "model produced no content". | Return empty AssistantMessage with `stopReason: "stop"`. | answered | A. Surface as error per constitution VII. Add to output-capture and main-provider error-handling tasks. |
| C8 | (model calls a non-capture MCP tool from the capture path) | Should not happen (shim advertises only the capture tool), but defense-in-depth: what if? | Shim rejects per mcp-stdio-shim.shim-rejects-non-bridged-tool-names. | Bridge also rejects at synthesis layer. | answered | A. Shim rejection is sufficient. |
| C9 | (concurrent capture calls from independent consumers) | Two capture calls invoked simultaneously by different skills. | Both proceed independently — each spawns its own PTY + shim. | Serialize: queue capture calls. | answered | A. Independent PTYs is the natural model and matches the isolation AC. Document concurrency in design.md. |
| C10 | (hook payload contract version mismatch) | CC TUI ships a new SessionStart payload missing transcript_path. | Surface as error per constitution VII (failures surface). | Bridge attempts a fallback derivation (search ~/.claude/sessions/ for recent files). | answered | A. Surface as error. Constitution III forbids reading ~/.claude/sessions for anything other than the declared transcript_path. |

## Outstanding (status != answered)

- A7: macOS fs.watch reliability for transcript tailing — **deferred** (Phase 0 spike)
- A8: confirm CC TUI emits thinking blocks in JSONL — **deferred** (Phase 0 spike)
- I4: mid-turn cwd change behavior — **deferred** (undefined behavior, document in analyze)
- C6: CC TUI mid-turn session_id changes — **deferred** (Phase 0 spike)

## Pending spec update from clarify

C2 promoted a new ADDED requirement to `output-capture` spec (applied before design):

> "Capture path honors `AbortSignal`: WHEN pi signals abort on the current `AbortSignal` while a capture call is in flight, THE capture path SHALL deliver an interrupt to its PTY (per claude-tui-driver.abort-propagates-to-the-pty) and SHALL resolve `complete()` with `stopReason === "aborted"`."

Applied. Also (added in Round-1 adversarial review) `claude-tui-driver.abort-lifecycle-is-decoupled-from-stop-hook-firing` covers the case where the PTY exits via SIGINT without `Stop` firing.

## Summary

- Pass 1 findings: 10; unanswered: 0; deferred: 3 (A7, A8, partial overlap with C6)
- Pass 2 findings: 5; unanswered: 0; deferred: 1 (I4)
- Pass 3 findings: 10; unanswered: 0; deferred: 1 (C6)
- **Round-1 adversarial review resolutions** (see `.opsx-review/replace-sdk-with-pty-tui/round-1-convergent.md`): A1 (node-pty named in spec) resolved by stripping mention; A9 wording corrected (validation happens IN the shim, not "at the MCP protocol layer" abstractly); D7 deferred companion CLOSED via `--system-prompt` verification.
- **Gate status:** READY for design (no `unanswered`; all `deferred` documented for analyze outstanding-risks)
