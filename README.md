# pi-claude-bridge

[![npm version](https://img.shields.io/npm/v/pi-claude-bridge)](https://www.npmjs.com/package/pi-claude-bridge)

Pi extension that uses Claude Code as a model provider. Pi's Opus/Sonnet/Haiku
models run through the real `claude` CLI — interactively or in direct print
mode — while tool calls flow through pi's TUI and conversation history stays
owned by pi.

> Built on [claude-agent-sdk-pi](https://github.com/prateekmedia/claude-agent-sdk-pi) by Prateek Sunal — the provider skeleton, tool name mapping, and settings loading originate from that project. This fork adds streaming, MCP tool bridging, custom pi tool bridging, session resume/persistence, context sync, thinking support, and skills forwarding.

**Provider** — Use Opus/Sonnet/Haiku as models in pi, with all tool calls flowing through pi's TUI.

### Driver

Inference supports two subprocess drivers selected by `CLAUDE_BRIDGE_DRIVER`:

- **`claude-print` (default)** spawns the installed `claude` binary directly
  with `-p --input-format stream-json --output-format stream-json`. The bridge
  waits for its invocation-owned MCP readiness sentinel before writing the user
  frame to stdin. One direct process owns one complete pi user turn. This path
  requires Claude Code 2.1.208 or newer.
- **`claude-p`** drives the interactive Claude Code TUI through the maintained
  [`claude-p`](https://www.npmjs.com/package/claude-p) fork. One `claude-p`
  spawn likewise spans one pi user turn, including all held tool rounds.

Both drivers use the same stdio **MCP shim** and in-process router. The router
holds each `tools/call` open ("parks" it), ends pi's stream so pi executes the
tool, then resolves the parked call when pi supplies the result. Both paths
support multi-round tools, capture, abort, typed resume hints, cache accounting,
and process-group cleanup. The bridge never reads or writes
`~/.claude/sessions/`; there is no transcript surgery.

Direct `claude-print` mode is the default. To use the interactive rollback path,
launch pi with `CLAUDE_BRIDGE_DRIVER=claude-p`; remove that setting to return to
`claude-print`. Driver selection is process-wide and fixed when the extension
loads. The removed `sdk` value and all unknown values fail fast.

Uses your Claude Max/Pro subscription. I believe this is compliant with Anthropic's terms because only the real Claude Code is touching the API and it's to enable [local development](https://x.com/trq212/status/2024212380142752025) not to steal API calls for some other commerical purpose. That said, obviously this extension is not endorsed or supported by Anthropic.
<p>
<a href="claude-bridge1.png"><img src="claude-bridge1.png" width="49%"></a>&nbsp;
<a href="claude-bridge2.png"><img src="claude-bridge2.png" width="49%"></a>
</p>

## Install

```
pi install npm:pi-claude-bridge
```

## Provider

Use `/model` to select `claude-bridge/claude-opus-4-8`, `claude-bridge/claude-opus-4-7`, `claude-bridge/claude-opus-4-6`, `claude-bridge/claude-sonnet-4-6`, or `claude-bridge/claude-haiku-4-5`.

Behind the scenes, pi's tools are bridged to Claude Code (via the MCP shim) but it should all work like normal in pi. Bash commands get a 120-second default timeout (matching Claude Code's default) since pi's bash has no timeout by default. Skills in pi are copied over to Claude Code's system prompt so should work as they would with any other pi provider.

Image content on the main provider path is text-only: image blocks in the
prompt are dropped (with a warning in the debug log) and the turn proceeds with
the text. Multi-turn history that diverges (`/fork`, `/compact`, `/tree`) drops
the cached claude session id and cold-starts the next turn with pi's history
replayed as text context.

## Structured output / output-capture tools

Pass `ctx.tools = [captureTool]` with a tool whose name doesn't collide with any currently active pi tool, and the bridge routes the call through an isolated capture path. The model is required to return structured output matching the tool's JSON schema; the bridge surfaces it as a normal `AssistantMessage` with a `toolCall` content block — the same shape direct pi-ai providers return.

The capture path runs in full isolation from the user-session state machine — no shared stack, no session cache writes, no interference with a concurrent interactive turn.

### Usage

```ts
import * as piAi from "@mariozechner/pi-ai";

const captureTool: piAi.Tool = {
  name: "extract_summary",
  // description is NOT forwarded — put instructions in systemPrompt or the user message
  description: "Extract a structured summary.",
  parameters: {
    type: "object",
    properties: {
      title:    { type: "string", maxLength: 80 },
      keywords: { type: "array", items: { type: "string" }, maxItems: 5 },
    },
    required: ["title", "keywords"],
  },
};

const msg = await piAi.complete(
  { provider: "claude-bridge", id: "claude-haiku-4-5" },
  {
    systemPrompt: "Extract a title and up to 5 keywords from the text.",
    messages: [{ role: "user", content: "The quick brown fox jumps over the lazy dog." }],
    tools: [captureTool],
  }
);
// msg.stopReason === "toolUse"
// msg.content[0] → { type: "toolCall", id: "toolu_...", name: "extract_summary", arguments: { title: "...", keywords: [...] } }
// msg.usage.cost.total >= 0
```

`usage` and `cost` are propagated from the selected driver's terminal result, including cache-token accounting. If the model never calls the capture tool (or the spawn exits abnormally) the message has `stopReason: "error"` and an `errorMessage` naming the cause — and no spawn is started (no tokens billed) for call-shape errors.

Under the hood the capture path advertises the capture tool as the **single** MCP tool on a forced-toolcall spawn (the model must call it exactly once); the shim validates the model's arguments against the tool schema and stashes them, and the bridge synthesizes the `toolCall` content block. It runs one selected-driver spawn (no resilience/respawn wrapper — a respawn could re-run the model's turn) and is fully isolated from main-session state.

Two path-specific behaviors worth noting: `ctx.systemPrompt` is forwarded verbatim on the capture path (unlike the main-turn path, which replaces it with a hardcoded value). `cwd` defaults to `os.tmpdir()` — the capture path has no working-tree dependency.

### v1 limitations

- **One capture tool per call, mutually exclusive with executable tools.** Mixing capture and executable tools, or passing more than one capture tool, is rejected immediately with `stopReason: "error"`.
- **Object-root schema only.** The capture tool's `parameters` must have `type: "object"` at the root (TypeBox `Type.Object(...)` or equivalent JSON Schema). Non-object roots are rejected.
- **`tool.description` is dropped.** Only the tool name and JSON schema are advertised to the model; the description never reaches it. Put capture instructions in `ctx.systemPrompt` or the user message.
- **Name collision with active pi tools.** A capture tool whose name matches an active pi tool is routed through MCP execution instead of the capture path — pick names that don't collide with registered pi tools.
- **Multi-message context is text-only and lossy.** History in `ctx.messages` is serialized as plain text: image blocks are dropped, tool-call arguments are truncated to 200 chars, tool-result content to 500 chars. For image-bearing prompts or full-fidelity tool history, pass only the immediate prompt in `ctx.messages` and embed any needed prior context inline as text.

## Configuration

Driver selection precedence is `CLAUDE_BRIDGE_DRIVER`, project
`<project>/.pi/claude-bridge.json`, global `~/.pi/agent/claude-bridge.json`, then
`claude-print` by default. Config files use `{ "driver": "claude-print" }` or
`{ "driver": "claude-p" }`. Selection applies uniformly to main turns and
isolated capture calls. Invalid values fail while the extension loads; there is
no silent fallback. Selecting `claude-print` requires Claude Code 2.1.208 or
newer; explicitly selected `claude-p` retains its independent version support.

Direct mode also accepts `CLAUDE_BRIDGE_MCP_READY_TIMEOUT_MS`, a positive
integer startup-readiness deadline in milliseconds (default `30000`). This is a
startup gate only, not an inference idle timeout. Both drivers set Claude Code's
MCP tool idle timeout to unlimited so long pi tools remain valid until caller
abort or process exit.

Debug logging is controlled by environment variables — see **Debugging** below.

## Peek: `/claude-peek`

With `claude-p`, `/claude-peek` toggles a live, **read-only** picture-in-picture
view of the underlying Claude Code TUI inside the pi terminal (top-right
overlay). It
never captures keyboard focus — keep typing and submitting in pi while it's
open — and it can never affect the turn: the peek path is a pure observer
(any peek failure shows an explicit ERROR header in the overlay and is logged;
the inference turn proceeds untouched).

How it works: main-provider spawns pass `--mirror-file` to the patched
`claude-p`, which tees raw PTY output bytes (write-only) to a per-spawn file
under `<tmpdir>/claude-bridge-peek/` (override with `CLAUDE_BRIDGE_PEEK_DIR`;
the newest 5 files are kept). The extension tails the current file into a
headless 120×40 terminal emulator and renders the grid in the overlay,
coalesced to ≤20 updates/s. Between turns the overlay shows an explicit idle
state. Capture-path and subagent spawns are not mirrored. Rows are cropped
when the overlay is narrower than the 120-column session (the session itself
is never resized).

`claude-print` has no interactive PTY, so `/claude-peek` reports that no
interactive tail is available and opens no overlay. This is the only intentional
driver-parity exception; inference remains usable after the command.

## Tests

- `npm run test:unit` — offline unit suite for both adapters, parsers, routing,
  resume policy, diagnostics, capture, and peek behavior.
- `npm test` — full repository suite using the default `claude-print` driver.
- `npm run test:integration:drivers` — authenticated contract against both
  `claude-p` and `claude-print`: readiness-gated main/resume turns, sequential
  and parallel held tools, D32 tool-id correlation, capture, abort cleanup,
  durable and in-process resume, parallel/nested overlap, concurrency, cache,
  native-tool isolation, large direct input, and lifecycle coherence. Requires
  working Claude Code authentication and runs real subprocesses.
- `npm run test:scenarios` — explicit S0–S27 plus S31/S32 inventory for the
  selected/default driver.
- `npm run test:scenarios:drivers` — same binding inventory against both drivers.
  Scenario exit `77` is reported as an environment skip, never as a pass, and
  makes required suite nonzero (`SCENARIO_ALLOW_SKIPS=1` is local-only escape).

Authenticated tests run at controlled concurrency and do **not** override
`CLAUDE_CONFIG_DIR` or `HOME`.

## Debugging

Set `CLAUDE_BRIDGE_DEBUG=1` to enable debug output:

- **Bridge log** at `~/.pi/agent/claude-bridge.log` — provider calls,
  driver-tagged resume/divergence decisions, tool park/delivery, usage, and
  abnormal lifecycle state. Stable diagnostic events are
  `driver.lifecycle.stderrFile`, `driver.lifecycle.stderrFileFailed`, and
  `driver.lifecycle.stateDump`; each record includes `driver: "claude-p"` or
  `driver: "claude-print"`. JSON-per-line; size-rotated (10 MB × 2 backups).
  Override with `CLAUDE_BRIDGE_DEBUG_PATH` and
  `CLAUDE_BRIDGE_DEBUG_MAX_BYTES`; disable with `CLAUDE_BRIDGE_DEBUG=0`.
- **Per-spawn diagnostics** beside the bridge log use driver-identifying names:
  `driver-<driver>-stderr-<sid>-<process-id>-<ts>.log` and
  `driver-<driver>-debug-<sid>-<spawn-id>-<ts>.log`. Stderr artifacts use the
  child PID; direct debug artifacts are named before spawn and use a UUID.
  Premature-exit state dumps include
  exit/signal, parser state, elapsed time, held-round state, and stderr tail.
  Disable Claude's debug file with `CLAUDE_BRIDGE_CLAUDE_DEBUG_FILE=0`.
  Diagnostics are never written under `~/.claude/`.

**No inference idle timeout.** `claude-p` runs without `--timeout`, direct mode
sets Claude's MCP tool idle timeout to unlimited, and bridge has no idle
watchdog. Recovery comes from real subprocess exit or caller abort (SIGINT,
then grace/SIGKILL cleanup). `CLAUDE_BRIDGE_MCP_READY_TIMEOUT_MS` only bounds
direct startup before prompt submission. Removed watchdog/claude-p timeout knobs
remain unsupported; unattended ceilings belong to supervisor.

When filing a bug about a session-resume failure, the most useful attachment is
the bridge log spanning the failing turn (the divergence / caching log lines plus
the surrounding tool-park/delivery records).

## Maintenance

### Forked `claude-p` (echo-confirm input patch)

The `claude-p` dependency points at a **maintained fork**,
[`cartwmic/claude-p`](https://github.com/cartwmic/claude-p), not the upstream npm
release. The fork carries one custom patch: `src/driver.zig` **confirms the typed
prompt echoed into Ink's input box before pressing Enter** (clear-line + retype on
a miss, bounded, then fail fast with `RunError.PromptNotAccepted`). This fixes the
intermittent `StopTimeout` "hang" — under concurrent-boot CPU contention the stock
binary typed the prompt before Ink's input was ready, dropped the keystrokes, and
wedged until `--timeout` (see `.spike-notes/claude-p-gate/stoptimeout-rootcause-PROVEN.md`).
Validated: the load that wedged stock 2/60 → patched **0/60**
(`.spike-notes/claude-p-gate/gecho-result.md`).

- **Build-on-install.** `package.json` pins `github:cartwmic/claude-p#<sha>`. The
  fork's `prepare` script runs `zig build`, so **Zig 0.15.2 must be on `PATH` at
  install time** (e.g. `mise exec zig@0.15.2 -- npm install`). The fork's
  `bin/claude-p.js` prefers the freshly-built `zig-out/bin/claude-p`.
- **Identity check.** On first spawn the bridge reads the fork's
  `package.json` `claudePPatch` marker (`echo-confirm-input`) and emits a `warn`
  (event `claudeP.patch.missing`) if it resolved a **stock** upstream `claude-p`
  (the fix would be inactive). Constant: `EXPECTED_CLAUDE_P_PATCH` in
  `src/driver/claudeP.ts`.
- **Syncing upstream** (`sync-custom-forks`): in `~/git/claude-p`,
  `git fetch upstream && git merge upstream/main`, re-build, then **re-run gate
  G-echo** (`node .spike-notes/claude-p-gate/stoptimeout-proof.mjs --concurrency 10
  --waves 6 --timeout 60 --load 16` → expect 0 failures) before bumping the bridge's
  pinned `#<sha>`. The patch is confined to the prompt-commit step to keep the merge
  surface small.
- **Follow-ups** (not yet done): a multi-platform CI/release pipeline for the fork
  binary (so consumers without Zig can install a prebuilt).
  (Bridge-side liveness timers — the former idle-watchdog and `--timeout` — were
  intentionally **removed**; recovery is caller-driven abort plus visibility.)

### Tested version range

Both subprocess drivers — flag sets, shared native disallow-list closure, and
stdout stream-event parsing — are validated against:

| Component             | Tested version |
|-----------------------|----------------|
| `claude` (CLI)        | **2.1.159**    |
| `claude-p`            | **0.1.0**      |
| `claude-print` adapter| repository build |

On the first spawn of each process, the bridge reads both versions and emits a
single structured `warn` (event `claudeP.version.skew`) if either differs from the
pinned values above. This is a **warning, not a failure** — a version drift never
blocks a turn. It is the signal to re-audit the disallow-list (below) against the
new `claude` build. (The pinned constants live in `TESTED_CLAUDE_VERSION` /
`TESTED_CLAUDE_P_VERSION` in `src/driver/claudeP.ts`; update them and this table in
lock-step when you re-validate against a newer Claude Code. Direct mode shares
the installed `claude` compatibility boundary.)

The version check **never blocks the bridge from loading**: if either binary is
absent or unreadable, the version probe collapses to "unknown" (no warning), and
the missing binary surfaces as a real error at the first turn — never at import.

### Native disallow-list

After updating Claude Code, check for new built-in tools that may need adding to
the shared disallowed closed set (`CLAUDE_P_DISALLOWED_TOOLS` in
`src/driver/claudeP.ts`, consumed by both adapters). The bridge isolates the model to the
`mcp__custom-tools__*` namespace; unrecognized native CC tools that leak through
appear in pi as tool calls it can't handle ("Tool X not found"). The version-skew
warning above is your prompt to do this audit.
