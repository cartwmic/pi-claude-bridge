## Context

The bridge is built around the Claude Agent SDK's agent loop: pi-side tools are exposed as MCP tools, the SDK invokes them, the bridge round-trips results through pi for execution. This is the right shape for the pi-coding-agent flow (interactive UI, multi-turn, tool execution).

A second use case has emerged through pi-ai's `complete()`: callers pass `ctx.tools = [oneTool]` purely as a **JSON-schema vehicle** so the model emits a parseable `tool_use` block carrying structured args. The caller never executes the "tool" — the args *are* the result. This pattern is supported transparently by every direct pi-ai provider (anthropic, openai, google, mistral, openrouter) because they hand `ctx.tools` to the API and return the resulting `tool_use` as a `toolCall` content block.

The bridge breaks this contract. Today it routes the unregistered tool through MCP, the handler awaits pi-side delivery that never comes, and the SDK frame leaks until the next call's supersede path drains it. `pi-session-search` ships a `provider !== "claude-bridge"` workaround in its digest builder to avoid the issue. Empirically (probe in this exploration), `complete()` does return — the bridge's `done(toolUse)` fires on `message_stop` — but the SDK keeps generating tokens after the result is delivered, the cached SDK session pollutes the next call (history-divergence cold-restart on every capture call), and the workaround is still required because the bridge's `ctx.systemPrompt` replacement also drops the schema instructions.

The Claude Agent SDK exposes `outputFormat: { type: "json_schema", schema }` as a first-class option (verified in `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1423` and empirically against `claude-haiku-4-5`). The SDK validates, retries on validation failure (`error_max_structured_output_retries`), and surfaces the parsed object on `result.structured_output`. Internally it implements the schema as a synthetic `StructuredOutput` tool the model is forced to call, then runs one extra turn for the model to emit a (typically empty) closing message — `num_turns: 2`.

A critical wrinkle: `pi-session-search`'s digest builder fires capture calls **in the background** while the user's interactive pi turn is still in flight (see `digest/lifecycle.ts` — agent_end auto-trigger). The bridge's existing `streamClaudeAgentSdk` Case 3 ("fresh user turn") supersedes any active frame on the stack — interrupting the user's SDK query, draining its resolvers as aborted, and popping it. If a capture call entered that path, it would kill the user's interactive turn. The capture path therefore must not touch the shared `stack`, `cachedSessionId` / `cachedSessionCwd`, or `lastSentMessageHashes` at any point in its lifecycle.

Stakeholders: the bridge maintainers, `pi-session-search` (primary downstream caller today), and any future pi-ai consumer that wants structured output through claude-bridge.

## Goals / Non-Goals

**Goals:**
- Callers using `pi-ai.complete(model, ctx, opts)` with `ctx.tools = [unregisteredTool]` (no other tools) receive a normal `AssistantMessage` with a `toolCall` content block, matching the shape direct pi-ai providers return. No special-casing in caller code.
- The capture path is **fully isolated** from the user-session state machine: no shared stack, no shared session cache, no shared message-hash log. A capture call running concurrently with a user's interactive turn must leave the user's turn untouched.
- The `pi-session-search` digest workaround becomes deletable.
- The agent-loop path (registered pi tools, multi-turn execution) is byte-for-byte unchanged. No edits to `processStreamEvent`, `consumeQuery`, or the active-frame stack semantics.

**Non-Goals:**
- Output-capture for **multiple** unregistered tools in a single call. The SDK's `outputFormat` accepts one schema; supporting more would require simulating multiple via a synthetic union schema, with no clean way to map the synthesized result back to a specific tool name. Out of scope. Surfaced as a documented bridge error.
- **Mixed registered+capture** calls in v1. Simultaneous `mcpServers` + `outputFormat` SDK behavior is unverified; per-turn discrimination of the SDK's synthetic `StructuredOutput` invocation versus a real MCP tool invocation would require new logic in `processStreamEvent` (the very surface the isolation goal forbids touching). No current consumer needs this. Out of scope; rejected at the call site with an explicit error.
- Fixing the bridge's `ctx.systemPrompt` replacement (`"You are a helpful coding assistant."`) and the related `tool.description` loss via `outputFormat`. Independent issue; tracked separately.
- Upstreaming `Context.responseFormat` to pi-ai so callers can opt in explicitly. Right architectural answer long-term but requires upstream changes; tracked separately.
- Changing pi-ai's `Tool` type or `Context` shape.
- Synthesizing a `toolCall` block from text (Plan D in exploration). Adds prompt fragility for no benefit when the SDK gives us the schema-validated object.

