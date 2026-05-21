## Context

The bridge today runs every inference call through `@anthropic-ai/claude-agent-sdk`. The SDK is a programmatic equivalent of `claude -p` and has historically been the most ergonomic surface for our needs. The owner no longer trusts the SDK as a durable surface — auth-path coupling, feature drift relative to the user-facing TUI, and the smithersai/claude-p observation that "client-side restrictions on how a product is used are fundamentally unenforceable" together justify removing the SDK from the dependency graph entirely.

The replacement drives the same `claude` interactive TUI binary a human user runs, configured via inline flags (`--mcp-config`, `--settings`, `--session-id`) and observed via the documented hook payload contract (`SessionStart`, `Stop`) + the transcript JSONL it writes at a path the bridge deterministically computes from the pre-generated session UUID.

**Constitution citations**
- **III.** No filesystem coupling to driver mutable state — the design uses inline flags only; transcript JSONL is read-only.
- **IV.** Native Claude tools are disallowed — enforced in driver config AND in the MCP shim (defense-in-depth, per clarify finding I1).
- **V.** System prompt fidelity per path — main provider appends documented material; capture path forwards verbatim. The PTY swap preserves these contracts.
- **VI.** Concurrent paths share no state — main and capture spawn independent PTYs with independent shims.
- **VII.** Failures surface — every error path (PTY exit, missing transcript, malformed JSONL, shim rejection) maps to a structured log entry and a `stopReason: "error"` AssistantMessage.

**Domain citations**
- Invariant 1 (at most one in-flight main-provider turn): main PTY is single-instance per pi conversation.
- Invariant 4 (disallow at emission AND execution): driver config + shim rejection.
- Invariant 5 (history-shape changes handled without re-architecting): conversion layer in `convert.ts` is preserved.

## Goals / Non-Goals

**Goals**
- Remove `@anthropic-ai/claude-agent-sdk` and `@anthropic-ai/sdk` from `package.json`.
- Preserve the external `piAi.complete()` contract (main + capture paths).
- Drive the real `claude` interactive TUI binary via a pseudoterminal; configure entirely via inline `--mcp-config` and `--settings` flags.
- Stream model output to pi at per-content-block granularity via transcript JSONL tail.
- Bridge pi tools to the driver via a stdio MCP shim subprocess connected to an in-process router that preserves the "park Promise, resolve on pi's next streamSimple()" contract.
- Reimplement capture mode as a forced MCP tool-call.
- Remove the AskClaude tool, its config surface, and its env switch.
- macOS + Linux supported; Windows out of scope.

