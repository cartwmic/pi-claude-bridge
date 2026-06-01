# Phase-0 claude-p feasibility gate — reproducible spike note

**Date:** 2026-05-31 · **Versions:** `claude 2.1.159`, `claude-p 0.1.0` (npm),
node 24.14.0, darwin 23.3.0 · **Change:** `replace-sdk-with-claude-p`

This note records EXACTLY what was run and observed. Captured streams are in this
directory. It distinguishes **PROVEN** facts from **UNVERIFIED** assumptions so
the design does not over-claim (see the "Gate status" section).

## Harness

- `mcp-server.mjs` — minimal stdio MCP server (advertises one tool `pi_ping`;
  on call, logs RECEIVED→RESPONDING with an env-configurable `DELAY_MS`, returns
  a sentinel). Imports `@modelcontextprotocol/sdk` from the repo's node_modules.
- `mcp-config.json` — points `claude`/`claude-p` at the server.

## Experiments + evidence

### Exp 1 (raw `claude -p`) — agent-loop confirmation → `exp1-p-agentloop-stream.jsonl`
Command: `claude -p "Use the pi_ping tool, then report exactly what it returned." --mcp-config mcp-config.json --strict-mcp-config --permission-mode bypassPermissions --output-format stream-json --verbose --model claude-haiku-4-5`
Observed event sequence: `system/init (tools=32) → assistant(thinking) → assistant(tool_use mcp__pi-spike-tools__pi_ping) → user(tool_result) → assistant(text) → result(stop_reason=end_turn, num_turns=2)`.
**PROVEN:** Claude Code executes the MCP tool ITSELF and synthesizes the `tool_result` in ONE invocation → it is an agent loop, not a stop-at-tool-use completion endpoint. No `--max-turns` exists in the base CLI (`claude --help` grep: 0 matches).

### Exp A (raw `claude -p`) — held-open MCP call blocks the CLI inline
`DELAY_MS=5000`. call-log: `RECEIVED 03:00:57.143 → RESPONDING 03:01:02.148` (5.0s). Per-line timing showed tool_use@t≈4s, tool_result@t≈9s.
**PROVEN (on -p):** the CLI BLOCKS inline waiting for the MCP server's response → the bridge's "park the promise in the MCP handler" mechanism works.

### Exp B (raw `claude -p --input-format stream-json`) — persistent multi-turn
Fed two user messages over stdin; one process; same `session_id`; turn 2 recalled turn-1 fact. (Informational only — `-p` is FORBIDDEN in production; documents that a persistent stream-json session exists on `-p`, NOT used.)

### Exp C (THROUGH claude-p, interactive TUI) — the production-path proof → `expC-claude-p-stream.jsonl`, `expC-mcp-call-log.txt`
Command: `npx -y claude-p@0.1.0 "Use the pi_ping tool, then report exactly what string it returned." --mcp-config mcp-config.json --strict-mcp-config --permission-mode bypassPermissions --output-format stream-json --verbose --model claude-haiku-4-5 --timeout 180 --debug` · `DELAY_MS=4000`. EXIT=0, ~17s wall.
call-log: `RECEIVED 03:16:34.741 → RESPONDING 03:16:38.743` (4.0s held).
**PROVEN (through claude-p):**
- The held-open MCP call blocks claude-p inline through the interactive TUI (4s hold reproduced; claude-p waited for the turn to complete before emitting `result`).
- `claude-p --output-format stream-json --verbose` flushes lines live.
- claude-p ran in an UNTRUSTED `/tmp` cwd with NO trust-dialog hang (claude-p handles ANSI/trust itself).
- Emitted stdout schema (raw interactive transcript): leading `mode`, `permission-mode`, `file-history-snapshot`, `user`(content=string), `attachment`×2, `ai-title`; then `assistant(thinking)`, `assistant(text)`, `assistant(tool_use WaitForMcpServers)`, `assistant(tool_use mcp__pi-spike-tools__pi_ping)`, `user(tool_result)`, `assistant(text)`; trailing `system/stop_hook_summary`, `system/turn_duration`, `result`. The `result` line carries `usage` (input/output/cache_read/cache_creation) but **NO `stop_reason`**.

## Gate status (PROVEN vs UNVERIFIED)

**PROVEN by this spike:**
1. Claude Code is an agent loop; host tool execution only via a held-open MCP server. (Exp 1/A)
2. The held-open mechanism works through claude-p interactive — for a SINGLE tool round. (Exp C)
3. claude-p stream-json flushes live; trust dialog self-handled; `result.usage` carries cache token fields. (Exp C)

**NOT YET VERIFIED (promoted to Phase-0/Phase-1 HARD GATES — see tasks.md):**
- G1. **Multi-round held blocking:** claude-p keeps blocking correctly across ≥3 sequential held tool rounds in one spawn (Exp C tested ONE round + the auto `WaitForMcpServers`).
- G2. **Constitution IV:** `--disallowedTools` + `--strict-mcp-config` + `--setting-sources ""` forwarded through claude-p AND honored by `claude` — proven by (a) `tools/list` introspection with a user-global `permissions.allow:["Bash(*)"]` + user MCP server present showing ONLY `mcp__custom-tools__*`, AND (b) an actual native-tool emission attempt that is refused. (Exp C had NO user-global config present, so isolation EFFECT is unproven; `--strict-mcp-config` is forwarded-as-unknown, `--setting-sources ""` empty-form is undocumented for claude-p.)
- G3. **Turn-end & cache-shape:** whether claude-p emits ONE `result` per pi turn or one per agent-loop segment; whether per-turn `(cache_creation, cache_read)` is recoverable across tool rounds (SCENARIOS cache-shape bar).
- G4. **Warm-resume cache-read:** `claude-p --resume <id>` yields `cache_read_input_tokens > 0` rather than a cold creation each spawn.
- G5. **Abort coherence (S7/S13):** cold-replay of pi history reproduces "what had the model started saying before I interrupted" — the SDK era got this via session-resume of the interrupted partial (`index.ts:1265-1313`).
- G6. **S5 mid-stream steer:** abort+respawn satisfies S5 coherence + no duplicated-essay-tail; cache-shape will be creation (document as exemption).
- G7. **`--timeout` semantics:** does claude-p's `--timeout` count wall-time blocked on a held MCP call (would trip 124 on S3 45s / S8 120s tools)?
- G8. **Cross-channel tool-call correlation:** reconcile {shim MCP request id} ↔ {model `toolu_…` id on stdout} ↔ {pi `toolResult.id`}, incl. S11 parallel tools (design D32).
- G9. **Concurrent spawns:** two claude-p PTYs isolated (S25 main+capture AND S14 nested main+main subagents), incl. `WaitForMcpServers` against a shim holding another spawn's call.
- G-resume. **`--input-file`/`--system-prompt-file` forwarding** through claude-p (verified on raw `claude` historically, NOT through claude-p).

> The canonical, authoritative gate set lives in design.md's "Verification status"
> block; it has grown to **G1–G9 + G-resume-flags** since this note was first written.

The agent-loop thesis gate is CLEARED. The behavioral gates **G1–G9 + G-resume** are
NOT, and must pass (or be documented exemptions / trigger the claude-p fork) BEFORE
the Phase-3 SDK deletion (blocking set: G1–G5 + G7 + G8 + G9 + G-resume; G2
non-negotiable; G6/S5 may ship as a documented exemption).
