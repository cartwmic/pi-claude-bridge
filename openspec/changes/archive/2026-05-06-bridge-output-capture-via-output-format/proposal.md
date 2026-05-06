## Why

Pi-ai callers can pass `ctx.tools = [someTool]` to `complete()` for **structured-output capture** — they don't intend to execute the tool, they just want the model's `tool_use` block as a parseable schema response. Direct providers (anthropic, openai, google, mistral, openrouter) handle this naturally: tool defs are forwarded to the API, the model emits `tool_use`, the provider returns it as a `toolCall` content block, `complete()` resolves.

The claude-bridge provider does not. It assumes every `ctx.tools` entry is executable and registers each as an MCP tool whose handler awaits pi-side execution. For a non-pi-registered tool, that handler awaits indefinitely and the bridge frame is left alive on the stack until the next call's supersede path drains it. Caller-visible behavior: `complete()` does return (validated empirically) but the SDK keeps generating tokens after the result is delivered, the cached SDK session pollutes the next call, and downstream callers (e.g. `pi-session-search`) ship a `model.provider !== "claude-bridge"` workaround instead.

The Claude Agent SDK already exposes a first-class structured-output mechanism (`outputFormat: { type: "json_schema", schema }`) with built-in validation and retry. Routing capture-tools through that API removes the mismatch and deletes the workaround.

## What Changes

- Bridge classifies each `ctx.tools` entry **at the start of a fresh user turn only** (not when delivering tool results into an active frame): tools whose name resolves via `pi.getActiveTools()` (the currently-active set, which determines what pi will actually execute) stay on the existing MCP-handler path; the remainder are treated as **output-capture tools** and translated into a single SDK `outputFormat` schema. Using `getActiveTools()` rather than `getAllTools()` ensures registered-but-inactive tool names are correctly classified as not-pi-executable (they would otherwise reproduce the original indefinite-await bug). Classification SHALL NOT run on tool-result delivery calls (Case 1/2 in the existing dispatch); those continue to bypass the capture path entirely.
- Bridge supports **at most one** capture tool per call, **mutually exclusive** with executable tools. A call's `ctx.tools` must be either:
  - all executable (zero capture tools) — the existing agent-loop path, unchanged;
  - **or** exactly one capture tool and zero executable tools — the new output-capture path.
  Any other shape (multiple capture tools; or one capture tool alongside any executable tool) is rejected with an error event on the pi-ai stream. Documented limitation.
- Capture-mode calls run on an **isolated query path** (`runCaptureQuery`) that does not touch the bridge's shared state — not the active-frame stack, not `cachedSessionId`/`cachedSessionCwd`, not `lastSentMessageHashes`. The existing user-session machinery is byte-for-byte unaffected by capture calls (no superseding of an active user frame, no warm-resume cross-pollution, no history-divergence cold-restart on the next user turn).
- The capture path:
  - Builds a one-shot SDK `query()` with `outputFormat: { type: "json_schema", schema: <deep plain-object clone of captureTool.parameters> }` and no `mcpServers`.
  - Replays prior conversation context as text via `buildColdStartPrompt(context.messages)`. **Documented fidelity limit:** this is a text-only serialization. Image content blocks in prior messages are dropped; assistant tool-call arguments and tool-result content are truncated (200 / 500 chars respectively per the existing helper). Capture-mode multi-message support is text-only and lossy on large prior turns; callers needing image fidelity or full tool-call history should pass `ctx.messages` containing only the immediate prompt and embed relevant context as text.
  - Awaits the SDK `result` message, synthesizes a single `toolCall` content block from `result.structured_output`, builds an AssistantMessage with `stopReason = "toolUse"`, pushes `done(toolUse)` once, ends the pi-ai stream.
  - On any terminal `result` lacking `structured_output` (regardless of `subtype`), pushes an `error` event with the SDK subtype embedded in `errorMessage`. This explicitly includes `error_max_structured_output_retries` and any future failure subtypes.
- Schema preparation uses a **deep** JSON-only transform (`JSON.parse(JSON.stringify(captureTool.parameters))`), not a shallow walker. This preserves all JSON-serializable schema keywords (`minLength`/`maxLength`/`minItems`/`maxItems`/`pattern`/etc.) at every depth and naturally drops symbol-keyed TypeBox metadata.
- New integration test `tests/int-output-capture.mjs`: covers the success path, the rejection of mixed/multi-capture shapes, and the literal "capture call followed by a normal `ctx.tools = []` user turn" sequence (asserting the next user turn warm-resumes its own session and is not cold-restarted by capture-induced state mutation).
- New pi-TUI scenario `s25-capture-during-turn` covering the capture-during-user-turn concurrency case (capture call fires while a user turn is mid-tool-execution; both complete cleanly and the next user turn warm-resumes).
- Pi-TUI scenario suite reliability patch: `scripts/scenario-overrides.conf` declares per-scenario timeout/model overrides; coherence regexes for s5 and s7 hardened against false-positive/false-negative traps; s20 prompt rewritten with a neutral sentinel. Surfaces the actual model dependency of each scenario rather than burying it in env-var tuning. Per design Decision 14.
- README adds a short section on output-capture support and the call-shape limitation. CHANGELOG entry under a new minor version.

