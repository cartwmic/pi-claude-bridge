# ADR-0010: Capture-mode MCP completion semantics — deterministic shim response, harvest on Stop

**Status:** Accepted
**Date:** 2026-05-24
**Source change:** `openspec/changes/archive/2026-05-24-replace-sdk-with-pty-tui/`

## Context

ADR-0005 made capture mode a forced MCP tool-call. The MCP shim must respond to the model's tool-use call somehow — but unlike pi-tool calls (which park a Promise until pi delivers a result via the next `streamSimple()`), the capture tool has no pi-side executor. There's no pi to deliver a `tool_result`. The shim must answer the call itself.

## Decision Drivers

- Model must observe a normal MCP tool response (not a hang, not a special-case)
- Schema validation must happen at protocol layer (constitution-IV-grade enforcement)
- Re-entry: the model may emit multiple tool-use blocks for the capture tool in the same turn
- Empty case: the model may emit zero tool-use blocks before `Stop`
- Constitution VII: every failure surfaces as a structured error

## Considered Options

### Option A: Deterministic shim response + IPC stash, harvest on Stop
On `tools/call`:
1. Validate args against JSON schema. On failure: return MCP `-32602 Invalid params` with failing field path (model self-corrects in same turn).
2. On success: stash validated args in router state; return deterministic response `{ "content": [{ "type": "text", "text": "Capture received. End your turn now." }] }`. Normal MCP response — not a hang.
3. Router has `mode: "capture" | "main"` flag set at PTY spawn time. Capture-mode tool calls are answered locally by the shim without round-trip to bridge router.
4. Bridge harvests stashed args via captured-args field after `Stop` (or after abort lifecycle per ADR-0009).

Multi-call: first valid call wins (stash retained); second call gets MCP `-32603` ("capture tool already received result; end your turn").

Zero calls: `output-capture.surface-absent-capture-tool-call-as-error` fires.

**Pros:** normal MCP semantics; no hang; schema enforced at protocol layer; deterministic teardown via Stop or abort.
**Cons:** "End your turn now" text is a model directive — model may ignore (covered by Stop timeout + observable in transcript).

### Option B: Native `claude --json-schema <schema>` flag
**Pros:** native enforcement.
**Cons:** documented examples are `-p`-only; interactive-mode availability unverified at decision time. Reuses SDK trust-surface concern (ADR-0001). May be revisited.

### Option C: Have the shim park a Promise as if it were a normal pi tool
**Pros:** unified code path with pi-tool handler.
**Cons:** would hang forever — there's no pi to deliver a tool_result. Rejected.

### Option D: Model sees no MCP response (timeout-driven completion)
**Pros:** simplest shim.
**Cons:** hang or model-dependent behavior. Rejected.

### Option E: Return MCP error on every capture-tool call so model treats it as non-call
**Pros:** unified error path.
**Cons:** model would retry or give up; semantics unclear; rejected.

## Decision Outcome

**Chosen option:** A — deterministic shim response + IPC stash; harvest on Stop.

**Rationale:** addresses Round-1 B.P1#3. The capture path needs its own MCP completion semantics distinct from main-provider Promise-parking. Deterministic response avoids hangs; IPC stash gives the bridge authoritative source (see ADR-0013); schema enforcement at protocol layer is the same guarantee class as SDK `outputFormat`.

## Consequences

**Positive:**
- Normal MCP semantics for `claude`
- Schema enforced at protocol layer
- First-valid-call-wins is unambiguous
- Multi-call and zero-call edge cases have spec'd error paths
- Router `mode` flag keeps capture path isolated from main-provider code

**Negative:**
- "End your turn now" is a directive; model may produce extra prose before `end_turn` (mitigated by ADR-0017-style latency benchmark; not currently an ADR)
- Capture-mode authoritative source is IPC stash, not transcript (intentional; see ADR-0013)
- Specific to v1.0.0; Option B remains as future evolution path

**Neutral:**
- Subsequent calls return `-32603` ("capture tool already received result")

## Links

- Source design discussion: `openspec/changes/archive/2026-05-24-replace-sdk-with-pty-tui/design.md` (Decision D16)
- Related ADRs: ADR-0005 (capture mode), ADR-0013 (authoritative source), ADR-0003 (MCP transport)
- Verification: `tests/int-pty-capture-success.mjs`, `tests/int-pty-capture-error.mjs`