## Decisions

_Decision numbers are stable identifiers added in iterative review order; they do not strictly correspond to document position. The narrative below reads top-to-bottom; cross-references in `tasks.md`, `spec.md`, and `proposal.md` cite the stable identifier (e.g. "per Decision 9"), not a document position._

### Decision 1: Use the SDK's `outputFormat` (Plan A)
Map the unregistered `ctx.tools[0]`'s `parameters` (a TypeBox/JSON schema) into `query()`'s `outputFormat: { type: "json_schema", schema }`. The SDK handles validation and retries; the bridge consumes `result.structured_output`.

**Alternatives considered:**
- *Plan B — per-tool MCP classifier with no-op handler + interrupt-at-`message_stop`*: ~30 lines, no SDK feature dependency, but loses built-in validation and retries. Documented as the fallback if the SDK ever drops `outputFormat`.
- *Plan C — register a no-op MCP handler and let the loop continue*: simpler than B but wastes tokens identically and offers nothing in return.
- *Plan D — strip tools, embed schema in prompt, parse JSON from text*: brittle, provider-specific. Rejected.
- *Plan E — push `Context.responseFormat` upstream to pi-ai*: the architecturally correct long-term answer; pursued separately. Plan A is forward-compatible (the bridge can later read `responseFormat` instead of inferring from `ctx.tools`).

**Rationale:** Plan A leans on a maintained SDK feature, eliminates the leak/waste/cache concerns, and keeps the bridge's added surface tiny.

