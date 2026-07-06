# Intent

Fix the Claude bridge presentation bug where separate assistant text segments around tool-use boundaries are appended into one Pi text block, causing smashed prose such as `...provide it.The MCP servers...definitions:The pi_ping...` during claude-p transcript replay / warm-resume flushes.

The intended behavior is not token-level streaming. `claude-p` remains a message/transcript-level source. The bridge must preserve semantic text block boundaries when a `tool-use` event occurs, so progress narration before a tool call and later assistant text after the tool call render as distinct Pi text blocks instead of being concatenated into one open block. The fix should be bridge-only unless implementation evidence proves otherwise.

## Constraints

- Preserve `claude-p` as a non-token-streaming, transcript-line source; do not promise or fake token streaming.
- Preserve faithful passthrough of model text. Do not suppress `stop_reason: "tool_use"` narration solely to clean the UI.
- Do not change `claude-p` output formats or add new `claude-p` protocol flags for this bug unless a bridge-only boundary fix is proven insufficient.
- Do not add bridge-side liveness timers, watchdogs, or elapsed-time recovery paths.
- Do not route, execute, or surface native Claude tools; only existing pi-bridged MCP tool routing remains authoritative.
- Keep usage/cost accounting and live-billing dedupe behavior unchanged.
- Preserve warm-resume replay suppression semantics; only fix presentation/block boundaries.
- Add regression coverage for text → tool_use → text (and, if feasible, suppressResumeReplay flush) proving separate text blocks and no smashed concatenation.

## Invariants honored

- Constitution II: bridge remains inference-only, only forwarding driver output and routing tool calls back to pi.
- Constitution IV / Domain invariant 4: native/built-in tool emissions remain unrouted/unexecuted; display/cleanup changes must not make built-ins visible to pi.
- Constitution VII: no silent degradation or hidden fallback; unexpected driver/schema issues still surface through documented error/log paths.
- Domain invariant 2: tool results still reach the bridge only via pi's next `streamSimple()` call; no synthetic real tool results.
- `transcript-stream` requirement: `tool_use` does not terminate the turn; the turn still ends only at terminal `result`.
- `claude-p-driver` requirement: no bridge-side liveness timer or wall-clock cap is introduced.

## Non-goals

- True token streaming from `claude-p`.
- PTY screen-diff pseudo-streaming or parsing the live Ink UI as model output.
- Switching the bridge to native `claude -p` / `--print` / `--include-partial-messages`.
- Adding a new `claude-p` output protocol such as `bridge-json` for this fix.
- Hiding all progress narration before tool calls.
- Refactoring the transcript parser, router, cost accounting, or warm-resume sidecar design beyond the minimal block-boundary fix.