**Non-Goals**
- Token-level streaming (regressing from SDK's per-event iterator). Per-block is the new contract.
- Reusing PTYs across pi turns to amortize boot latency. A warm-PTY pool is a future enhancement, not part of this change.
- Replacing pi's conversation-state machinery in `index.ts` (divergence detection, abort coordination, supersede). That code is driver-agnostic and survives the refactor.
- Implementing an Anthropic API client directly. The bridge talks only to the `claude` binary.
- Supporting Windows. node-pty supports ConPTY but we do not commit to testing or fixing Windows-specific paths.

## Decisions

### D1: Replace the Agent SDK with a PTY-driven `claude` TUI invocation

**Choice:** Drive the real `claude` interactive TUI binary inside a pseudoterminal. The bridge configures every spawn with this exact flag set:

```
claude
  --model <id>
  --system-prompt <verbatim text>          # see D7-final
  --mcp-config '<inline-json>'             # only mcp__custom-tools__*
  --strict-mcp-config                      # block user-global MCP servers
  --setting-sources ""                     # ignore user/project/local settings
  --settings '<inline-json>'               # bridge hooks (SessionStart + Stop only) + permission denies
  --permission-mode bypassPermissions      # no interactive permission dialogs
  --session-id <pre-generated-uuid>        # see D18 — deterministic transcript path discovery
  [--resume <session-id>]                  # warm resume (uses cached id; ignores --session-id)
  <pi user prompt as positional argument>  # see D13
```

No SDK runtime dependency post-refactor.

**Alternatives considered**
- **Keep the Agent SDK as-is.** Lowest effort. Rejected: the owner explicitly distrusts the SDK as a durable surface; future restrictions or drift are an unbounded liability.
- **Use `claude -p` (headless) as a subprocess.** Preserves real streaming via `--output-format stream-json`. Rejected: `claude -p` IS the SDK's mode under the hood; the same trust concerns apply. The whole point of this refactor is to avoid the headless code path.
- **Talk to the Anthropic API directly.** Maximum control, minimum binding to Claude Code. Rejected: re-implements model selection, prompt caching, auth, and subscription routing that the `claude` binary already handles correctly.

**Rationale:** the user-facing TUI is the surface Anthropic is most committed to keeping unrestricted for personal subscriptions. Driving the same binary a human user runs minimizes coupling to product strategy changes.

**Flag rationale (from Round-1 adversarial review):**
- `--strict-mcp-config` is mandatory — without it, the user's globally-configured MCP servers are loaded alongside our inline config, exposing tools constitution principle IV requires blocked.
- `--setting-sources ""` is mandatory — without it, user/project/local settings can override the bridge's inline permissions/hooks. (Empty value is the documented "load nothing" form; Phase 0 spike T0.7 verifies this is honored.)
- `--permission-mode bypassPermissions` is mandatory — every other mode either prompts the user (which a PTY-driven session cannot respond to) or restricts tool execution to a subset that breaks pi's tool surface.
- `--system-prompt` (NOT `--append-system-prompt`) is the verbatim-replace path proven by `claude --help` documentation ("System prompt to use for the session" vs `--append-system-prompt`'s "Append a system prompt to the default system prompt"); D7-final pins this.
- `--mcp-config` carries one stdio server pointing at the bridge's per-PTY `pi-claude-bridge-shim --mode mcp --socket <path>` invocation.

**Real `~/.claude/` layout (verified vs the working machine):**
- `~/.claude/sessions/<pid>.json` — PID-keyed session metadata written by user-run `claude` processes. The bridge never reads or writes here.
- `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` — append-only conversation transcript. The bridge reads ONLY when the path was delivered via a hook payload.
- `~/.claude/settings.json`, `~/.claude/skills/`, `~/.claude/plugins/`, etc. — user-global config; bridge never touches.

**Cache invariants preserved (per analyze Check 3 follow-up):** the cached driver session id is dropped on any pi-side divergence event — history-hash mismatch, cwd change, `/fork`, `/compact`, restart — identical semantics to the SDK era. The cache lives in memory only; per constitution III the bridge never writes the cache to disk and never reads `~/.claude/sessions/` for anything other than the transcript path declared by the `Stop` hook payload.

**4-point test:** multiple-approaches? yes. lasting? yes (architectural). disagreement? yes. future-constraint? yes (locks the driver shape). → **ADR candidate Y**.

### D2: PTY library = `node-pty` (microsoft)

**Choice:** Use `node-pty` v1.x for pseudoterminal management. Cross-platform (macOS + Linux for this project), industry standard, prebuilt binaries for common Node ABI versions.

**Alternatives considered**
- **`@lydell/node-pty` (fork).** Lighter install. Worth a fallback if microsoft/node-pty's build issues bite. Not the default — less battle-tested.
- **Bun runtime + built-in PTY API.** Pi runs on Node. Switching runtimes is out of scope.
- **Custom FFI to a Rust PTY crate.** Maximum flexibility, maximum maintenance. Not justified.
- **Roll-our-own forkpty bindings.** Bad idea.

**Rationale:** node-pty is what VS Code, Hyper, Theia, and every serious Node-based TUI driver uses. The maintenance signal (active issues, Dec 2025 release, regular cadence) is healthy enough.

**4-point test:** multiple-approaches? yes. lasting? yes. disagreement? no (industry default). future-constraint? medium. → **ADR candidate Y** (3 of 4).

### D3: MCP transport = stdio with a shim subprocess

**Choice:** Per PTY, the bridge spawns a stdio MCP shim subprocess. The shim speaks MCP over stdin/stdout to the `claude` child (configured via inline `--mcp-config`) and forwards each `tools/call` to the bridge's in-process router over a unix-domain socket dedicated to that shim. The router parks a Promise; pi delivers the result via the next `streamSimple()`; the router resolves; the shim sends the MCP response.

**Alternatives considered**
- **HTTP/SSE MCP server in the bridge process.** Fewer processes. Rejected: localhost port allocation races, less battle-tested transport, ambient discoverability.
- **In-process MCP via SDK helpers.** No SDK post-refactor — eliminated by D1.
- **Named pipe instead of unix socket.** Functionally equivalent on macOS/Linux; unix socket is simpler with existing Node `net` module.

**Rationale:** stdio is MCP's most-tested transport. Process boundary cleanup is automatic (shim's stdin closes when claude exits). No port allocation surface, no auth handshake, no firewall prompts.

**4-point test:** multiple-approaches? yes. lasting? yes. disagreement? yes (HTTP advocates exist). future-constraint? yes. → **ADR candidate Y**.

### D4: Streaming = transcript JSONL tail (per-block)

**Choice:** Open the transcript file delivered by `SessionStart`'s payload, tail it during the turn, parse complete JSONL lines into structured events (text-delta, tool-use, thinking-delta, usage). Emit events to pi's stream layer at per-block granularity. On `Stop`, drain remaining buffered bytes and close.

**Alternatives considered**
- **TUI output scrape (ANSI parsing).** Per-token feel. Rejected: couples to Ink internals; any TUI redesign breaks the bridge silently.
- **Wait for `Stop`, dump the whole transcript.** smithersai/claude-p's path. Rejected: pi has to execute each `tool_use` block live; waiting for `Stop` makes tool rounds impossible.

**Rationale:** transcript JSONL is a documented hook payload contract — schema changes are real-API-level events, not UI tweaks. Per-block granularity is sufficient for pi's UX (the user sees text appear in sentence-ish chunks, not per-token; acceptable trade per explore-mode discussion). Note that `--include-hook-events` and `--include-partial-messages` ONLY work with `--print --output-format=stream-json` per `claude --help` — they are not available to interactive-mode driving, so the transcript JSONL tail is the only channel for partial-message streaming.

**Drift detection (per Round-1 P2 finding):** the tailer must distinguish three line categories: known schema (emit structured event), valid JSON but unknown top-level `type` (emit warn-level log naming the type, continue), and malformed (warn, continue). The unknown-type branch is added to the `transcript-stream` spec for forward-compat with future `claude` releases.

**Line-delimited parsing (per analyze Check 3 follow-up):** the tailer parses on `\n` boundaries only; any trailing bytes after the last newline are buffered for the next read. A complete JSONL line is the unit of event emission. This preserves `transcript-stream.partial-lines-are-buffered-until-newline`.

**4-point test:** multiple-approaches? yes. lasting? yes. disagreement? yes. future-constraint? yes (downstream UX expectations). → **ADR candidate Y**.

### D5: Capture mode = forced MCP tool-call (tool-as-output)

**Choice:** On a capture-shape call, spawn a dedicated PTY rooted at `os.tmpdir()` (or caller's cwd if provided) with the shim advertising only the capture tool. All native tools are in the disallow list. The model emits a tool-use block for the capture tool; the shim validates args against the JSON schema at the MCP protocol layer (rejecting invalid args, forcing the model to self-correct in the same turn); the bridge harvests the validated args from the transcript and synthesizes an `AssistantMessage` with one `toolCall` content block.

**Alternatives considered**
- **Re-prompt-and-validate.** Inject schema into user prompt, ask for JSON, parse the final assistant text. Rejected: no protocol-level enforcement, fence-stripping fragility, retries cost a full PTY boot each.
- **Drop capture mode entirely.** Rejected by user — there are real consumers.
- **Keep SDK only for capture.** Rejected: violates the "no SDK runtime dependency" goal.

**Rationale:** mirrors what the SDK does internally (`outputFormat` is effectively "register the schema as a forced tool"). Reuses the stdio MCP infrastructure built for D3. Schema enforcement happens at the MCP protocol boundary — same guarantee class as today's SDK `outputFormat`.

**4-point test:** multiple-approaches? yes. lasting? yes. disagreement? yes. future-constraint? medium. → **ADR candidate Y**.

### D6: Drop the AskClaude tool

**Choice:** Remove `AskClaude` tool, its config block (`askClaude.*`), the `CLAUDE_BRIDGE_ASKCLAUDE_ENABLED` env switch, and the `runAskClaude` / `wireAskClaudeTool` code paths. Breaking change.

**Alternatives considered**
- **Migrate AskClaude to a per-call PTY.** Possible (clean isolation; ~ Ink boot per call). Rejected: AskClaude is behind a feature flag that defaults off, has limited known consumers, and removing it eliminates the entire "nested subagent context stack" complexity.
- **Pool warm PTYs for AskClaude.** Even more complex. Premature.

**Rationale:** the cost-of-keeping (one entire subsystem of nesting and isolation) outweighs the cost-of-removing (one breaking change in CHANGELOG).

**4-point test:** multiple-approaches? yes. lasting? yes. disagreement? maybe. future-constraint? no. → **ADR candidate borderline** (2-3 of 4); flag for archive-time skill review.

### D7-final: System prompt injection — use `--system-prompt`

**Choice (resolved by Round-1 adversarial review verification):** Use `claude --system-prompt <text>`. The flag is documented as "System prompt to use for the session" (replaces); contrast with `--append-system-prompt` ("Append a system prompt to the default system prompt"). The capture path passes `ctx.systemPrompt` verbatim; the main-provider path passes pi-combined text (`agentsAppend + appendSystem + skillsAppend` concatenated and prefixed with a minimal coding-assistant header). Constitution V is fully satisfied for the capture path; the main path retains its documented additive composition.

**Alternatives considered**
- **`--append-system-prompt`.** Documented as appending to CC's default. Unacceptable for capture path — constitution V demands verbatim.
- **Inline `--settings '{"systemPrompt": "..."}'`.** Undocumented; behavior unverified; likely interacts with `--setting-sources ""` in unspecified ways.
- **Inject system content as a first user message.** Lossy semantically. Was the fallback plan in pre-Round-1 D7; eliminated.

**Rationale:** the flag exists and documentation states the behavior we need. No fallback required.

**Phase 0 verification (T0.8):** spawn `claude --system-prompt 'TEST_SENTINEL_XYZ'` INSIDE A `node-pty` SESSION IN INTERACTIVE MODE (not `-p`), in a directory containing a fixture `CLAUDE.md` and with the user's real `~/.claude/` present, and confirm via the transcript JSONL that the model's system prompt contains the sentinel and NO `CLAUDE.md` content, NO auto-memory content. If verification fails, the most likely cause is `CLAUDE.md` auto-discovery and/or auto-memory loading running alongside `--system-prompt` — in which case D7-final escalates to ALSO setting `--bare`, with consequences re-evaluated (`--bare` disables hooks; this would invalidate D9/D12; we'd need a different transcript-discovery mechanism). If `--bare` also fails, surface a hard blocker and consider amending constitution V.

**`--exclude-dynamic-system-prompt-sections` interaction:** per `claude --help`, this flag is "ignored with `--system-prompt`" — confirming our intended behavior: setting `--system-prompt` replaces the entire default prompt, so dynamic sections (cwd/env/memory paths/git status) are NOT injected.

**4-point test:** multiple-approaches? yes. lasting? yes. disagreement? minor. future-constraint? medium. → **ADR candidate Y** (3 of 4).

### D8: Module structure

**Choice:** New layout under `src/`:

```
src/
  driver/
    pty.ts          # spawn, hooks, lifecycle, abort
    transcript.ts   # JSONL tailer + event emitter
    settings.ts     # builds the inline --settings JSON
  mcp/
    shim.ts         # separate executable, stdio MCP server
    router.ts       # in-process router (parks Promises, dispatches to pi)
    ipc.ts          # unix-socket transport between shim and router
  capture.ts        # capture-path wiring on top of driver + mcp
  index.ts          # extension entry; preserves current public surface
convert.ts          # message conversion (unchanged)
models.ts           # model registry (unchanged)
```

**Alternatives considered**
- **Keep everything in a single `index.ts`.** Today's shape. Rejected: it's already 1805 lines; the refactor is an opportunity to break it up cleanly.
- **One module per public extension entry point.** Too coarse — driver and mcp are independent concerns.

**Rationale:** mirrors the capability decomposition in proposal.md (`claude-tui-driver`, `mcp-stdio-shim`, `transcript-stream`, `output-capture`). One module per capability + a thin `index.ts` orchestrator.

**4-point test:** multiple-approaches? yes. lasting? yes. disagreement? minor. future-constraint? medium. → **ADR candidate borderline**.

### D9: Hook set (final after Round-3: SessionStart + Stop only)

**Choice:** Register exactly two hooks inline via `--settings`:

- `SessionStart` — confirms the model run has begun. Cross-checks `transcript_path` against the bridge's deterministically-computed path (per D18) if the payload happens to carry it. The prompt is delivered via positional CLI argument (D13), NOT via this hook.
- `Stop` — finalize turn, trigger the bounded post-Stop settle window (D17), capture cached session id.

**Dropped:**
- **`PreToolUse`** (Round-2 A.P2): per-tool-emission subprocess fork cost (~50–100ms each, compounding on tool-heavy turns) outweighs its observability value, which the MCP shim's `tools/call` log already provides in-process.
- **`SessionEnd`** (Round-3): redundant with PTY exit + D17 settle window.

**Alternatives considered**
- **Use the full hook set (PostToolUse, SubagentStop, UserPromptSubmit, SessionEnd, etc.).** Maximum observability. Rejected: more hook payloads to test, no additional value for our concrete needs.
- **Use the full hook set (PostToolUse, SubagentStop, UserPromptSubmit, etc.).** Maximum observability. Rejected: more hook payloads to test, no additional value for our concrete needs.

**Rationale:** four hooks cover (a) injection, (b) finalization, (c) tool-name enforcement, (d) teardown. Anything beyond is extra surface to maintain.

**4-point test:** multiple-approaches? yes. lasting? medium. disagreement? minor. future-constraint? no. → **ADR candidate N**.

### D10: Abort propagation — SIGINT with grace window

**Choice:** On pi abort: deliver `SIGINT` to the PTY's controlling process (claude). After a 3-second grace window, escalate to `SIGKILL`. Concurrently send the TUI's Esc-Esc key sequence over the pseudoterminal — whichever the binary responds to first wins.

**Alternatives considered**
- **SIGKILL immediately.** No graceful shutdown; transcript may be truncated mid-line.
- **Esc-Esc only.** Polite but depends on TUI input parsing being responsive; could hang if the TUI is in a bad state.

**Rationale:** SIGINT + Esc-Esc in parallel covers the common case; the 3s grace + SIGKILL fallback covers the pathological case.

**4-point test:** multiple-approaches? yes. lasting? medium. disagreement? minor. future-constraint? no. → **ADR candidate N**.

### D11: Defense-in-depth on disallowed tools (4 layers; PreToolUse dropped per Round-2 review)

**Choice:** Native tools are blocked at FOUR layers:
  1. Inline `--settings` permissions config declares `permissions.deny` for every native tool.
  2. `--setting-sources ""` prevents user-global `~/.claude/settings.json` `permissions.allow` from re-enabling anything (Round-1 A.P1#2). **Fallback** (per Round-2 A.P1#2): if Phase 0 T0.7 finds `--setting-sources ""` is not honored, spawn each PTY with `HOME=<per-PTY scratch dir>` containing an empty `<scratch>/.claude/settings.json`. This bulletproof variant has no flag-syntax dependency. T0.7 also tests `--setting-sources "user"` as a positive control to disambiguate "empty-string rejected" from "empty-string honored."
  3. `--strict-mcp-config` prevents user-global MCP servers from contributing tools the model could call instead (Round-1 A.P1#1).
  4. The bridge's MCP shim `tools/list` advertises only the bridged set; any out-of-set `tools/call` is rejected at the shim with an MCP "unknown tool" error. **The shim also logs every `tools/call` it observes at info level**, providing the observability that a PreToolUse hook would have provided.

**`PreToolUse` hook DROPPED across all artifacts** (Round-2 A.P2 latency finding, Round-3 propagation): the hook would fire once per tool emission and add ~50–100ms of subprocess fork/exec cost per invocation. Original justification was "defense-in-depth observability," but the four layers above already enforce the constitution-IV invariant AND the shim's `tools/call` log provides equivalent observability without per-emission process spawning. D9's hook set is correspondingly reduced (SessionStart + Stop only); proposal.md, specs/claude-tui-driver/spec.md, tasks.md, plan.md have all been reconciled to drop PreToolUse references.

**`--bare` is forbidden:** the driver MUST NOT pass `--bare`. `--bare` disables hooks (which D9/D12 rely on for transcript-path discovery) and disables `CLAUDE.md` auto-discovery + auto-memory (which would be desirable for capture-path constitution V compliance, but losing hooks is the bigger cost). Test T4.3 asserts `--bare` is in the disallowed-flags set the driver builds.

Per clarify finding I1, all four layers are kept and the linkage is documented here.

**Alternatives considered**
- **Driver-config only.** Trusts the driver to honor its config. Brittle.
- **Shim-only.** Lets the model emit native tool-use blocks that the driver might handle internally before our shim ever sees them.

**Rationale:** constitution principle IV is sacred. Two layers, both maintained.

**4-point test:** multiple-approaches? yes. lasting? yes. disagreement? minor. future-constraint? no. → **ADR candidate N** (3 of 4; borderline; defer to archive skill).

### D23: Main-provider preserves `ctx.systemPrompt` (added Round-5 per B.P1#1)

**Choice (added in Round-5 adversarial revision):** The main-provider path SHALL preserve `ctx.systemPrompt` as the base of the assembled `--system-prompt` value. Pi-derived material (skills extract, agents append, append-system from config) is concatenated AFTER `ctx.systemPrompt`, NOT in place of it. Today's `index.ts:1200-1206` is incorrect per constitution V; this change fixes it as part of the migration.

**Final assembly order (main-provider path):**
```
<ctx.systemPrompt>

<agentsAppend if present>

<appendSystem if present>

<skillsAppend if present>
```

Each block separated by a blank line. If `ctx.systemPrompt` is empty, the assembled value is just the appended blocks. If all are empty, fall through to `"You are a helpful coding assistant."`.

**Capture path:** unchanged — `ctx.systemPrompt` verbatim, no appendage.

**Verification:** unit test in T1.3 (settings builder) asserts the assembled bytes contain `ctx.systemPrompt` bytes as a prefix on the main-provider path.

**4-point test:** multiple-approaches? minor. lasting? yes (constitution V correctness). disagreement? no. future-constraint? no. → **ADR candidate N** (2 of 4); but constitution V compliance.

### D24: Warm-resume tail baseline ordering (added Round-5 per B.P1#4)

**Choice (added in Round-5 adversarial revision):** On warm-resume, the transcript tailer SHALL capture the file's size via `fs.statSync(<path>).size` IMMEDIATELY BEFORE spawning the PTY (NOT after). The tail offset begins at that captured size. This avoids the race where `claude --resume` appends new-turn lines between spawn and the tailer's first `fs.stat`.

**Ordering:**
1. Bridge computes warm-resume transcript path.
2. Bridge calls `fs.statSync(path).size` (or polls if file briefly missing); records `baselineOffset`.
3. Bridge spawns PTY with `--resume <cached-id>` + positional prompt.
4. Transcript tailer attaches its `fs.watch` and reads from `baselineOffset`.

**Integration test:** T1.19 (added) covers warm-resume with immediate assistant output; asserts no lines are dropped.

**4-point test:** multiple-approaches? minor. lasting? medium. disagreement? no. future-constraint? no. → **ADR candidate N** (1 of 4).

### D19: Shim executable path resolution (added Round-4)

**Choice (added in Round-4 adversarial revision per B.P1#1):** The bridge does NOT rely on `pi-claude-bridge-shim` being on `$PATH` in the spawned `claude`'s child environment. Instead, the bridge resolves the shim's absolute path at PTY-spawn time using `require.resolve('pi-claude-bridge/dist/mcp/shim.js')` (or `import.meta.resolve` in pure-ESM contexts) and passes the absolute path to BOTH:

1. `--mcp-config` JSON (uses array `args` — no shell quoting needed): `{ "mcpServers": { "custom-tools": { "command": "node", "args": ["<resolved-absolute-path>", "--mode", "mcp", "--socket", "<socket>"] } } }`
2. `--settings` hook commands (Round-5 A.P2): SHELL-QUOTED single-string form because the hook contract specifies `"command": "<shell string>"`. The bridge SHALL construct the string using a shell-quoting helper that wraps every path in single quotes and escapes embedded single quotes: e.g. `{ "hooks": { "SessionStart": [{ "type": "command", "command": "'node' '<absolute-path-with-possibly-spaces>' '--mode' 'hook' '--event' 'session-start' '--socket' '<socket>'" }], ... } }`. A unit test spawns a hook command with a path containing a literal space and asserts payload relay succeeds.

**Rationale:** `require.resolve` returns an absolute path regardless of installation layout. Pi's extension-launched subprocess `PATH` is not guaranteed to include the npm bin directory of pi-claude-bridge.

**Verification:** T4.4a tarball test installs the package into a fresh tmpdir and runs an end-to-end PTY spawn confirming `claude` successfully invokes the shim by the resolved path.

**4-point test:** multiple-approaches? yes. lasting? yes. disagreement? minor. future-constraint? medium. → **ADR candidate Y** (3 of 4).

### D20: Shim↔router IPC wire protocol (added Round-4)

**Choice (added in Round-4 adversarial revision per A.P2):** The shim and the bridge's in-process router speak a simple newline-delimited JSON protocol over the per-PTY unix socket:

```
// Tool call (shim → router)
{ "kind": "tool_call",  "id": "<uuid>", "name": "<name>", "arguments": { ... } }
// Tool result (router → shim)
{ "kind": "tool_result", "id": "<uuid>", "content": [...], "isError": false }
// Hook event (shim → router)
{ "kind": "hook_event", "id": "<uuid>", "event": "session-start|stop", "payload": { ... } }
// Hook response (router → shim)
{ "kind": "hook_response", "id": "<uuid>", "stdout": "<json-string-or-empty>" }
// Capture args stash (shim → router)
{ "kind": "capture_stash", "id": "<uuid>", "args": { ... } }
{ "kind": "capture_stash_ack", "id": "<uuid>" }
```

Each line is `JSON.stringify(msg) + "\n"`. Partial lines buffered. Correlation ids match responses to in-flight calls without ordering assumptions.

**4-point test:** multiple-approaches? minor. lasting? yes. disagreement? no. future-constraint? no. → **ADR candidate N** (2 of 4).

### D21: Capture-mode authoritative result source (added Round-4)

**Choice (added in Round-4 adversarial revision per B.P2#1):** The capture-mode result is authoritative from the IPC-stashed validated arguments (per D16's stash + D20's `capture_stash`). The transcript JSONL is consulted ONLY for cross-check (verify a corresponding tool-use block was written) and for `usage` / `cost` extraction. If IPC stash and transcript disagree, the bridge logs warn and trusts the IPC stash (which was validated against the schema before stashing).

**Repeated calls:** first valid call wins (IPC stash retained); second call gets MCP `-32603` from the shim and is NOT stashed.
**Invalid then valid:** validation failure (shim returns `-32602`, no stash) followed by a valid call IS allowed; the valid call becomes the authoritative result.
**Zero valid calls at Stop:** `output-capture.surface-absent-capture-tool-call-as-error` fires.

**4-point test:** multiple-approaches? yes. lasting? yes. disagreement? minor. future-constraint? medium. → **ADR candidate Y** (3 of 4).

### D22: Warm-resume transcript path (added Round-4)

**Choice (added in Round-4 adversarial revision per B.P1#3):** On warm-resume (`--resume <cached-id>`), the transcript path is computed using the SAME formula as fresh spawns: `~/.claude/projects/<encoded-cwd>/<cached-id>.jsonl`. The cached session id IS the same value that was passed as `--session-id` on the original spawn (D18). The transcript file already exists on disk; the tailer opens it and tails from the END-OF-FILE position (via `fs.stat` size at spawn time) to avoid re-emitting prior-turn events.

**Per `claude --help` flag precedence:** `--resume <id>` and `--session-id <id>` interaction is unspecified in the help text. The bridge passes ONLY `--resume <cached-id>` on warm-resume (NOT `--session-id`); transcript path is computed from the resumed id directly. Phase 0 spike T0.12 verifies empirically.

**4-point test:** multiple-approaches? minor. lasting? yes. disagreement? minor. future-constraint? medium. → **ADR candidate N** (2 of 4).

### D12: Hook IPC channel — hook subprocesses relay payloads to the long-lived bridge

**Choice (added in Round-1 adversarial revision):** `claude` interactive hooks ARE subprocesses (the `--settings` JSON declares `{ "type": "command", "command": "<shell command>" }` entries; `--include-hook-events` is `--print`-only). The bridge spawns a single multi-mode binary `pi-claude-bridge-shim` per PTY whose `argv[1]` selects its role:
- `--mode mcp --socket <path>` — stdio MCP server for the PTY's `--mcp-config`.
- `--mode hook --event <name> --socket <path>` — hook payload relay. Reads its stdin (claude writes the hook payload there), connects to the bridge over `<path>`, forwards the payload + event name, awaits a structured response, writes the response to its stdout in the JSON format `claude` expects for hook output (the exact response shape per hook event is verified in Phase 0 T0.13; for `SessionStart` and `Stop` the expected shape is an empty JSON object `{}` per the documented contract, but T0.13 confirms), and exits.

**Per-PTY socket path:** generated via `randomBytes` at PTY spawn time (`$TMPDIR/pi-claude-bridge-<random>.sock`), passed to all shim invocations as the `--socket` argument and to all hook commands as either an argument or an environment variable. Cleanup on PTY exit.

**Alternatives considered**
- **Separate executables for shim vs hook relay.** Two bin entries, two install footprints, identical IPC plumbing. Rejected for redundancy.
- **Reuse the MCP socket as the hook channel.** Possible but conflates two MCP-shaped streams (one is JSON-RPC over stdio between `claude` and shim; the other is bridge<->shim internal IPC). Keeping the bridge<->shim IPC protocol private (not MCP-flavored) is simpler and decoupled from MCP protocol drift.

**Rationale:** hooks-as-subprocesses is the only payload-delivery mechanism for interactive mode. A single multi-mode binary minimizes packaging surface and ensures consistent IPC implementation between MCP-side and hook-side handlers.

**4-point test:** multiple-approaches? yes. lasting? yes. disagreement? minor. future-constraint? yes. → **ADR candidate Y** (3 of 4).

### D13: Prompt injection — CLI positional argument for v1

**Choice (added in Round-1 adversarial revision):** Pi user prompts are delivered to `claude` via the documented `[prompt]` positional CLI argument on every spawn (both cold-start and warm-resume). This works for text content. Image content is NOT supported in v1 (`claude` interactive mode has no documented programmatic mechanism to inline images alongside a text prompt; `--file` is for file uploads with their own IDs and predates image multimodality on the interactive path).

**Behavior contract:**
- Cold-start (no cached session id): full pi history is flattened via the existing `buildColdStartPrompt(context.messages)` conversion (text-only; image blocks dropped with a warn log). This matches today's bridge behavior — the SDK era also serializes cold-start history to a single string via the same helper. NOT a regression.
- Warm-resume (cached session id valid): the positional arg is the new user message only; prior history lives in the resumed transcript on disk that `claude --resume` reads.
- Image-bearing main-provider turn (cold or warm): the bridge logs a warn-level entry, strips the image blocks from the positional arg, and proceeds with text-only content. Documented as a v1 limitation; pi callers receive `usage` and `cost` as normal.
- Image-bearing capture call: rejected pre-spawn with `stopReason: "error"` and `errorMessage` naming the v1 limitation (constitution VII).

**Alternatives considered**
- **Type the prompt into the PTY stdin after `SessionStart`.** Fragile (bracketed-paste-mode escaping, multi-line edge cases, TUI re-renders). Rejected in favor of the CLI positional path which `claude` is documented to accept.
- **Use the `SessionStart` hook's `hookSpecificOutput.additionalContext` to inject the prompt.** Wrong semantic surface (it's the system context, not a user message); violates constitution V on the capture path.

**Rationale:** CLI positional is the documented, image-or-no-image-equivalent surface that pi callers have always passed prompts through (via `buildColdStartPrompt`). Image support is genuinely missing from interactive `claude` today, so v1 mirrors that limitation rather than papering over it.

**4-point test:** multiple-approaches? yes. lasting? yes (defines the input shape). disagreement? minor. future-constraint? yes. → **ADR candidate Y** (3 of 4).

### D14: Packaging — build to `dist/` for publishable artifacts

**Choice (added in Round-1 adversarial revision):** Adopt a build step. New `tsconfig.build.json` produces JS in `dist/`; `npm run build` runs it; `package.json` `files` whitelist is expanded to include `dist/**`, `package.json` `bin` entry points at `dist/mcp/shim.js`, and the `main`/`exports` paths update to the built artifacts. The published tarball will not depend on `tsx` at runtime.

**Alternatives considered**
- **Ship `src/**` as TypeScript and require `tsx` at runtime.** Today's pattern for `index.ts` works because pi loads it through its own TypeScript-aware loader; that path does not extend to a `bin` executable invoked by `claude`'s `--mcp-config`. Rejected for the bin entry.
- **Bundle with esbuild / rollup.** Smaller, but introduces a bundler dependency and obscures the source→artifact mapping. `tsc` is sufficient.
- **Publish two packages (`pi-claude-bridge` extension + `pi-claude-bridge-shim` binary).** Cleaner conceptually but doubles release coordination. Rejected for v1.

**Rationale:** without a build step the `bin` entry doesn't work on user machines (the shim is a `.ts` file `node` cannot execute). Adopt the standard TypeScript-library publish pattern.

**4-point test:** multiple-approaches? yes. lasting? yes. disagreement? minor. future-constraint? yes. → **ADR candidate Y** (3 of 4).

### D15: Abort lifecycle — PTY torn down, router-state preserved for late tool-result reconciliation

**Choice (Round-1, refined in Round-2 by B.P1#3 on late-tool-result coherence):** Claude's documented hook contract does not guarantee `Stop` fires when the model run is interrupted by the user. The bridge's abort path therefore proceeds as:

**PTY side (clean up the inference driver):**
1. Pi signals abort via `AbortSignal`.
2. Driver sends `SIGINT` to the PTY's controlling process (+ Esc-Esc keystrokes in parallel; whichever the binary honors first wins).
3. Driver enters a 3-second grace window awaiting graceful termination; on expiry, escalate to `SIGKILL`.
4. The transcript tailer transitions to `aborted` mode immediately on step 1: it drains any already-buffered complete JSONL lines, emits a final `done` event with `reason: "aborted"`, closes the file handle, and stops watching.
5. A post-abort PTY exit — regardless of exit code — is classified as the EXPECTED termination path. Not an error.
6. Any `Stop` payload received post-abort is logged at info level and otherwise ignored.

**Bridge/router side (preserve late-tool-result coherence, per Round-2 B.P1#3):**
The current bridge (index.ts:1008-1016, 1260-1336) deliberately keeps aborted frames' router state alive so a real pi `tool_result` arriving AFTER the abort can still be captured for next-turn resume context. This is critical for conversation coherence: if pi's executor finishes a tool round 200ms after the user aborts, the resulting tool_result IS canonical history pi expects to be present on the next turn. The PTY-driven design preserves this:

- The PTY and shim subprocess BOTH terminate per the PTY-side steps above.
- The router's per-frame state (the `pendingResolvers` + `pendingResults` maps the in-process MCP shim populated during the turn) stays alive until ONE of: (a) pi delivers a `toolResult` via the next `streamSimple()` call (router stashes it in the frame's `pendingResults` and emits a structured-log entry; the result is included in the cold-start replay material for the next turn), (b) pi sends a new user message (router drains synthetically and pops the frame; same path as today's index.ts wasAborted handling), (c) a `clearSession` event drains (today's contract).
- The new spec AC `claude-tui-driver.abort-preserves-late-tool-result-coherence` captures this.

**Alternatives considered**
- **Drop late-tool-result handling.** Was the Round-1 D15 choice. Round-2 B.P1#3 surfaces this as a regression vs current behavior; rejected.
- **Wait for `Stop` always, treat the absence as an error.** Wrong; user aborts are a normal path.
- **Rely on PTY exit detection only, no SIGINT.** Fails if the TUI hangs waiting for input.

**Rationale:** decouples abort completion from `Stop` firing AND preserves the current bridge's late-tool-result coherence semantics. The PTY/shim ARE torn down (the inference run is over); the router-side bookkeeping survives until pi resolves the ambiguity.

**4-point test:** multiple-approaches? yes. lasting? yes. disagreement? yes. future-constraint? yes. → **ADR candidate Y** (4 of 4).

### D17: Bounded post-`Stop` transcript settle window (per Round-2 B.P1#4)

**Choice:** When the `Stop` hook fires, the transcript tailer does NOT close the file immediately. Instead it enters a bounded settle window (default 250ms, env-overridable via `CLAUDE_BRIDGE_TRANSCRIPT_SETTLE_MS`) during which it continues to read newly-appended lines. The window closes when either (a) the configured timeout elapses, OR (b) the tailer observes a terminal `result` JSONL entry. This protects against the documented race where the hook fires before the last transcript write hits disk.

**Alternatives considered**
- **Close on Stop, parse what's buffered.** Today's design intent. Round-2 B.P1#4 demonstrates this race produces intermittent truncated final output, missing usage, and false capture-mode "model did not call tool" errors.
- **Unbounded settle until terminal `result` observed.** Fails if `result` never arrives (malformed stream); deadlocks the turn.
- **Re-open and re-read post-Stop on detected truncation.** More complex without buying anything over a bounded settle.

**Rationale:** small bounded settle window covers the common case; explicit timeout prevents pathological hang.

**4-point test:** multiple-approaches? yes. lasting? medium. disagreement? minor. future-constraint? no. → **ADR candidate N**.

### D16: Capture-mode MCP completion semantics — deterministic shim response, harvest on Stop

**Choice (added in Round-1 adversarial revision):** On the capture path, the shim's `tools/call` handler for the capture tool:

1. Validates the call's `arguments` against the capture tool's JSON schema. On failure, returns an MCP error `-32602 Invalid params` with a message naming the failing field path. The model receives the error and self-corrects within the same turn.
2. On success, stashes the validated arguments in an in-memory "capture result" field on the IPC channel's per-PTY router state, and returns a deterministic MCP response: `{ "content": [{ "type": "text", "text": "Capture received. End your turn now." }] }`. This is a normal, valid MCP tool response — not a hang, not a special-case. The model is then free to emit `end_turn`.
3. The bridge does NOT park a Promise on this call (unlike pi-tool calls). The router has a `mode: "capture" | "main"` flag set at PTY spawn time; capture-mode tool calls are answered locally by the shim without any round-trip to the bridge's main router. The shim stashes the args and the bridge harvests them via the captured-args field after `Stop` (or after the abort lifecycle in D15).
4. If the model emits multiple tool-use blocks for the capture tool in the same turn: the FIRST valid call stashes the args and returns success; subsequent calls return an MCP `-32603 Internal error` with a message "capture tool already received result; end your turn." The first-stashed args are the final result.
5. If the model emits zero tool-use blocks for the capture tool by `Stop`: the bridge resolves per `output-capture.surface-absent-capture-tool-call-as-error`.

**Alternatives considered**
- **Native `claude --json-schema <schema>` flag (Round-2 A.P3#1 alternative).** `claude --help` documents this flag for structured output. Phase 0 T0.10 verifies whether it works in interactive mode (the documented examples are all `-p`). If interactive-mode-available, an alternative capture path could be: set `--json-schema <captureTool.parameters>` per spawn, harvest the validated terminal result from the transcript. Rejected as primary because (a) reuses the SDK trust-surface concern the user wanted to escape; (b) the forced-MCP-tool-call pattern integrates with the rest of the shim architecture without a special case. May be revisited in a future change.
- **Have the shim park a Promise as if it were a normal pi tool.** Would hang — there's no pi to deliver a tool_result. Rejected outright.
- **Have the model see no MCP response (timeout-driven completion).** Would also hang or be model-dependent. Rejected.
- **Return an MCP error on every capture-tool call so the model treats it as a non-call.** Model would retry or give up; semantics unclear; rejected.

**Rationale:** addresses Round-1 B.P1#3. The capture path needs its own MCP completion semantics distinct from the main-provider Promise-parking contract; the deterministic-success response is the simplest model-friendly way to terminate the capture round.

**4-point test:** multiple-approaches? yes. lasting? yes. disagreement? yes. future-constraint? yes. → **ADR candidate Y** (4 of 4).

## Risks / Trade-offs

| # | Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|---|
| R1 | Anthropic ships a `claude` TUI release that changes the `SessionStart` or `Stop` hook payload shape, or the transcript JSONL schema | Medium | High | Hook payloads are a documented contract; parse with explicit field guards; surface unknown shapes as errors per constitution VII; pin a tested `claude` version range in README. |
| R2 | TUI boot latency (1–3s per `claude` spawn) hits capture-mode UX when callers issue many capture calls | Medium | Medium | Document the boot cost in README; defer warm-PTY-pool optimization to a future change. |
| R3 | `node-pty` native-binding install pain on user machines without prebuilds | Low | Medium | Document Python + C++ toolchain requirement as a fallback in README; pin a node-pty version with prebuilds for current LTS Node releases. |
| R4 | `fs.watch` on macOS misses transcript writes; tailing falls behind | Medium (deferred A7) | Medium | Phase 0 spike measures fs.watch reliability; fall back to polling on macOS if needed. |
| R5 | AskClaude removal breaks downstream consumers who flipped the feature flag | Low | Low | CHANGELOG breaking entry; README removes the AskClaude section; consumers migrate to invoking `claude` directly. |
| R6 | Streaming UX regression (per-block vs per-token) noticed by users | Medium | Low | Per-block chunks arrive in sentence-ish bursts; document the change in README. |
| R7 | Bridge crashes mid-turn; PTY and shim orphan | Low | Medium | shim exits when IPC closes (D3); PTY exits on shim death because pi's parent process is the controlling terminal; document the cleanup chain. |
| R8 | CC TUI's mid-turn session-id changes (deferred C6) regress cache logic | Medium | Low | Phase 0 spike confirms behavior; cache logic already tolerates session-id rotation via clearSession on divergence. |
| R9 | `claude` binary not on `$PATH` at pi runtime | Low | High | Driver surfaces missing-binary as `stopReason: "error"` per claude-tui-driver.unexpected-driver-exit-surfaces-as-error; README documents the prerequisite. |
| R10 | MCP shim's unix-socket path collides under concurrent capture calls | Low | Medium | Generate unique socket path per shim using `randomBytes`; document in design and test the concurrency case (clarify C9). |
| R11 | `node-pty` alone insufficient for `claude` interactive boot — missing terminal-query responses (DEC primary/secondary device attributes, XTVERSION, DSR, window-size) hang Ink startup | Medium (per smithersai/claude-p evidence) | High | Phase 0 spike T0.7 measures this against current `claude` build. If hangs occur, the driver embeds a minimal ANSI responder feeding canned replies to the PTY before forwarding to the transcript stream. |
| R12 | Hooks are subprocesses; per-event fork/exec latency on per-turn hooks | Low | Low | Post-Round-3 the bridge registers only TWO per-session hooks (`SessionStart`, `Stop`) — two subprocess invocations per turn, ~50–100ms each cold-start of a Node script. The high-frequency `PreToolUse` hook was dropped (per D11); `SessionEnd` was also dropped as redundant with PTY-exit + D17. Phase 4 benchmark T4.7 measures actual cold-start cost. |
| R15 | Cold-start positional argument exceeds OS argv size limit (~256 KB macOS, ~2 MB Linux) on long-history turns (Round-2 B.P1#2) | Low (most turns) / Medium (after long sessions + restart) | High | **Round-5 A.P1#2 insight**: `claude --help` shows `--system-prompt[-file]` and `--append-system-prompt[-file]`, implying `--system-prompt-file <path>` and `--append-system-prompt-file <path>` exist. These read prompt content FROM A FILE, escaping argv entirely. Phase 0 T0.11 verifies the flags exist + work in interactive mode. If verified: on argv-overflow, the bridge writes cold-start history to a per-PTY temp file in `os.tmpdir()` (permissible per constitution III — not under `~/.claude/`) and passes `--system-prompt-file <tempfile>` instead of `--system-prompt <inline>`. The positional argument carries only the new user message. File is cleaned up on PTY exit. If `--system-prompt-file` does not exist or is `--print`-only, fall back to surfacing `stopReason: "error"` (v1 hard limit; CHANGELOG documents). |
| R16 | Model-asks-itself "what tools do you have?" as a verification mechanism is non-deterministic (Round-2 A.P2#3) | High | Medium | Integration tests T1.15/T1.16 use deterministic MCP `tools/list` introspection (against the shim's advertised set) instead of model self-report. Spike T0.7 uses the same deterministic introspection. |
| R17 | Model ignores capture-mode's "end your turn now" English instruction (Round-2 A.P3#3) | Low (modern instruction-following models) | Low (D16's repeated-call -32603 limits damage) | Phase 4 benchmark T4.8 measures capture-mode termination latency distribution across N runs; if median diverges materially from "end_turn after first call", evaluate setting `max_tokens` via inline `--settings` for capture turns. |
| R13 | Interactive `claude` does not honor `--no-session-persistence` (flag is `--print`-only); every bridge-spawned PTY accumulates a transcript file on disk | High | Low | Documented in proposal Impact. The bridge does not clean these files (constitution III); they accumulate at the same rate the user's own `claude` usage produces them. Mitigation deferred unless disk usage becomes a complaint. |
| R14 | Post-Phase-3 rollback requires re-publishing a prior npm version AND in-repo rollback spans 5+ commits (steps 13.1, 13.3, 14.1, 14.2, 14.3, 14.5) | Low | Medium | CHANGELOG documents post-Phase-3 rollback as "`npm install pi-claude-bridge@<previous>`" for downstream consumers; for in-repo rollback the cut-over commits are tagged contiguously so a `git revert <Phase-3-range>` runs as one operation; T4.6a adds a rollback-rehearsal step in Phase 4 (`git revert <range>; npm test`) before publishing. Recommend Phase 3 cut-over as `1.0.0` major bump to make the upgrade decision explicit. |

## Migration Plan

**Phase 0 — Spikes (1–2 days)**

- Verify `--system-prompt` vs `--append-system-prompt` vs `--settings` for system-prompt override in interactive mode (clarify A1's deferred companion + D7).
- Verify CC TUI emits thinking blocks in JSONL (clarify A8).
- Verify `Stop` hook payload includes a usable `transcript_path` after a tool-only turn (relevant to capture-mode D5).
- Verify `usage` shape in transcript JSONL (cache tokens present).
- Measure `fs.watch` reliability on macOS for the transcript file's typical write cadence (clarify A7).
- Verify CC TUI mid-turn session-id behavior (clarify C6).

Spike results pinned as D7-final + design.md addenda.

**Phase 1 — Driver swap behind feature flag (1 week)**

- New modules: `src/driver/{pty,transcript,settings}.ts`, `src/mcp/{shim,router,ipc}.ts`, `src/capture.ts`.
- `index.ts` gains a single feature-flag check: `CLAUDE_BRIDGE_DRIVER=pty` switches the main-provider path to the new driver. Default remains SDK during Phase 1.
- Build the stdio MCP shim as a separate npm-published binary entry point.
- Port main-provider streamSimple onto the new driver. Tool execution contract (park Promise, resolve on pi's next call) preserved verbatim.

**Phase 2 — Capture path port + AskClaude removal (3–4 days)**

- Reimplement capture mode on the PTY driver per D5.
- Delete AskClaude code + config + env switch.
- Update tests: rewrite int-* integration tests against the PTY driver; unit tests survive structurally.

**Phase 3 — Cut over (1 day)**

- Default `CLAUDE_BRIDGE_DRIVER=pty`.
- Remove SDK path code, `@anthropic-ai/claude-agent-sdk` and `@anthropic-ai/sdk` from `package.json`.
- README + CHANGELOG updates.

**Phase 4 — Hardening (3–5 days)**

- Resolve any R1–R10 mitigations that require code (e.g. fs.watch fallback).
- Integration test suite green on macOS + Linux.

**Rollback procedure**

- During Phases 1–2: `CLAUDE_BRIDGE_DRIVER=sdk` (default) restores prior behavior.
- After Phase 3 cut-over: rollback = revert the commits that remove the SDK path; the feature flag plumbing is the rollback seam.

**Compat envelope**

- `piAi.complete()` external call-shape preserved; observable streaming granularity, cold-start prompt formatting, and image-content support change as documented below.
- `AssistantMessage` result shape preserved across all `stopReason` values.
- `AskClaude` tool removed — documented breaking change.
- Per-token streaming → per-block streaming — documented as a minor breaking change.
- Image-bearing main-provider turns: image blocks are stripped with a warn log; turn proceeds text-only. Documented as a v1 limitation; future change may add inline image support if interactive `claude` adds a programmatic image-injection mechanism.
- Image-bearing capture-mode calls: rejected with `stopReason: "error"` (was supported text-only previously; documented in CHANGELOG).
- Config key `askClaude.*` removed; no other config keys removed.

## Open Questions

- **OQ1 (D7):** ~~Which mechanism replaces (not appends to) CC's default system prompt in interactive mode?~~ **RESOLVED in Round-1 adversarial review**: `--system-prompt` per `claude --help` ("System prompt to use for the session"). Phase 0 T0.8 verifies in INTERACTIVE mode (not -p) with a fixture `CLAUDE.md` present.
- **OQ7 (Round-2 B.P1#1, REVISED in Round 3):** ~~Does `SessionStart` payload include `transcript_path` in interactive mode?~~ **OBSOLETE per D18** — the bridge no longer depends on hook-delivered `transcript_path`. The driver pre-generates a UUID, passes `--session-id <uuid>`, and computes the transcript path deterministically as `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` (encoding: cwd with `/` replaced by `-`, verified from `~/.claude/projects/` directory listing). Phase 0 T0.12 narrows to: (a) confirm `--session-id` honors the supplied UUID and writes the transcript to the expected path, (b) confirm the encoding format on macOS + Linux paths. The hook-delivered `transcript_path` (if `SessionStart` carries it) becomes a cross-check, not the discovery mechanism.
- **OQ8 (Round-2 B.P1#2):** What's the realistic max cold-start prompt size across pi sessions? T0.11 measures.
- **OQ9 (Round-2 A.P3#1):** Is `--json-schema` available in interactive mode or only `-p`? T0.10 verifies; informs whether D5 alternative #1 is real.
- **OQ2 (A7):** Does macOS `fs.watch` reliably detect transcript writes for our cadence? Owned by Phase 0 spike. Deadline: before Phase 1 starts.
- **OQ3 (A8):** Does CC TUI emit thinking blocks in JSONL? If no, the `transcript-stream.emit-text-delta-tool-use-thinking-and-usage-events` AC is amended in a follow-up change. Owned by Phase 0 spike.
- **OQ4 (C6):** Does CC TUI emit mid-turn session_id changes? If yes, cache logic needs an explicit handler. Owned by Phase 0 spike.
- **OQ5 (I4):** Defining behavior for pi mid-turn cwd change — currently undefined. Recorded as outstanding risk; defer until pi adds the capability.
- **OQ6:** Concrete abort grace window in D10 — currently 3s. Tune if Phase 0/1 evidence suggests otherwise.
