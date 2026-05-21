# Round 1 — Reviewer B (openai-codex/gpt-5.4)

## Verdict

needs revision — several core behaviors are still assumed rather than specified, so the plan can dead-end or ship a broken package even if implementation work proceeds cleanly.

## Findings

### [P1] PTY bring-up assumes `node-pty` is a complete terminal, but the plan never proves that
- **Where:** `openspec/changes/replace-sdk-with-pty-tui/design.md:42-49`, `openspec/changes/replace-sdk-with-pty-tui/design.md:57-65`, `openspec/changes/replace-sdk-with-pty-tui/design.md:219-226`, `openspec/changes/replace-sdk-with-pty-tui/tasks.md:13-49`
- **Issue:** The design commits to a raw `node-pty` driver, but neither the design nor Phase 0 checks the terminal-emulation side of interactive Claude boot. The reference project this change cites (`smithersai/claude-p`) treats DEC/XTVERSION/cursor/window-size replies as load-bearing for Ink startup; this proposal assumes a PTY alone is enough.
- **Impact:** If Claude’s TUI expects terminal-query responses that the bridge never sends, the driver can hang before `SessionStart`, invalidating the whole architecture after Phase 1 work has already landed.
- **Fix direction:** Add a Phase 0 spike and explicit design decision for PTY bootstrap behavior: either prove `node-pty` alone works with current Claude, or specify the required terminal-query responder / alternate PTY stack before approving Phase 1.

### [P1] Abort handling is specified around `Stop`, but Claude’s public hook contract does not guarantee `Stop` on user interrupt
- **Where:** `openspec/changes/replace-sdk-with-pty-tui/design.md:163-168`, `openspec/changes/replace-sdk-with-pty-tui/design.md:178-186`, `openspec/changes/replace-sdk-with-pty-tui/specs/transcript-stream/spec.md:14-24`, `openspec/changes/replace-sdk-with-pty-tui/tasks.md:71-80`, `openspec/changes/replace-sdk-with-pty-tui/tasks.md:117-121`
- **Issue:** The turn-finalization story is “tail until `Stop`, then drain/close,” but the Claude hooks reference says `Stop` does not fire on user interrupt. The spec never defines how the transcript tailer, PTY-exit classification, and stream finalization behave on an abort that exits without `Stop`.
- **Impact:** Normal aborts can be misclassified as unexpected driver exits, leak tailers/file handles, or surface duplicate/conflicting terminal events instead of the required clean `aborted` path.
- **Fix direction:** Add an explicit abort lifecycle contract: what signal ends tailing when `Stop` is absent, how pre-`Stop` PTY exit is treated after an intentional abort, and what tests prove “abort without Stop” is clean.

### [P1] Capture mode has no defined MCP completion semantics, so the forced-tool-call path can hang
- **Where:** `openspec/changes/replace-sdk-with-pty-tui/design.md:96-105`, `openspec/changes/replace-sdk-with-pty-tui/specs/output-capture/spec.md:30-44`, `openspec/changes/replace-sdk-with-pty-tui/specs/output-capture/spec.md:95-97`, `openspec/changes/replace-sdk-with-pty-tui/specs/output-capture/spec.md:124-145`, `openspec/changes/replace-sdk-with-pty-tui/specs/mcp-stdio-shim/spec.md:14-29`, `openspec/domain.md:38-39`, `openspec/changes/replace-sdk-with-pty-tui/tasks.md:92-95`, `openspec/changes/replace-sdk-with-pty-tui/tasks.md:125-135`
- **Issue:** The shim spec says every `tools/call` is forwarded to the router and answered from there. The router design preserves the existing “park until pi delivers a tool result” contract. But capture mode advertises a synthetic capture tool in a path with no pi tool execution, and the proposal never says what response that tool returns, who synthesizes it, or how the turn ends after the first valid call.
- **Impact:** As written, the capture turn either blocks forever waiting for a tool result that never comes, or requires an undocumented special-case that violates the stated shim/router contract and likely the domain invariant about not synthesizing real tool results.
- **Fix direction:** Specify the capture-tool call lifecycle explicitly: whether it bypasses the normal router, what deterministic MCP response is returned, whether the turn is terminated immediately after first valid call, and what tests prove no hang / no extra model round / no state bleed.

