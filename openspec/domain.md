# pi-claude-bridge Domain

**Version:** 1.1.0
**Last updated:** 2026-06-06 (invariant 3 amended: a pi restart/resume is no longer an unconditional cold-start trigger — a validated content-free resume sidecar warm-resumes the prior driver session; see `enable-warm-pi-resume`)

## Entities

- **pi conversation** — a user-facing chat session managed by pi.
  Has a UUID `sessionId`, may fork/compact/tree-navigate.
- **pi turn** — one user message + the bridge's response, which may
  contain many tool rounds before the model emits end_turn.
- **pi-bridged tool** — a tool registered with pi's tool executor and
  exposed to the inference driver via the bridge's MCP surface.
- **inference driver** — the external process the bridge invokes to
  produce model output. Today: Anthropic Agent SDK. After refactor:
  the `claude` interactive TUI binary driven via PTY.
- **driver session** — the inference driver's own conversation
  artifact (id + on-disk transcript). The bridge caches the id in
  memory; the on-disk transcript is read-only to the bridge.
- **transcript JSONL** — append-only event log the inference driver
  writes during a turn. Public hook contract surfaces its path.
- **main-provider path** — bridge code path for normal pi-user turns.
  Streams to pi UI, supports tool rounds, honors aborts.
- **capture path** — bridge code path for structured-output requests.
  No pi UI, no tool execution, single forced tool-call as result.
- **bridge frame** — in-memory state for one in-flight turn (the SDK
  query handle today; the PTY handle + transcript tailer after the
  refactor). Owns the pending-tool-result queue.
- **MCP shim (post-refactor)** — subprocess that speaks MCP on
  stdin/stdout to the inference driver and forwards calls to the
  bridge's in-process router.

## Invariants

1. At most one in-flight main-provider turn per pi conversation;
   subagent/capture turns are nested or isolated, never sibling
   peers of the main turn.
2. Tool results reach the bridge only via pi's next `streamSimple()`
   call. The bridge never synthesizes a "real" tool result.
3. A driver session id is treated as a cache hint only; on any
   pi-side divergence event (history hash mismatch, `/fork`,
   `/compact`, cwd change) the cached id is dropped and the next turn
   cold-starts. A pi restart/resume is NOT an unconditional cold-start
   trigger: WHERE a validated content-free resume sidecar exists (keyed
   by literal spawn cwd + full pi `sessionId`; pi-history prefix-match;
   matching `claude` version; and no intervening messages the recorded
   `claude` session never saw), the first post-resume turn warm-resumes
   the recorded driver session via `--resume`. Restart *without* a
   validated sidecar still cold-starts. (Amended 2026-06-06 for
   `enable-warm-pi-resume`; see constitution Principle I and the
   `warm-pi-resume` capability.)
4. Native tools are disallowed: the binding guarantee is that no native
   tool is ROUTED, EXECUTED, or surfaced to pi — enforced via driver
   config (disallow/allow list) AND the MCP server (defense-in-depth).
   The model MAY emit a native `tool_use` on instinct (and some drivers
   emit housekeeping built-ins, e.g. claude-p's `WaitForMcpServers`);
   such emissions are permissible PROVIDED the bridge drops them
   unrouted/unexecuted. (Reconciled 2026-05-31 to match Constitution IV
   v1.2.0; the prior "enforced at emission" wording was aspirational and
   did not match observed behavior — built-in tool_use blocks are emitted
   regardless of config and must be dropped, not prevented.)
5. Pi message-history-shape changes (image content, multi-block
   assistant messages, partial tool results post-abort) MUST be
   handled without re-architecting; the conversion layer normalizes
   them into the driver's expected input shape.

## Units and conventions

- **Runtime**: Node ≥20, ESM modules, TypeScript.
- **Time**: UTC ISO 8601 in logs (pino `stdTimeFunctions.isoTime`).
- **IDs**: driver session ids are UUIDs; bridge truncates to the
  first 8 chars when logging.
- **Tool names**: lowercase in pi (`read`, `bash`), PascalCase in the
  inference driver (`Read`, `Bash`). The bridge owns the mapping.
- **Logging**: JSON-per-line via pino, rotated by `rotating-file-stream`,
  bounded at ~3× `CLAUDE_BRIDGE_DEBUG_MAX_BYTES` total disk.
- **Configuration**: project `.pi/claude-bridge.json` overrides global
  `~/.pi/agent/claude-bridge.json`.

## Out-of-scope domains

- **Pi UI rendering** — pi's responsibility; the bridge pushes
  `AssistantMessage` events and never touches pi-tui directly except
  via the documented `ExtensionUIContext`.
- **Inference driver internals** — the bridge treats the driver as a
  black box configured via documented flags + hook payloads.
- **Other inference providers** — pi-ai's job; the bridge is
  Claude-specific.
- **Anthropic API mechanics** — never called directly; only the
  driver speaks to Anthropic.
- **MCP server beyond bridging pi tools** — the bridge MCP surface
  exists to expose pi tools, not to be a general MCP server.

## See also

- Constitution: `openspec/constitution.md`
- Schema docs: `~/.local/share/openspec/schemas/opsx-superpowers/README.md`
