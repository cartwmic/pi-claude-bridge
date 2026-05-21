# pi-claude-bridge Constitution

**Version:** 1.1.0
**Ratified:** 2026-05-20
**Last updated:** 2026-05-21 (Principle III amended: added the deterministic-path exemption)

## Core Principles

### I. Pi owns conversation state
The bridge is an inference adapter, not a conversation authority. Pi
holds the canonical message history, the active tool set, the
session lifecycle (fork/compact/tree). The bridge MUST treat
pi's state as input on every turn and MUST NOT persist conversation
history of its own.

**Rationale:** prevents the divergence and replay deadlocks that
defined the pre-2026-04 architecture. Pi is the single source of truth.
**Enforcement:** analyze artifact check 3 (AC↔design coverage); design
review of any new persistent state.

### II. Bridge is inference-only
The bridge MUST NOT execute pi tools, MUST NOT contain domain
business logic, and MUST NOT mutate pi's UI directly. Its
responsibilities are: (a) forward pi's prompt to an inference driver,
(b) surface inference output to pi as `AssistantMessage` events,
(c) route tool calls back to pi for execution.

**Rationale:** the bridge has historically been the place where
"just one more feature" turned into a 1800-line monolith. The
principle bounds growth.
**Enforcement:** any new module touching pi tool execution or pi UI
directly is flagged in analyze.

### III. No filesystem coupling to the inference driver's mutable state
The bridge MUST NOT write to any path under `~/.claude/` — including
but not limited to the session metadata store (`~/.claude/sessions/`,
which holds PID-keyed JSON), the project transcript directory
(`~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`, which holds
append-only conversation transcripts), settings (`settings.json`),
plugin/skill caches, or anything else.

The bridge MAY read a transcript JSONL file under
`~/.claude/projects/` when EITHER of the following holds:
  (a) the path was delivered to the bridge via a `SessionStart` or
      `Stop` hook payload; OR
  (b) the path was deterministically computed from a session UUID the
      bridge itself generated for the current PTY and passed as
      `--session-id <uuid>` (the file at
      `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` is a known
      artifact of the spawn the bridge initiated; the bridge does
      not list or inspect other files in the directory).

Inline configuration (`--settings '<json>'`, `--mcp-config '<json>'`,
CLI flags) is used exclusively; no edits to user-global config.

**Rationale:** isolates the bridge from driver upgrades, prevents
pollution of the user's `claude` setup, and keeps the bridge safe to
run alongside the user's own `claude` usage. Both directories matter:
`sessions/` holds PID-keyed metadata the user's own `claude` processes
write; `projects/` holds the transcripts the bridge needs to read.
The deterministic-path exemption (b) was added 2026-05-21 via the
`replace-sdk-with-pty-tui` Scale-L change after the original
"hook-payload-only" wording proved incompatible with reliable
transcript discovery on interactive `claude` (hook payload contract
for `transcript_path` is not guaranteed in interactive mode). The
exemption preserves the principle's intent (no broad filesystem
searches; no listing of unrelated files; no writes) while permitting
the deterministic-path lookup the new driver requires.
**Enforcement:** code review; CI grep for any write under `~/.claude/`
(not just `sessions/`); plus an assertion that the only paths the
bridge opens for reading under `~/.claude/projects/` are paths it
computed from a bridge-generated `--session-id` UUID OR paths
delivered to it via a hook payload.
**Version bump on this amendment:** 1.0.0 → 1.1.0 (minor: principle
clarified to add exemption (b); no principle reversed).

### IV. Native Claude tools are disallowed
The inference driver MUST be configured such that all native built-in
tools (Read, Write, Edit, Bash, Glob, Grep, Agent, WebFetch,
WebSearch, TodoWrite, plan-mode tools, deferred-task tools, etc.) are
blocked at emission. Only pi-bridged tools, exposed via the bridge's
MCP surface, are callable.

**Rationale:** pi is the user-facing tool authority. Native tools
bypass pi's permission model, UX, and audit trail. The "Maintenance"
note in README — auditing new CC built-ins on upgrades — is a
direct expression of this principle.
**Enforcement:** every inference driver configuration MUST list
disallowed tools; CI test asserts the disallow list is non-empty and
includes the documented set.

### V. System prompt fidelity per path
The bridge has two prompt-handling paths with different contracts.
The **main-provider path** MAY append pi-derived material (skills,
agents, append-system) to pi's `ctx.systemPrompt` in documented
locations. The **capture path** MUST forward `ctx.systemPrompt`
verbatim with no additions.

**Rationale:** capture mode is a generic structured-output API
consumed by other components; surprising system-prompt mutations
would break callers in opaque ways.
**Enforcement:** unit test asserts capture path's prompt bytes
match `ctx.systemPrompt` bytes; analyze flags any code path that
mutates capture prompts.

### VI. Concurrent paths share no state
The main-provider path and the capture path MUST NOT share session
caches, working directories, frame stacks, or in-flight tool queues.
A capture call mid-conversation MUST NOT affect main-provider
session continuity.

**Rationale:** capture is invoked from skills/scripts that may run in
parallel with the user's interactive turn. State bleed would corrupt
both.
**Enforcement:** design check; integration test invokes capture
mid-conversation and verifies main turn state unchanged.

### VII. Failures surface; degradation is explicit
When the inference driver behaves unexpectedly (schema mismatch in
hook payload, missing transcript file, unknown tool emission, abort
not honored), the bridge MUST surface the failure to pi via a
documented error path. Silent fallback to a degraded mode is
forbidden.

**Rationale:** silent degradation creates "works on my machine"
bugs that cost more to debug than loud failures.
**Enforcement:** every error path produces a structured log entry
and an `AssistantMessage` with `stopReason: "error"` +
`errorMessage`.

## Governance

- Amendments require a dedicated change with Scale ≥ L and
  adversarial-review-cycle invoked.
- Principles override schema instructions when they conflict.

## Versioning

- Major: principle removed or reversed.
- Minor: principle added.
- Patch: clarification, no semantic change.

## See also

- Domain: `openspec/domain.md`
- Schema: `~/.local/share/openspec/schemas/opsx-superpowers/README.md`