### Decision 2: Classify by `pi.getActiveTools()` membership
A tool in `ctx.tools` whose `name` is **not** in the snapshot of `pi.getActiveTools()` at call time is a candidate capture tool. Match is exact-name, case-sensitive (pi's tool names are normalized lowercase already).

**Alternatives considered:**
- *`pi.getAllTools()`*: returns all *configured* tools regardless of active state. A registered-but-inactive tool name (turned off via `pi.setActiveTools`) would be classified as MCP-routed but pi never delivers a `tool_result` for it — reproducing the original indefinite-await bug. Reviewer A flagged this in Round 2 challenged assumptions.
- *Explicit `_capture: true` flag on the tool*: clean but requires caller cooperation and an upstream type extension.
- *Heuristic on schema shape*: fragile.

**Rationale:** `pi.getActiveTools()` is the authoritative answer to "will pi actually execute this name if Claude calls it?" That's the property that determines whether MCP routing terminates. The bridge already lives inside the pi extension runtime and has the accessor.

**Edge case:** if the bridge module is loaded outside an active pi runtime (e.g. a standalone test that calls the SDK provider directly without `pi.registerTool` having been invoked), `pi.getActiveTools()` returns an empty array. The classifier then treats every tool as a capture tool, which is the intended fallback behavior for those callers.

### Decision 3: Strict call-shape — capture mode is mutually exclusive with executable tools, root must be object
A call's `ctx.tools` must be one of:
1. **All executable** (zero capture tools): the existing agent-loop path runs unchanged.
2. **Exactly one capture tool and zero executable tools**, AND the capture tool's root schema must be `type: "object"`: the new capture path runs.

Any other shape — multiple capture tools, one capture tool alongside any executable tool, or a single capture tool whose root schema is non-object (e.g. `Type.Array(...)`, `Type.String(...)`) — is rejected with an `error` event on the pi-ai stream. The `errorMessage` names the offending tools (or the offending root type) and states the limitation.

**Alternatives considered:**
- *Allow mixed registered+capture*: Reviewer B (Round 1) flagged this as P1: suppressing `done(toolUse)` whenever a capture tool is present in the frame would block the executable tool's MCP handoff and deadlock the call. Per-turn discrimination of SDK-synthetic `StructuredOutput` vs real MCP `tool_use` would require non-trivial edits to `processStreamEvent`, contradicting the isolation goal.
- *Allow multiple unregistered tools and synthesize a `oneOf` schema*: ambiguous semantics for which tool's `name` to attribute the result to.
- *Silently use the first capture tool and ignore the rest*: silent data loss.
- *Allow non-object root schemas and wrap them in a synthetic envelope*: the synthesized `toolCall.arguments` would no longer mirror the caller's schema; callers writing schemas to validate the output would need bridge-specific unwrapping. Reject instead — Reviewer B (Round 2 P3).

**Rationale:** pi-ai's `ToolCall.arguments` is typed as `Record<string, any>`; non-object `structured_output` would not be a valid `arguments` value. Loud failure at the call site is the only honest behavior. v1 ships the strict shape; if a future consumer needs mixed-mode or non-object root it's a follow-up change with its own design.

### Decision 4: Capture path runs in isolation — no shared state mutation
The capture path is implemented as a dedicated function `runCaptureQuery(model, captureTool, context, options, stream)`. It builds its own `query()`, awaits the `result` message, synthesizes the AssistantMessage, ends the pi-ai stream. It does **not**:
- push a frame onto the global `stack`;
- mutate `cachedSessionId`, `cachedSessionCwd`, or `lastSentMessageHashes` at any point — neither at SDK `system:init` (mid-flight session capture) nor at completion;
- enter the `streamClaudeAgentSdk` Case 1 / Case 2 / Case 3 dispatch (it's a Case 0 short-circuit reached before any of those run);
- participate in supersede coordination with an active user frame.

`streamClaudeAgentSdk` detects the capture shape **first**, before reading `top()` or examining `lastMsg`. If the call is capture-shaped (one capture tool, no executable tools), control routes to `runCaptureQuery` and returns. If the call is rejection-shaped (multi-capture or mixed), an error event is pushed and the function returns. Otherwise the existing dispatch proceeds.

**Alternatives considered:**
- *Frame-mode flag (`outputCapture` on the existing QueryFrame)*: the original design. Reviewer A (Round 1) showed this leaks shared state at multiple sites — `system:init` mid-flight session-id capture, `lastSentMessageHashes` divergence detection, the `stack` itself with its supersede semantics. Required guards at every mutation site, fragile to add later.
- *Reuse `startFreshQuery` with an `if` branch*: same problem, still touches shared state.

**Rationale:** the capture call is structurally one-shot, stateless, concurrent-with-user-turns, and has no follow-up. Modeling it as a sibling of `startFreshQuery` (rather than a special case) makes those properties enforced by structure rather than by guards.

### Decision 12: Hermetic `cwd` and SDK construction error handling
The capture path passes `cwd: os.tmpdir()` (NOT `process.cwd()`) to the SDK `query()`. Capture-mode calls have no working-tree dependency — there's no project context to read, no skills to discover, no AGENTS.md to load (skills/AGENTS forwarding is disabled per Decision 9). Defaulting to `process.cwd()` (as `startFreshQuery` does) would bind the capture-mode subprocess to whatever directory the caller happened to be in, leaking caller state into the capture call.

`runCaptureQuery` wraps the `_queryFactory(...)` invocation in try/catch. On synchronous throw (invalid schema, subprocess spawn failure, test-injected mock error), the bridge synthesizes an `error` AssistantMessage and pushes it on the pi-ai stream rather than propagating the throw to the caller. The terminal-result requirement and this requirement together cover every path on which the capture call can end without `done(toolUse)`.

### Decision 5: Synthesize the AssistantMessage on SDK `result`; suppress all intermediate stream events
`runCaptureQuery` consumes its own `query()`'s message stream. The pi-ai stream receives **only**: a single `start` event when the iterator opens, and a single terminal `done(toolUse)` or `error` event at finalization. No intermediate `text_*`, `thinking_*`, or `toolcall_*` events are pushed — capture mode is opaque to the caller; only the validated structured output surfaces.

Rationale: pi-ai's event protocol is block-oriented (`*_start` → `*_delta`* → `*_end`, indexed by `contentIndex` referring to a real entry in `partial.content`). The SDK's intermediate `StructuredOutput` synthetic tool_use and the closing-turn text from `num_turns: 2` are not blocks the caller wants to see; forwarding `text_delta` without matching `text_start`/`text_end` (or vice versa) would corrupt block-indexed consumers. Reviewer A and Reviewer B (Round 2 P1/P2) both flagged this in the prior iteration's mixed-event design.

On the SDK `result` message:
- If `(result as any).structured_output !== undefined`: build an AssistantMessage from `newTurnOutput(model)` (which sets `api`/`provider`/`model`/`timestamp` correctly), then set `content = [{ type: "toolCall", id: <generated toolu_...>, name: <captureTool.name>, arguments: result.structured_output }]`, set `stopReason = "toolUse"`, set `usage` from `result.usage` (mapping `input_tokens` → `usage.input`, `output_tokens` → `usage.output`, `cache_read_input_tokens` → `usage.cacheRead`, `cache_creation_input_tokens` → `usage.cacheWrite`), and call `calculateCost(model, output.usage)` — exactly the same path `updateUsage()` already uses for the agent-loop. Push `done(toolUse)` with that AssistantMessage; end the stream.
- Else (any terminal `result` lacking `structured_output`): build an AssistantMessage from `newTurnOutput(model)`, set `stopReason = "error"`, `errorMessage = \`SDK structured-output failure: subtype=${result.subtype}\${result.is_error ? " is_error=true" : ""}\``. Propagate `usage` / `cost` if present (callers may want to see retry-cost on failure). Push `error` event; end the stream.

After pushing the terminal event, `runCaptureQuery` calls `query.interrupt()` (best-effort; ignore errors) and breaks out of the iterator. This is the chosen approach for Open Question 3 (interrupt vs drain): the SDK's contract on extra messages after `result` is unspecified, and the pi-ai stream is already closed at that point so extra events would be discarded by `EventStream.push`'s `done` guard regardless. Calling `interrupt` shuts the underlying subprocess down promptly; not waiting on the iterator avoids accidental hangs if the SDK buffers further messages.

**Alternatives considered:**
- *Push synthesized message at `message_stop` of the synthetic `StructuredOutput` tool turn*: that's turn 1 of 2; `result.structured_output` is finalized at the end of turn 2. Premature.
- *Drain the iterator to completion before finalizing*: would block until SDK closes its own iterator, adding latency for no observable benefit.
- *Forward intermediate text/thinking deltas as informational*: violates pi-ai block-lifecycle protocol (Reviewer A/B Round 2).

**Rationale:** the `result` message is the authoritative carrier of the validated object; the pi-ai stream surface is the synthesized AssistantMessage and nothing else.

### Decision 6: Deep JSON-only schema clone
Schema preparation for `outputFormat` uses `JSON.parse(JSON.stringify(captureTool.parameters))`. This preserves every JSON-serializable keyword at every depth (nested `properties`, `items`, `minLength`/`maxLength`/`minItems`/`maxItems`/`pattern`/`enum`/`required`/etc.) and naturally drops symbol-keyed TypeBox metadata (`Symbol(Kind)`, `Symbol(Modifier)`, etc.) which `JSON.stringify` skips at every depth.

**Alternatives considered:**
- *Shallow allowlist walker*: original design. Reviewer A and Reviewer B both flagged this as P1 — it would drop `minLength`/`minItems`/`pattern` from nested schemas, defeating the validation we're using `outputFormat` for in the first place.
- *Hand-rolled deep walker*: more code, more bugs. The serialize/parse round-trip is the standard idiom.

**Rationale:** `JSON.parse(JSON.stringify(x))` is the right size of tool: handles every JSON-schema keyword, naturally drops everything non-JSON, no maintenance.

**Validation:** the integration test pulls `pi-session-search`'s actual `submit_digest` schema (with `Type.Optional`, nested `Type.Array`/`Type.Object`, length/count constraints) through the cleaner and asserts every constraint survives in the output.

### Decision 7: No session/hash/state caching for capture frames
`runCaptureQuery` does not write `cachedSessionId`, `cachedSessionCwd`, or `lastSentMessageHashes` at any point. Capture-mode SDK sessions are not eligible for warm resume, do not contribute to history-divergence detection, and do not appear in any cross-call state.

**Implication:** every capture call is a cold SDK-session start. Acceptable given the typical cadence (a digest builder fires once per agent_end). If hot capture-call paths emerge later, a separate caching strategy can be designed without touching the user-session cache.

### Decision 9: Forward `ctx.systemPrompt` and replay `ctx.messages` (text-only) on the capture path
The capture path uses `context.systemPrompt` verbatim as the SDK's static system prompt (no append of pi-skills / AGENTS / APPEND_SYSTEM blending — those are pi-UI concerns, not pi-ai-consumer concerns). The capture path replays `context.messages` into the SDK prompt by calling the existing `buildColdStartPrompt(context.messages)` helper.

**Documented fidelity limit:** `buildColdStartPrompt` produces a *text-only* serialization. Image content blocks in user or assistant messages are dropped (per `convert.ts` `messageContentToText`). Assistant tool-call arguments are truncated to 200 chars; tool-result content is truncated to 500 chars (per the helper's current implementation, `index.ts:740–756`). This is acceptable for v1 because the primary use case (`pi-session-search` digest builder) passes a single user message containing the entire conversation as already-serialized text; it does not rely on image content or untruncated tool-call history. Reviewer B (Round 3) flagged this lossiness; we accept it as a documented v1 limitation rather than redesigning multi-message replay around an `AsyncIterable<SDKUserMessage>` (which would couple the capture path to the SDK's user-message protocol and substantially expand scope).

**Why this is in scope (when broader systemPrompt forwarding is not):** the agent-loop path's systemPrompt replacement is intentional — it stitches together pi's UI-side system prompt with CC's preset and various append blocks. That logic does not apply to a pi-ai consumer making a one-shot capture call: the consumer hands us a system prompt explicitly tailored to the model and doesn't want pi-UI material spliced in. Forwarding `ctx.systemPrompt` only on the capture path is the minimum fix for parity with direct providers, and is structurally isolated from the agent-loop systemPrompt question.

**Tool `description` channel remains lost:** `outputFormat` is schema-only, so `captureTool.description` is dropped. Callers must move description-equivalent instructions into `ctx.systemPrompt` or the user message. Documented limitation.

### Decision 8: `pi.getActiveTools()` snapshot, not subscription
The classifier reads `pi.getActiveTools()` once per call (at the start of a fresh user turn; never on tool-result delivery). If pi's active tool set changes mid-call, that's observable on the next call. We do not subscribe to a tool-registration event stream.

**Rationale:** simpler. Tool registration / activation churn during a single `complete()` call is an edge case; if it materializes, the classifier's snapshot is no worse than the rest of the bridge's per-call state.

### Decision 10: Classification gated on fresh-turn dispatch only
`streamClaudeAgentSdk` MUST run capture classification **only when** `lastMsg?.role !== "toolResult"` (i.e. only on the path that today reaches Case 3). On tool-result delivery (Cases 1 and 2), classification SHALL NOT run; the existing handling SHALL be invoked unchanged.

**Why:** Reviewer B (Round 3) flagged that running classification first hijacks tool-result delivery. If `ctx.tools` drifts between the original turn and the result delivery (e.g. user reconfigures active tools while a turn is mid-flight), classification could re-route a tool-result delivery into a rejection path or capture path, breaking active frames whose pendingResolvers must still be drained. The existing Case 1/2 logic is unchanged by this design and must remain unchanged at runtime.

**Implementation:** the Case 0 / capture-shape gate is the FIRST inspection only when `lastMsg?.role !== "toolResult"`. When `lastMsg?.role === "toolResult"`, the existing Case 1 / Case 2 logic runs first and exits before any capture-shape check.

### Decision 11: Test seam via injectable `query` factory
The bridge SHALL introduce a module-level `let _queryFactory: typeof query = realQuery` (or equivalent) and a test-only export `__setQueryFactoryForTests(f)`. Both `startFreshQuery` and `runCaptureQuery` invoke `_queryFactory(...)` instead of importing `query` directly. The seam exists solely to enable deterministic mock-based unit tests of error subtypes (e.g. `error_max_structured_output_retries`) and of stream-event suppression — both flagged by Reviewer A (Round 3) as untestable without a seam.

**Alternatives considered:**
- *Live-model tests with schema-impossible-to-satisfy inputs*: deterministic in theory but consumes real tokens per CI run, and SDK retry behavior may evolve unpredictably. Reject as the primary mechanism; keep one such test as a smoke-level supplement.
- *Black-box log-grep verification only*: works for some assertions (no `superseding`, no `caching`) but cannot drive the SDK to specific failure modes. Reject for the failure-path tests.

**Rationale:** the seam adds 5 lines of code, is test-only, and unblocks the specific deterministic assertions reviewers flagged. The agent-loop path benefits identically on future changes.

### Decision 13: Permission flag set per SDK type-doc requirement
`runCaptureQuery` sets BOTH `permissionMode: "bypassPermissions"` AND `allowDangerouslySkipPermissions: true` on the SDK query options. The SDK type definitions state `permissionMode: "bypassPermissions"` "requires `allowDangerouslySkipPermissions`" and the boolean "must be set to `true`" (`sdk.d.ts:1440–1459`). The agent-loop path historically omits the boolean and works in practice, but the documented contract is explicit — verify in probe 0.1 that omitting the boolean still works on the current SDK version, and if so document the intentional deviation; otherwise set the boolean explicitly.

### Decision 14: Pi-TUI scenario suite reliability — per-scenario overrides + regex specificity
Independent verification runs of the full scenario suite surfaced pre-existing flakes in scenarios this change does not touch (s5, s7, s13, s20, s22-investigate). Rather than ship known-flaky regression coverage, the change folds in a reliability patch with two principles:

1. **Per-scenario overrides via `scripts/scenario-overrides.conf`.** A small declarative file with `<name>|<timeout>|<model>` lines (each field optional, `-` = suite default), parsed by `lookup_override()` in `run-all-scenarios.sh` and applied via an `env SCENARIO_MODEL=...` prefix and per-scenario timeout. Scenarios that depend on slow model execution to land their assertions deterministically (s5 steer-mid-stream, s13 abort cascade, s20 tool invocation reliability) pin opus. Scenarios that need a longer envelope than the suite default (s22-investigate — opus + extended thinking + multi-section subagent essay) pin their own timeout. This makes each scenario's actual cost and model dependency explicit in the file, rather than buried in a global env-var tuning matrix.

2. **Coherence regex specificity convention.** Several scenarios used grep-style POS/NEG regex pairs that under-specified affirmatives and over-matched on incidental words. Tightening rules adopted as convention for all future scenario coherence checks:
   - **POS** matches **clear affirmatives** (a standalone yes-token or a recall-phrasing like "earlier you asked"), not just "any topic word soup near a topic word".
   - **NEG** matches **clear denials** (a standalone no-token, an explicit denial phrase like "don't recall", or a whole-task completion claim like "finished the count"). NEG must NOT fire on incidental phrases that happen to contain a topic word (e.g. s7's old `i finished` matched "I finished number 1 completely" — the model accurately reporting *which* number it reached, not denying interruption).
   - **Boundaries** use POSIX `[^[:alpha:]]` rather than `\b` for portability across BSD and GNU `grep -E`.
   - Both regex pairs SHALL be validated against ≥12 representative response shapes (bare yes/no, explicit phrasings, denial phrases, false-positive guards) before landing.

**Alternatives considered:**
- *Retry-on-fail wrapper around flaky scenarios*: hides genuine regressions in the second try. Rejected.
- *Mark s5/s7/s13/s20 as "known flakes" in SCENARIOS.md*: "we don't accept flaky tests" — rejected per owner directive.
- *Switch all scenarios to opus globally*: triples wall-clock and API cost; only the timing-sensitive scenarios actually need it.
- *Switch flaky scenarios to deterministic fixtures (a fake slow-tool extension instead of asking the model to invoke bash)*: would change what the test exercises (the bridge's MCP-handler-with-real-bash plumbing). Heavier scope; deferred unless prompt fixes prove insufficient.

**Verification:** the patched scenarios were re-run 3 times consecutively with **0 flakes across 18/18 runs** of the previously-flaky set (s5, s7, s13, s20, s22-investigate, s25-capture-during-turn). Full suite went from 27/28 to 28/28.

## Risks / Trade-offs

- **[Risk]** SDK `outputFormat` behavior changes or is removed in a future `@anthropic-ai/claude-agent-sdk` version. → **Mitigation:** integration test will fail loudly on regression; package.json pins to `^0.2.111`; fallback Plan B (per-tool MCP no-op) is documented above and can be implemented in ~30 lines if needed.
- **[Risk]** TypeBox schemas contain JSON-serializable keywords the SDK's validator rejects (e.g. `additionalProperties: false`, `examples`, `$ref`). → **Mitigation:** the integration test exercises a representative TypeBox schema (the actual `submit_digest` from `pi-session-search`). On rejection we either trim a specific keyword in the schema cleaner with a justification, or surface the SDK's error subtype to the caller.
- **[Risk]** `error_max_structured_output_retries` (or future failure subtypes) — bridge must not silently treat absent `structured_output` as success. → **Mitigation:** Decision 5 `else` branch covers *any* terminal `result` lacking `structured_output`, not just the documented error subtype. Spec scenario asserts both paths.
- **[Risk]** Tool `description` text is dropped: `outputFormat` carries only the schema, no description channel. The SDK's internal `StructuredOutput` synthetic tool is what the model "sees", not the caller-named tool. For capture tools whose only behavior signal lives in `description`, the model has nothing to go on. → **Mitigation:** documented limitation in proposal/README. `pi-session-search`'s prompt builder already duplicates schema instructions into the user message (`digest/builder.ts:213–220`), so its primary use case is covered. If a future caller depends on `description` channel, the fix is upstream — fold the description into the user-supplied system prompt at the caller, or add a bridge-level "prepend description to system prompt for capture mode" feature in a follow-up. Not in v1.
- **[Risk]** A caller passes a registered pi tool name *and* an unregistered tool in the same call (mixed mode). → **Mitigation:** Decision 3 rejects this with an explicit error event; the spec's "Mixed registered and unregistered tools" requirement (Round 0 draft) is removed. Mixed mode is a documented non-goal.
- **[Risk]** A capture call running concurrently with a user's interactive turn must not affect the user's turn. → **Mitigation:** Decision 4 isolates the capture path entirely. Spec scenarios assert no `superseding active frame` log line and no shared-state mutation as a result of capture calls. Integration test exercises the concurrent path.
- **[Trade-off]** `num_turns: 2` per capture call (~5–6s for haiku-4-5; the model emits an empty closing turn after StructuredOutput). The direct-provider path in pi-ai is one turn. We accept the extra turn in exchange for SDK-side validation/retries and zero caller changes. If a future SDK option removes the closing turn, it's a one-line tweak.
- **[Trade-off]** No support for multiple capture tools per call, no support for mixed mode. Documented limitation; surfaced as explicit errors. Current consumers (pi-session-search) are unaffected.

## Migration Plan

1. Land the change behind no flag (it's purely additive: a new code path entered only when `ctx.tools` matches the capture shape; everything else takes the unchanged path). Existing tests continue to pass.
2. Cut a minor release of `pi-claude-bridge` (e.g., `0.4.0`).
3. Coordinate with `pi-session-search` to delete its `provider !== "claude-bridge"` workaround in `src/digest/builder.ts` and bump its `pi-claude-bridge` peer requirement.
4. **Rollback:** revert the bridge change. The `pi-session-search` workaround is independent — it can be re-added if needed without coupling.

## Open Questions

- Does the SDK accept TypeBox-derived schemas after a `JSON.parse(JSON.stringify(...))` round-trip? Verify in the integration test against the actual `submit_digest` schema (with `Type.Optional`, nested arrays, length constraints). If it rejects a specific keyword, surface the SDK error and trim with justification.
- Resolved: synthesized `toolCall.id` uses Anthropic's `toolu_<random>` prefix (matches bridge's existing log infrastructure assumptions).
- Resolved: capture path calls `query.interrupt()` after observing `result` and breaks out of the iterator (Decision 5). No drain-to-completion.
- Is the `num_turns: 2` extra-turn cost worth a follow-up to ask Anthropic for an SDK option that returns immediately on `structured_output` capture? Track as upstream feedback; not blocking.
