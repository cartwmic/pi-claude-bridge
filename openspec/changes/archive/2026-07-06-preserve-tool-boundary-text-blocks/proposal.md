<!-- authored: in-session -->

## Why

Claude-p emits complete assistant transcript messages, not token deltas. The bridge currently appends multiple assistant text segments around tool-use boundaries into one open Pi text block in replay/warm-resume paths, producing smashed prose and corrupting the user-visible assistant message shape while Pi remains the conversation owner.

## What Changes

- Preserve assistant text block boundaries when the driver observes a tool-use event, so text before a tool call and text after a tool call render as separate Pi text blocks.
- Keep claude-p as a transcript-line source; do not add token streaming, PTY screen-diff parsing, or new claude-p output protocol for this fix.
- Preserve faithful passthrough of model text; do not suppress `stop_reason: "tool_use"` narration as a UI cleanup shortcut.
- Add regression coverage for text → tool_use → text replay behavior proving no smashed concatenation.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- None. This is a bridge rendering/block-boundary bug fix under existing transcript-stream behavior; `tool_use` still does not terminate the turn, and terminal `result` remains the turn-end marker.

## Impact

### Affected files

- `index.ts` — close open inline text/thinking blocks when processing a `tool-use` event.
- Tests under `tests/` — add or extend regression coverage for transcript replay / tool-use boundary rendering.

### Affects which projects

- `pi-claude-bridge` only.
- No `claude-p` changes intended.

### Compatibility

- No public API or output-format change.
- No cost/usage accounting change.
- No liveness timeout or watchdog change.