### [P1] The packaging plan would publish a broken npm artifact
- **Where:** `package.json:22-30`, `package.json:49-54`, `openspec/changes/replace-sdk-with-pty-tui/design.md:135-150`, `openspec/changes/replace-sdk-with-pty-tui/design.md:232-235`, `openspec/changes/replace-sdk-with-pty-tui/tasks.md:86-91`, `openspec/changes/replace-sdk-with-pty-tui/plan.md:100-109`
- **Issue:** The repo currently whitelists only top-level files in `package.json.files`, but the proposal moves runtime code into `src/**`. Those files will not be published unless the whitelist changes. Separately, Task 1.7 adds a bin entry for `src/mcp/shim.ts`, but the package has no build step and `tsx` is only a devDependency, so a plain Claude-spawned executable cannot run that TypeScript entrypoint.
- **Impact:** The refactor may appear to work locally in-repo, then fail for every installed consumer because required modules or the shim binary are missing or non-executable.
- **Fix direction:** Define a publish/runtime strategy up front: either ship compiled JS in `dist/` (including the shim) or make `tsx`/launcher runtime-supported, update `files`, and expand `npm pack` verification to assert that every runtime import and the shim executable are present and runnable from the tarball.

### [P2] The Phase 0 system-prompt spike has no hard stop even though the documented fallback violates constitution V
- **Where:** `openspec/constitution.md:61-73`, `openspec/changes/replace-sdk-with-pty-tui/design.md:121-129`, `openspec/changes/replace-sdk-with-pty-tui/design.md:266-269`, `openspec/changes/replace-sdk-with-pty-tui/tasks.md:13-49`
- **Issue:** D7 explicitly allows fallback to “inject as first user message” if no interactive flag fully replaces Claude’s default system prompt. But constitution V requires the capture path to forward `ctx.systemPrompt` verbatim. The plan records a spike, yet never states that Phase 1 must stop if verbatim replacement is impossible.
- **Impact:** The team can burn implementation time only to discover late that the chosen architecture cannot satisfy a ratified constitutional requirement.
- **Fix direction:** Turn D7 into a stop-gate with allowed outcomes: either prove a true system-prompt replacement path exists, or amend the spec/constitution before Phase 1 begins.

## Challenged Assumptions

- A raw `node-pty` session is enough to behave like a human terminal — challenged because the closest public reference (`claude-p`) had to add explicit terminal-query responses for interactive Claude boot.
- `Stop` is the universal end-of-turn signal — challenged because Claude’s public hook docs exclude user interrupts from `Stop`.
- “Forced MCP tool-call” is automatically equivalent to SDK `outputFormat` — challenged because the capture tool still needs a concrete request/response lifecycle.
- Adding a `bin` entry is enough to ship the shim — challenged because this package currently publishes a narrow file whitelist and no runnable JS build output.
- Phase 0 can “discover” prompt fidelity without affecting plan viability — challenged because the documented fallback already conflicts with constitution V.

## Stronger Alternatives

- For PTY bring-up: add a minimal executable spike that proves Claude can boot, accept a prompt, and exit under the intended PTY stack before committing to `node-pty` as the architecture.
- For capture mode: use a dedicated capture-only MCP server/handler with explicit ack-and-stop semantics instead of trying to reuse the parked main-provider router contract unchanged.
- For packaging: introduce a real publish target (`dist/` JS + shim entry) rather than depending on repo-local TypeScript execution semantics.
- For aborts: make PTY-exit-after-intentional-abort its own first-class completion path instead of treating `Stop` as mandatory.

## Open Questions

- Does current Claude boot cleanly under `node-pty` without a terminal-query responder?
- On the capture path, what exact MCP response is returned after the first valid capture-tool call?
- How will the package expose a runnable shim binary to end users without a build/output step today?
- If `--system-prompt` is not a true replacement in interactive mode, is this change blocked or is constitution V being amended?

## Minimal Revision Checklist

- [ ] Add a Phase 0 PTY-bootstrap spike (or equivalent design proof) covering terminal-query handling before Phase 1 implementation.
- [ ] Specify and test the abort-without-`Stop` lifecycle for transcript tailing and PTY-exit classification.
- [ ] Define the capture-tool MCP response/termination contract and update shim/router tasks accordingly.
- [ ] Add a concrete publish/runtime strategy for `src/**` modules and the shim executable, with tarball-level verification.
- [ ] Make D7 a hard precondition for Phase 1, not an informational spike with a constitution-breaking fallback.
