# AGENTS.md — pi-claude-bridge

Working agreement for agents and humans editing this repo. It records the
**tenets** the code is built to satisfy and the **standing decisions** behind the
current architecture. Code comments, scenarios, and tests refer to these by name.

The bridge is a pi extension that uses Claude Code as an inference provider. Pi
owns the conversation; the bridge forwards a turn to a `claude` subprocess and
routes tool calls back into pi.

---

## Tenets

Numbered for stable reference. A tenet is only changed by a deliberate decision
recorded in "Standing decisions" below.

### T1 — Pi owns conversation state

The bridge is an inference adapter, not a conversation authority. Pi holds the
canonical message history, the active tool set, and the session lifecycle
(fork/compact/tree). The bridge treats pi's state as input on every turn and
does **not** persist conversation history of its own.

**Permitted exception — content-free resume metadata.** The bridge may persist a
*content-free* resume sidecar (driver identity, driver session id, a one-way
digest fingerprint of pi's message history, and the `claude` version) to a
bridge-owned location outside `~/.claude/`, solely to validate a warm
`--resume` across a pi restart. The sidecar must carry no message bodies, tool
arguments, tool results, thinking text, or turn counters — only opaque digests
from which no plaintext can be reconstructed. Any fingerprint mismatch discards
the sidecar and falls back to cold start, which is always safe.

*Why:* prevents the divergence and replay deadlocks of the pre-2026-04
architecture. *Enforced by:* design review of any new persistent state, plus a
sentinel test asserting no substring of any message appears in the serialized
sidecar.

### T2 — Bridge is inference-only

The bridge does not execute pi tools, does not contain domain business logic,
and does not mutate pi's UI directly. Its responsibilities are exactly: forward
pi's prompt to a driver, surface inference output to pi as `AssistantMessage`
events, and route tool calls back to pi for execution.

*Why:* this is historically the place where "just one more feature" became an
1800-line monolith. The tenet bounds growth.

### T3 — No filesystem coupling to the driver's mutable state

The bridge **never writes** any path under `~/.claude/` — not the session
metadata store (`~/.claude/sessions/`), not project transcripts
(`~/.claude/projects/`), not `settings.json`, not plugin/skill caches.

The bridge **may read** a transcript JSONL under `~/.claude/projects/` only when
either (a) the path arrived via a `SessionStart`/`Stop` hook payload, or (b) the
path was deterministically computed from a session UUID the bridge itself
generated and passed as `--session-id`. No directory listing, no searching, no
inspection of files the bridge did not cause to exist.

Configuration is inline and exclusive (`--settings '<json>'`,
`--mcp-config '<json>'`, CLI flags). No edits to user-global config.

*Why:* isolates the bridge from driver upgrades, keeps the user's own `claude`
setup unpolluted, and makes the bridge safe to run alongside interactive
`claude`. *Enforced by:* code review plus a CI grep for any write under
`~/.claude/`.

### T4 — Native Claude tools are disallowed

No native built-in tool (Read, Write, Edit, Bash, Glob, Grep, Agent, WebFetch,
WebSearch, TodoWrite, plan-mode or deferred-task tools, …) may be **routed,
executed, or surfaced to pi**. Only pi-bridged tools exposed through the
bridge's MCP surface are callable.

The binding guarantee is *non-routing / non-execution*, **not** "the model never
emits a native `tool_use`". The model emits built-in `tool_use` blocks on
instinct regardless of configuration, and some drivers emit internal
housekeeping built-ins every turn (e.g. claude-p's `WaitForMcpServers`). Such
emissions are permissible provided the bridge drops them.

*Why:* pi is the user-facing tool authority; native tools bypass pi's permission
model, UX, and audit trail. *Enforced by:* a **closed-set** assertion — the
driver's advertised tool surface is exactly the `mcp__custom-tools__*` set —
plus a **non-execution** assertion that a native emission never reaches a
handler. A bare disallow-list is necessary but not sufficient: it cannot catch a
future built-in that is not on the list. Auditing new Claude Code built-ins on
upgrade is a direct expression of this tenet.

### T5 — System prompt fidelity per path

Two prompt paths, two contracts. The **main-provider path** may append
pi-derived material (skills, agents, append-system) to pi's `ctx.systemPrompt`
in documented locations. The **capture path** forwards `ctx.systemPrompt`
verbatim with no additions.

*Why:* capture is a generic structured-output API consumed by other components;
surprising prompt mutations break callers opaquely. *Enforced by:* a unit test
asserting the capture path's prompt bytes equal `ctx.systemPrompt` bytes.

### T6 — Concurrent paths share no state

The main-provider path and the capture path share no session caches, working
directories, frame stacks, or in-flight tool queues. A capture call issued
mid-conversation must not affect main-provider session continuity.

*Why:* capture is invoked from skills/scripts that may run in parallel with the
user's interactive turn; state bleed corrupts both. *Enforced by:* an
integration test that invokes capture mid-conversation and verifies main-turn
state is unchanged.

### T7 — Failures surface; degradation is explicit

When the driver behaves unexpectedly (schema mismatch, missing transcript,
unknown record type, abort not honored), the bridge surfaces the failure to pi
through a documented error path. Silent fallback to a degraded mode is
forbidden — including silent driver switching.

*Why:* silent degradation creates "works on my machine" bugs that cost more to
debug than loud failures. *Enforced by:* every error path produces a structured
log entry and an `AssistantMessage` with `stopReason: "error"` +
`errorMessage`. The `claude-print` stream decoder is the sharpest instance: it
fails closed on unknown record types rather than guessing.

---

## Standing decisions

Distilled from the retired ADR set (ADR-0001 … ADR-0007, accepted 2026-06-16).
Each entry is the decision plus its live consequence. Where a decision has since
moved on, the current state is noted.

### D1 — Consume the `claude-p` fork by exact commit pin

`package.json` pins `github:cartwmic/claude-p#<sha>` rather than the upstream
npm release or a vendored binary. The fork's patch confirms the typed prompt
echoed into Ink's input box before pressing Enter, fixing the intermittent
`StopTimeout` hang where prompts ≥801 bytes were silently dropped under
concurrent-boot CPU contention.

*Consequence:* the bug is fixed at its real boundary with no bridge-side change,
and the lockfile carries reproducible evidence of the resolved commit. Updating
the driver requires deliberately moving the pin. Install needs Zig on `PATH`
because the fork's `prepare` runs `zig build`. The bridge checks the fork's
`claudePPatch` marker on first spawn and warns if a stock `claude-p` resolved.

*Current state:* the pin has advanced past the original `f47f71d`; see
`package.json` for the live value.

### D2 — Large cold-start prompt delivery is proven by a live scenario

Scenario S31 starts fresh with `pi --no-session` and sends a first prompt above
the byte threshold that used to fail, asserting both bridge-log signals and
model-level coherence. A unit fixture was rejected as insufficient: the failure
only existed end-to-end through tmux → pi → bridge → driver → Ink → model.

*Consequence:* regression evidence stays loud, at live-scenario cost. The
scenario is verification coverage only and changes no production behavior.

### D3 — No idle watchdog, and no replacement timer

The bridge runs **no liveness or wedge timers**. The former idle watchdog —
which killed a process group after a silent window and classified the turn as
retry-eligible — was deleted outright rather than default-disabled, so no future
change can quietly re-enable it.

*Consequence:* no bridge timer can kill a healthy spawn. Real boot failures
still surface as subprocess exits and stay retry-eligible. A true
no-output/no-exit hang requires caller intervention; diagnostics (D6, D7) exist
so such hangs are observable rather than guessed at.

### D4 — `killWedged()` is not part of the driver interface

With the watchdog gone, `ClaudePHandle.killWedged()` had no approved caller and
was removed from the interface, implementation, resilience wrapper, and failed
handle stub.

*Consequence:* `abort()` is the sole caller-driven termination path. Callers may
abort; they may not declare a wedge. Natural premature exits still classify as
errors and remain retry-eligible. Any future auto-recovery policy needs a new,
explicit interface decision.

### D5 — No bridge-supplied wall-clock timeout

`CLAUDE_BRIDGE_CLAUDE_P_TIMEOUT_SECONDS`, the `timeoutSeconds` config fields,
and `--timeout` emission were removed. A wall cap counts time spent while pi
tools are held open, so it kills healthy turns parked on a long-running tool or
a human-in-the-loop action.

*Consequence:* main and capture paths share one no-timeout contract.
Unattended-batch ceilings belong to an external supervisor, which cancels by
aborting the pi turn. `SessionStartTimeout`/`StopTimeout` emitted by the driver
*itself* remain real driver errors.

### D6 — Per-spawn stderr capture with a bounded error tail

Full child stderr is persisted per spawn under the bridge diagnostics directory,
and a bounded tail is included in the error surfaced to pi.

*Consequence:* premature exits are self-describing in pi (upstream causes such
as `PromptNotAccepted` or Anthropic stream errors appear inline) while stdout
stays a clean NDJSON event channel. Capture is best-effort and never alters
retry/abort classification. Diagnostic files accumulate without rotation.

### D7 — Native `claude` debug output is forwarded to a bridge-owned path

The bridge appends `--debug-file <bridge-owned-path>` per spawn, on by default,
disabled with `CLAUDE_BRIDGE_CLAUDE_DEBUG_FILE=0`.

*Consequence:* native debug logs are captured alongside bridge diagnostics
instead of defaulting under `~/.claude/`, satisfying T3 with no driver fork
change (unknown flags pass through). `--debug-file` implicitly enables debug
mode, so the env escape hatch exists for the residual risk that debug mode
perturbs the interactive PTY.

### D8 — Two drivers, explicit selection, no automatic fallback

`claude-print` (direct `claude -p` with stream-JSON in and out; the default) and
`claude-p` (the interactive TUI fork) have equal standing. Selection is
process-wide, fixed at extension load, via `CLAUDE_BRIDGE_DRIVER`. Unknown
values fail fast. There is no silent fallback between drivers — switching modes
on error would violate T7. `claude-print` requires Claude Code ≥ 2.1.208. The
sole parity exception is `/claude-peek`, which is structurally impossible in
print mode because it depends on the TUI.

---

## Conventions

- **Commits** — conventional-commit prefixes (`feat:`, `fix:`, `docs:`,
  `chore:`, `refactor:`).
- **Tests** — `npm run test:unit` for the unit suite; `npm test` additionally
  runs live integration against a real `claude`. Scenario suites live in
  `scripts/run-scenario-s*.sh`, are documented in `SCENARIOS.md`, and their
  outcomes are recorded in `SCENARIO_RESULTS.md`.
- **Typecheck/build** — `npm run typecheck`, `npm run build` must both be clean
  before a change is considered done.
- **Diagnostics** — never write under `~/.claude/`; the bridge debug directory
  is the only destination (T3).
