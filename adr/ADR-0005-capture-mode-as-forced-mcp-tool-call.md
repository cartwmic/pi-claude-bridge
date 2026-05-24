# ADR-0005: Capture mode as forced MCP tool-call (tool-as-output)

**Status:** Accepted
**Date:** 2026-05-24
**Source change:** `openspec/changes/archive/2026-05-24-replace-sdk-with-pty-tui/`

## Context

The output-capture feature lets a pi caller pass a single tool schema (`ctx.tools = [captureTool]`) and receive a synthesized `AssistantMessage` containing a `toolCall` content block whose `arguments` validate against the schema. Pre-v1.0.0 this was implemented via the SDK's `outputFormat` option. ADR-0001 removes the SDK, so capture mode needs a new mechanism.

## Decision Drivers

- Preserve external `piAi.complete()` contract for capture-shape calls
- Schema enforcement must happen at the protocol layer (not in post-hoc JSON.parse)
- Reuse existing infrastructure (stdio MCP shim from ADR-0003) where possible
- Constitution VII: failures (model never calls the capture tool) must surface

## Considered Options

### Option A: Forced MCP tool-call (tool-as-output)
Spawn a dedicated PTY in `os.tmpdir()` with the shim advertising ONLY the capture tool. All native tools in disallow list. Model emits a tool-use block; shim validates args against JSON schema at the MCP protocol layer (rejecting invalid args with `-32602`, forcing self-correct in same turn); bridge harvests validated args via IPC stash; synthesizes `AssistantMessage` with one `toolCall` content block.

**Pros:** schema enforcement at the protocol boundary (same guarantee class as SDK's `outputFormat`). Reuses ADR-0003 stdio MCP infrastructure. Model self-corrects on invalid args without a full re-spawn.
**Cons:** model may decline to call the tool (handled by `output-capture.surface-absent-capture-tool-call-as-error`).

### Option B: Re-prompt-and-validate
Inject schema into user prompt, ask for JSON, parse the final assistant text.

**Pros:** no MCP plumbing.
**Cons:** no protocol-level enforcement; fence-stripping fragility; retries cost a full PTY boot each (~600ms each).

### Option C: Drop capture mode entirely
**Pros:** zero work.
**Cons:** rejected by user — real consumers exist (digest writers, structured extractors).

### Option D: Keep SDK only for capture
**Pros:** working today.
**Cons:** violates ADR-0001's "no SDK runtime dependency" goal.

### Option E: Native `claude --json-schema <schema>` flag
`claude --help` documents this flag for structured output.

**Pros:** native enforcement.
**Cons:** examples are all `-p`-mode; interactive-mode availability unverified at decision time. Reuses the SDK trust-surface concern. May be revisited if interactive-mode support is confirmed.

## Decision Outcome

**Chosen option:** A — forced MCP tool-call (tool-as-output).

**Rationale:** mirrors what the SDK does internally (`outputFormat` is effectively "register the schema as a forced tool"). Reuses the stdio MCP infrastructure built for ADR-0003. Schema enforcement at the MCP protocol boundary is the same guarantee class as today's SDK `outputFormat`. No special-case code path.

## Consequences

**Positive:**
- Schema validated at protocol layer (MCP `-32602` for invalid args)
- Reuses ADR-0003 shim; no special-case code path
- Per-call PTY isolation (constitution VI: concurrent paths share no state)
- Model can self-correct invalid args in the same turn

**Negative:**
- Per-call PTY boot cost (~600ms)
- Model declining to call the tool is a failure mode (handled by spec'd error event)
- First valid call wins; subsequent calls get `-32603` (semantics in ADR-0010)

**Neutral:**
- Capture-mode authoritative source is IPC stash, not transcript (see ADR-0013)

## Links

- Source design discussion: `openspec/changes/archive/2026-05-24-replace-sdk-with-pty-tui/design.md` (Decision D5)
- Related ADRs: ADR-0001 (PTY-driver), ADR-0003 (MCP transport), ADR-0010 (MCP completion semantics), ADR-0013 (authoritative result source)