Parity scope:
- Capture-mode parity with direct providers covers the `toolCall` content-block shape, `stopReason`, `arguments`, `usage` / `cost` propagation, and `ctx.systemPrompt` / `ctx.messages` forwarding.
- Capture-mode parity does NOT cover the tool `description` channel: `outputFormat` is schema-only, so `tool.description` is dropped (the SDK's internal synthetic `StructuredOutput` is what the model actually sees, and it has no caller-controlled description). Documented limitation. Callers whose capture instructions live only in `tool.description` must move them into the user message or `ctx.systemPrompt`.

Out of scope (separate changes):
- The **agent-loop path's** `ctx.systemPrompt` replacement (`"You are a helpful coding assistant."`) is independent and unchanged by this change. Only the capture path forwards `ctx.systemPrompt`.
- Upstreaming a `Context.responseFormat` field to pi-ai so callers can opt in explicitly. Tracked separately.
- Mixed registered+capture calls. The simultaneous-`mcpServers`+`outputFormat` SDK behavior is unverified, the per-turn discrimination of `StructuredOutput` synthetic vs real MCP tool_use is non-trivial, and no current consumer needs it. Punted.

## Capabilities

### New Capabilities
- `output-capture`: Bridge translates a single unregistered `ctx.tools` entry — when it is the *only* tool in the call — into the SDK's `outputFormat` JSON-schema mode and surfaces the validated structured output as a synthesized `toolCall` content block in the AssistantMessage, matching the shape direct pi-ai providers return. Capture calls run on an isolated query path that does not interact with the bridge's user-session state.

### Modified Capabilities
<!-- None. The bridge has no existing OpenSpec spec to amend; this is a first-time spec for a new capability. -->

## Impact

- **Code**: `index.ts` — new `runCaptureQuery(model, captureTool, context, options, stream)` function (~80 lines, self-contained). Extension to `resolveMcpTools` (or a new sibling `classifyToolsForCapture`) returning the partition + the capture tool. New `Case 0` short-circuit in `streamClaudeAgentSdk` that detects capture-shape calls before any user-frame state is touched and routes to `runCaptureQuery`. **No edits** to `processStreamEvent`, `consumeQuery`, the active `stack`, or any `cachedSessionId`/`cachedSessionCwd`/`lastSentMessageHashes` sites; the existing agent-loop path is byte-for-byte unchanged. Net: ~120 lines added, ~5 lines edited.
- **Tests**: new `tests/int-output-capture.mjs`, 5 new unit-test files (`tests/unit-output-capture-{shape,cleaner,error-paths,prompt-wiring,stream-events}.mjs`), and 4 fixture files. New scenario `scripts/run-scenario-s25-capture-during-turn.sh`. Existing tests unaffected.
- **Test-suite infrastructure**: `scripts/scenario-overrides.conf` (new) + `scripts/run-all-scenarios.sh` (+~30 lines) implement per-scenario timeout/model overrides. Coherence regexes in `scripts/run-scenario-s5.sh` and `scripts/run-scenario-s7.sh` rewritten for specificity (validated against ≥12 response shapes each). Prompt in `scripts/run-scenario-s20.sh` rewritten to remove model-confusing language. Per design Decision 14.
- **Dependencies**: none added. Uses existing `@anthropic-ai/claude-agent-sdk` `outputFormat` option (verified working empirically against `claude-haiku-4-5`).
- **Downstream**: `pi-session-search/src/digest/builder.ts` `provider !== "claude-bridge"` workaround becomes deletable once the bridge ships this change. Coordination note added to release announcement; no code change in pi-session-search as part of this change.
- **Behavioral risk**: behavior-for-behavior unchanged on the agent-flow path. The capture path is a new entry-point reached only when `ctx.tools` matches the strict capture shape, AND `lastMsg.role !== "toolResult"`; any other shape either takes the existing path (all-executable) or is rejected with an explicit error (mixed / multi-capture). The agent-loop's `query()` call site is changed to go through a test-only injectable factory (Decision 11), but its production behavior is identical.
- **Suite reliability**: full pi-TUI scenario suite went from 27/28 PASS (1 timing/regex flake on s5/s7/s13/s20, 1 timeout on s22-investigate) to **28/28 PASS** with zero flakes across 3 consecutive verification runs of the previously-flaky set.

Documented v1 limitations (collected):
- One capture tool per call; mutually exclusive with executable tools.
- Capture tool's root schema must be `type: "object"`.
- Capture tool's `description` is dropped (`outputFormat` is schema-only). Move instructions into `ctx.systemPrompt` or the user message.
- A capture tool whose `name` happens to match an active pi tool name is routed through MCP execution, not capture. Pick capture-tool names that don't collide. Upstream `Context.responseFormat` (separate change) would remove this risk.
- Multi-message replay is text-only and lossy: image content blocks are dropped (in any message position, including the current user prompt), assistant tool-call args truncated to 200 chars, tool-result content truncated to 500 chars. Image-bearing capture calls degrade to text-only inputs.
