# ⚑ Replan Amendment (2026-05-31): claude-p driver supersedes the in-house node-pty design

> **Authoritative.** This amendment is the current direction. The decisions
> D1–D25 below it are retained as the adversarial-review archaeology (Rounds
> 1–5) that produced the in-house-PTY plan; where this amendment and a prior
> decision conflict, **this amendment wins**. The supersession map at the end
> of this section says exactly what changed.
>
> Branch `replan-driver-from-phase-0`, rooted at commit `7cd9d3e` (the Phase-0
> spike baseline — SDK still present, no PTY work yet).

## Replan drivers (two hard constraints)

1. **All pi-TUI scenario tests (S0–S25, ~28 scripts) MUST pass**, OR a scenario
   carries a documented fundamental architectural/design exemption. No silent skips.
2. **No in-house PTY, and the nominal `claude -p` surface is forbidden.** Delegate
   all terminal-driving to **`smithersai/claude-p`** (interactive-TUI wrapper),
   adopted as a dependency and **forked/patched if needed**.

## Phase-0 spike results (claude 2.1.159 + claude-p 0.1.0; the new hard gate)

The replan's gate was not "can we drive a PTY" but **"does Claude Code expose a
completion-shaped seam, or only an agent loop?"** Spike answer, with evidence:

| Probe | Result |
|---|---|
| Agent loop vs completion API | **Agent loop.** No `--max-turns` in the base CLI; no stop-at-tool-use. When the model calls an MCP tool the CLI executes it itself, synthesizes the `tool_result`, and runs `thinking→tool_use→tool_result→text→end_turn` in ONE invocation. |
| Can pi execute tools? | **Yes — only via the MCP server, held open inline.** The CLI BLOCKS waiting for the MCP `tools/call` response (verified: 4–5s artificial holds reproduced exactly, on `claude -p` AND through claude-p). |
| Live streaming | claude-p `--output-format stream-json --verbose` flushes transcript lines **live** (per-block, not per-token). |
| Trust dialog | claude-p **handles it itself** — spike ran in an untrusted `/tmp` cwd with no hang. |
| Cache accounting | `result.usage` carries `input/output/cache_read/cache_creation` tokens. |
| Cold boot | Heavy (~seconds; one turn ~17s incl. a 4s artificial hold + generation) — much slower than `-p`. |

**The decisive architectural conclusion:** the bridge's "one invocation per pi
turn + park-the-promise in the MCP handler" model is **structurally forced by
Claude Code**, not accidental complexity. Every other pi provider is a thin
completion wrapper because it wraps the Messages API (a real completion endpoint
that stops at `tool_use` and accepts `tool_result` blocks). Claude Code exposes
no such seam, so the bridge must *be* the MCP server and hold the call open. This
is the irreducible cost of riding the Claude Code surface instead of the API —
and it is preserved across the driver swap.

### Verification status — PROVEN vs UNVERIFIED (do not over-claim)

The reproducible spike artifact lives at `.spike-notes/claude-p-gate/` (harness +
captured `claude-p` stdout from the run below). What the spike actually PROVED:

1. Claude Code is an agent loop; host tool execution only via a held-open MCP server.
2. The held-open mechanism works **through claude-p interactive** — for a SINGLE tool round (Exp C, 4s hold reproduced, EXIT 0).
3. claude-p stream-json flushes live; trust dialog self-handled in an untrusted cwd; `result.usage` carries cache token fields; `result` carries NO `stop_reason`.

What the spike did NOT prove — these are **behavioral hard gates G1–G9 + G-resume-flags**, NOT
"cleared," and they block the Phase-3 SDK deletion (see ordering below):

- **G1 multi-round held blocking** — ≥3 sequential held tool rounds in one spawn (Exp C tested one round).
- **G2 constitution IV** — `--disallowedTools` + `--strict-mcp-config` + `--setting-sources ""` forwarded through claude-p AND honored, proven by `tools/list` introspection with a user-global `permissions.allow` + user MCP server present AND an actual native-tool-emission attempt that is refused. (Exp C had no user-global config present; claude-p reserves `--settings`, so the prior `permissions.deny` layer we had verified is LOST and replaced by an unverified `--disallowedTools` forwarding contract; `--strict-mcp-config` forwards only as an unknown flag; `--setting-sources ""` empty form is undocumented for claude-p.)
- **G3 turn-end & cache-shape** — whether claude-p emits one `result` per pi TURN or per agent-loop SEGMENT, and whether per-turn `(cache_creation, cache_read)` is recoverable across tool rounds.
- **G4 warm-resume cache-read** — `--resume <id>` yields `cache_read_input_tokens > 0`, not a cold creation per spawn.
- **G5 abort coherence (S7/S13)** — cold-replay reproduces the interrupted-partial recall the SDK got via session-resume (see D31).
- **G6 S5 mid-stream steer** — abort+respawn satisfies coherence + no duplicated-essay-tail (see D-S5).
- **G7 `--timeout` semantics** — whether claude-p's `--timeout` counts wall-time blocked on a held MCP call (would trip exit 124 on S3 45s / S8 120s tools).
- **G8 cross-channel tool-call correlation** — the held-open round-trip is now SPLIT across two channels: the shim sees an MCP `tools/call` (its own JSON-RPC id), while the model's `toolu_…` id appears only on claude-p's stdout, and pi delivers `toolResult.id` = the model's `toolu_…` id. G8 proves the router's correlation strategy (D32) reconciles these three ids — including **S11 parallel tool_use in one assistant line**, where FIFO is insufficient.
- **G9 concurrent spawns (S25)** — two claude-p PTYs alive at once (a capture spawn while a main turn's tool is parked), each with an isolated shim/socket, and `WaitForMcpServers` resolving against a shim that is concurrently holding a DIFFERENT spawn's call open. Concurrent cold-boot cost is also measured here.
- **G-resume-flags `--input-file`/`--system-prompt-file`** — verify claude-p forwards these (historical D7 verified them on raw `claude`, NOT through claude-p); load-bearing for cold-start replays that overflow argv.

### Phase ordering (risk-inversion fix)

The Phase-3 SDK deletion (tasks 3.2/3.3) is IRREVERSIBLE in-process. It SHALL NOT
proceed until G1–G5 + G7 + **G8 + G9** + G-resume-flags pass empirically OR the
vendored claude-p fork (task 4.10) is already in place. (G6/S5 is intentionally
NOT in the blocking set — it may ship as a documented exemption.) G2 (constitution IV) is a non-negotiable hard gate: if
`--disallowedTools` does not demonstrably suppress native-tool emission through
claude-p, the fork is mandatory before cut-over, not conditional. The SDK path
(`CLAUDE_BRIDGE_DRIVER=sdk`) remains the rollback fallback until every gate is green.

## New decisions

### D26: Driver = `smithersai/claude-p`; nominal `claude -p` is forbidden
**Choice:** spawn `claude-p` as a subprocess per turn. claude-p emulates `claude -p`
by driving the **interactive** TUI inside its own PTY (zmux), responding to ANSI
terminal probes, auto-answering the workspace-trust dialog, registering its own
`SessionStart`/`Stop` hooks, and typing the prompt. The bridge never invokes
`claude --print` itself. **Supersedes D1 + D2** (in-house node-pty). Forking
claude-p (Zig 0.15.2) is in scope; npm ships prebuilts for darwin/linux × x64/arm64
so adoption needs no Zig.
**Rationale:** owner's trust stance — the interactive TUI is the subscription-blessed
surface; `-p`/SDK is the headless surface that may be restricted. claude-p already
solved the terminal-driving the prior plan was about to build by hand.

### D27: Event source = claude-p `--output-format stream-json` stdout
**Choice:** consume claude-p's stdout (requires `--verbose`) as the event stream;
parse per-block. **The bridge reads nothing under `~/.claude/`** — claude-p does any
transcript reading internally. **Supersedes D4 + D18 + D24** (in-house transcript
tail + deterministic-path discovery + warm-resume baseline offset) for the streaming
mechanism. The `transcript-stream` capability is repointed at claude-p's stdout.
**claude-p's emitted schema is the raw interactive transcript, noisier than `-p`'s:**
leading `mode`/`permission-mode`/`file-history-snapshot`/`attachment`/`ai-title`
lines, user content as a STRING, a built-in `WaitForMcpServers` tool_use, trailing
`system/stop_hook_summary` + `system/turn_duration`, and a `result` envelope that
carries `usage` but **NO `stop_reason`**. The parser MUST filter the noise/built-in
lines and detect turn-end from the `result` line (not `stop_reason`). Drift detection
(known / valid-unknown-type / malformed) from D4 is retained.

**UNVERIFIED — hard gate G3 (turn-end vs the held-open multi-round loop).** Exp C
observed a single linear sequence ending in one `result`. But a real pi turn is an
agent loop: `assistant(tool_use) → [bridge holds the MCP call, pi executes] →
tool_result → assistant(text/tool_use) → … → result`. It is NOT yet established
whether claude-p emits ONE `result` per pi TURN or one per agent-loop SEGMENT. If
per-segment, "turn-end = first `result`" would terminate the turn after the first
tool round and corrupt every multi-round scenario (S1/S2/S11). G3 MUST record a
multi-tool-round claude-p stdout fixture and pin the turn-end requirement to it.
The transcript-stream spec adds explicit ACs: (a) a `tool_use` block does NOT end
the turn (it routes to the MCP shim/router and the turn continues), (b) multiple
`tool_use` blocks in one assistant line each emit a distinct routed event with
stable correlation (S11 parallel-tool regression), (c) `result` is disambiguated
from the `system/stop_hook_summary`/`system/turn_duration` trailers.

**UNVERIFIED — hard gate G4 (cache-shape obtainability).** SCENARIOS requires
per-TURN `(cache_creation, cache_read)` and treats a mismatch as scenario-blocking.
The replan sources usage only from the terminal `result.usage`. G4 MUST prove that
for a multi-tool-round turn the per-turn cache tokens are recoverable (cumulative,
not just the last segment) AND that `--resume` yields `cache_read_input_tokens > 0`
(warm) rather than a cold creation per spawn. If claude-p cannot surface warm cache
reads, the affected cache-shape rows need documented exemptions stated up front.

### D28: Native-tool blocking via `--disallowedTools` (claude-p reserves `--settings`)
**Choice:** claude-p rejects user-supplied `--settings` (it owns it for its hooks),
so the prior `--settings permissions.deny` mechanism (D11 layer 1) is replaced by
`--disallowedTools <natives>`, which claude-p forwards to `claude`. Isolation flags
`--strict-mcp-config` and `--setting-sources ""` also forward. **Modifies D11**:
layer 1 becomes `--disallowedTools`; layers 2–4 (`--setting-sources ""`,
`--strict-mcp-config`, shim `tools/list` rejection) unchanged.

**UNVERIFIED — hard gate G2 (non-negotiable).** This is the single riskiest
substitution in the replan. The prior `--settings permissions.deny` (D11 layer 1)
was an EMISSION-time block we had verified on raw `claude`; claude-p REJECTS
`--settings`, so that verified layer is LOST. Its replacement, `--disallowedTools`,
is a different `claude` flag with different semantics, here only forwarded by
claude-p as an unrecognized flag (claude-p documents `--disallowedTools` explicitly,
but `--strict-mcp-config` only as pass-through, and `--setting-sources ""` empty
form is undocumented for claude-p). The spike did NOT prove isolation through
claude-p (Exp C ran with no user-global config present). Before cut-over, G2 MUST
prove, through claude-p: (a) `tools/list` introspection with a user-global
`permissions.allow:["Bash(*)"]` AND a user-global MCP server present shows ONLY
`mcp__custom-tools__*`; AND (b) an actual native-tool EMISSION attempt (model asked
to use Bash) is refused — not merely absent from `tools/list`. If either fails, the
claude-p fork (task 4.10) is mandatory before Phase 3. A native tool leaking
(Read/Write/Bash) bypasses pi's sandbox and diverges history — a constitution-IV
violation, which is non-negotiable.

**Denylist vs allowlist (constitution IV is allowlist-shaped).** `--disallowedTools`
is a DENYLIST that must enumerate every native tool; constitution IV's intent is
"only pi-bridged tools are callable" (an allowlist), and a denylist is exactly the
"audit new CC built-ins on upgrade" fragility — a future `claude` built-in not in
the enumerated set would be callable. G2 SHALL therefore additionally (i) test
whether `--allowedTools mcp__custom-tools__*` (a true allowlist) is honored through
claude-p and prefer it if so; and (ii) assert via `tools/list` that the callable set
is EXACTLY `mcp__custom-tools__*` (closed-set), not merely that the enumerated names
are absent — the closed-set assertion catches an unknown re-enabled built-in. The
runtime version-skew check (T4.7) SHALL name "re-audit the disallow set against
`claude --help`'s tool list" as its trigger.

### D29: Hooks + trust dialog + prompt delivery owned by claude-p
**Choice:** the bridge registers NO hooks and runs NO hook-relay subprocess —
claude-p owns `SessionStart`/`Stop`, ANSI probes, the trust dialog, and prompt
typing. **Supersedes D9 + D12 + D25** and the hook-relay dual-mode of the shim.
Prompt delivery uses claude-p's positional arg / `--input-file` / stdin
(`--input-file` for large or multiline prompts) — **supersedes D13**'s positional-arg
+ argv-overflow machinery; claude-p handles the typing fragility the prior plan
worried about. The MCP shim is now MCP-server-only.

### D30: MCP shim + router (held-open promise-park) — RETAINED, validated
**Choice:** unchanged in spirit from D3/D16/D19/D20/D21. The shim is a stdio MCP
server subprocess (`--mcp-config` → shim → in-process router over a per-spawn unix
socket); the router parks a Promise per `tools/call` and resolves it on pi's next
`streamSimple()`. The spike proved claude-p blocks on the held call. The shim's
hook-relay mode (D12) is removed; everything else (capture deterministic response,
shim path resolution, IPC wire protocol, capture authoritative-source) stands.

### D31: Abort = signal the claude-p subprocess; late-tool-result coherence retained
**Choice:** on pi abort, deliver `SIGINT` to the claude-p subprocess (claude-p
returns 130 and tears down its own PTY + `claude`); escalate to `SIGKILL` after a
grace window. No Esc-Esc/PTY-keystroke logic (that was the in-house-PTY path).
**Modifies D10**; **retains D15** verbatim — the bridge-side router state (the
`pendingResolvers`/`pendingResults` maps) survives so a late pi `tool_result` is
captured for next-turn replay. Cold-replay (not transcript-resume) reconciles an
aborted mid-tool turn, so there is no dangling-tool-use resume concern.

**UNVERIFIED — hard gate G5 (S7/S13 abort coherence).** The SDK era did MORE than
preserve router state: `index.ts:1265-1313` deliberately KEEPS `cachedSessionId`
on abort and `--resume`s the SDK session on the next turn precisely so the model
recalls the *interrupted partial assistant message* (S7's probe "what number did
you reach before I interrupted you?"; S13's enumeration). Under claude-p we DROP
the cache on abort and cold-replay pi history — which contains the aborted-error
`AssistantMessage`, NOT necessarily the literal partial text the model had
streamed. **Requirement added (claude-p-driver spec):** on abort, the bridge SHALL *attempt to*
commit the partial assistant text (and any tool-call blocks) streamed so far into the
aborted `AssistantMessage` so pi history carries it into the next cold-replay.

**Caveats G5 must resolve (do not treat as settled):**
- The SDK recovered the partial via session-`--resume` of its own JSONL, NOT via pi
  history (`index.ts:1273-1278` comment is explicit) — so whether pi's cold-replay
  even INCLUDES the content of an `aborted`/`error` AssistantMessage is itself
  UNPROVEN and is part of what G5 proves.
- The **abort-while-blocked-on-a-held-tool variant** (S8: abort during tool
  execution; the turn already emitted `tool_use` and pi is computing the result) has
  NO in-flight assistant text to commit — `index.ts:1287-1331` synthesizes a fresh
  `newTurnOutput` with only an error. G5 MUST cover this variant and define what is
  preserved when no partial text exists (e.g. the prior tool_use blocks + an explicit
  "interrupted" marker), so S8's coherence ("did the sleep finish? — no") holds.
- G5 proves the above against live **S7, S8, AND S13**; if pi history is insufficient
  even with the partial committed, escalate (preserve more context, or a documented
  exemption). This is the deferred-message-loss bug class S13 exists to guard.

**Post-abort cache-shape consequence (S7/S8/S9/S13) — pre-stated, not discovered.**
SCENARIOS pins these post-abort/steer turns as cache-**read**, premised on the SDK
keeping the cache and `--resume`-ing the aborted session. Dropping the cache on abort
+ cold-replay makes them cache-**creation** (same mechanism as D-S5/S5). Two options,
decided in G4/G5: (a) if `claude-p --resume <id>` of a SIGINT-aborted session yields
warm cache reads, KEEP the cached id on abort (mirroring the SDK) and the rows stay
"read"; (b) if not, these rows become documented "read OR creation (cold-replay)"
exemptions recorded in `SCENARIO_RESULTS.md` up front — exactly as S5 was. Either way
the disposition is pre-stated before the T4.1 scenario gate, not surfaced as four
late failures.

### D32: Cross-channel tool-call correlation (held-open round-trip across shim + stdout)

**Problem (surfaced in review).** In the SDK era a SINGLE in-process MCP handler
correlated everything: it parked keyed by the model's `toolu_…` id (captured from
the SDK stream via `toolUseIdQueue`), and pi delivered `toolResult.id` = that same
`toolu_…` id, so resolution was a direct key match (`index.ts` ~586, 960-1006).
Under claude-p the round-trip is SPLIT across two channels:
- the **MCP shim** receives a `tools/call` carrying its own JSON-RPC request id and
  the tool `name` + `arguments` — but NOT, in general, the model's `toolu_…` id;
- the model's `toolu_…` id appears only on **claude-p's stdout** tool_use line;
- **pi** still delivers `toolResult.id` = the model's `toolu_…` id.

So the router must reconcile {shim request id} ↔ {model `toolu_…` id} ↔ {pi
`toolResult.id`}. This is the single most load-bearing mechanism of the change.

**Choice (to be proven by G8):** the router parks each shim `tools/call` and
correlates it to the model `toolu_…` id observed on stdout by matching on tool
`name` + canonicalized `arguments` (the shim call and the stdout tool_use describe
the same call), then keys the parked resolver by the recovered `toolu_…` id so pi's
`toolResult.id` resolves it directly — preserving today's resolution contract.
**Parallel/identical calls (S11):** when two tool_use blocks in one assistant line
share name+arguments, name+args matching is ambiguous; the router SHALL fall back to
positional pairing WITHIN that single assistant line (the shim receives the calls in
the model's emission order; stdout lists them in the same order) and SHALL assert the
counts match. **Serialization invariant:** the agent loop is serial PER round — a
`tool_use` blocks the model until its held MCP call resolves — so at most one held
call per `(name, canonicalized args)` is outstanding at any instant ACROSS rounds; the
router SHALL assert this when parking, so the within-line positional fallback is
sufficient and identical-args calls in *different* rounds cannot collide. G1
(multi-round) confirms rounds are serialized. If claude-p's MCP `tools/call` turns out to carry the model's `toolu_…`
id directly (to be checked in G8), that id is used and the name+args heuristic is
unnecessary. **G8 proves this on a 2-parallel-tool fixture before the router is written.**

**4-point test:** multiple-approaches? yes. lasting? yes. disagreement? yes.
future-constraint? yes. → **ADR candidate Y**.

### D-S5: Mid-stream steer — abort+respawn, exemption if insufficient
**Choice:** claude-p is one-prompt-per-spawn with no mid-turn input channel (unlike
`-p`'s `--input-format stream-json`). S5 (a new user message arriving during an
in-flight turn) is handled bridge-side as **abort the current claude-p spawn +
respawn with the steer**; both user messages remain in pi's history, so S5's
coherence probe ("did I ever ask about the printing press? — yes, then redirected")
still passes. IF abort+respawn proves insufficient against the live scenario, the
fallback is **forking claude-p to type a second message into the live TUI mid-turn**.
IF neither is pursued, S5 is the **documented architectural exemption** the
acceptance bar permits (rationale: claude-p is one-shot by design; native mid-turn
injection is not available without a fork). Disposition finalized in Phase 1 against
the real scenario (gate G6).

**Pre-stated consequences (do not leave to "observed behavior"):**
- **Cache shape:** abort+respawn cold-starts a new claude-p process, so the steer
  turn will ALWAYS be cache-**creation**, never read. SCENARIOS S5's row permits
  "read OR creation (note observed)"; under claude-p the answer is fixed at
  creation and SHALL be recorded as such in `SCENARIO_RESULTS.md`, not discovered.
- **No duplicated essay tail:** the respawn prompt replays pi history (which now
  contains the abandoned-essay prefix). T1.16 SHALL assert the model does NOT
  re-emit/echo the abandoned essay's tail (S5 mechanical bar).
- **Abandoned-prefix recall:** S5's coherence probe ("did I ever ask about the
  printing press?") needs the abandoned assistant prefix to be recallable — this
  shares the G5 partial-preservation requirement (D31). "Both user messages are in
  history" is necessary but NOT sufficient; the abandoned ASSISTANT prefix must
  also survive. T1.16 asserts this explicitly.

## Supersession map

| Prior decision | Status under claude-p |
|---|---|
| D1 (PTY-driven `claude` TUI) | **Superseded** by D26 (claude-p is the PTY driver) |
| D2 (node-pty) | **Superseded** by D26 (no in-house PTY dep) |
| D3 (stdio MCP shim) | **Retained** (D30) |
| D4 (transcript JSONL tail) | **Superseded** by D27 (consume claude-p stdout) |
| D5 (capture = forced MCP tool-call) | **Retained** |
| D6 (drop AskClaude) | **Retained** |
| D7-final (`--system-prompt[-file]`) | **Retained**, forwarded through claude-p (`--input-file` for size) |
| D8 (module structure) | **Modified** — `driver/{claudeP,stream}.ts` replace `driver/{pty,ansi,transcript,settings}.ts` |
| D9 (SessionStart+Stop hooks) | **Superseded** by D29 (claude-p owns hooks) |
| D10 (abort: SIGINT + Esc-Esc) | **Modified** by D31 (signal claude-p; no Esc-Esc) |
| D11 (4-layer disallow) | **Modified** by D28 (layer 1 → `--disallowedTools`) |
| D12 (hook IPC relay) | **Superseded** by D29 (no bridge hooks) |
| D13 (prompt via positional arg) | **Superseded** by D29 (claude-p positional/`--input-file`) |
| D14 (build to `dist/`) | **Retained** (still need the shim bin) |
| D15 (abort late-tool-result coherence) | **Retained** (D31) |
| D16 (capture MCP completion) | **Retained** (D30) |
| D17 (post-Stop settle window) | **Superseded** — turn-end is claude-p's `result` line (D27); there is NO settle window |
| D18 (deterministic transcript path) | **Superseded** by D27 (bridge reads no transcript) |
| D19 (shim path resolution) | **Retained** (D30) |
| D20 (shim↔router IPC) | **Retained** (D30) |
| D21 (capture authoritative source) | **Retained** (D30) |
| D22 (warm-resume transcript path) | **Superseded** by D27; warm-resume = `--resume <id>`, events from stdout |
| D23 (main-provider preserves ctx.systemPrompt) | **Retained** |
| D24 (warm-resume baseline offset) | **Superseded** by D27 (no file tailing) |
| D25 (trust-dialog scanner) | **Superseded** by D29 (claude-p owns the dialog) |

## Constitution impact (replan)

- **III (no `~/.claude/` coupling):** now satisfied *more* strongly — the bridge
  reads NOTHING under `~/.claude/` (events come from claude-p's stdout; claude-p is
  a black box that does its own transcript reading). The 2026-05-21 exemption (b)
  (deterministic-path read) becomes **DEAD** for this driver — it MUST NOT be
  exercised: the claude-p-driver spec forbids ALL `~/.claude/` reads by the bridge,
  so an implementer must not invoke exemption (b) to add a transcript read. It stays
  on the constitution's books (no re-amendment needed) but is unused here.
  **Scope note:** claude-p itself reads
  `~/.claude/projects/*.jsonl` internally — that is the black box's concern, not the
  bridge's; constitution III binds the *bridge process* only, and the task 4.2 audit
  asserts no bridge-process read/write under `~/.claude/`, not claude-p's.
- **IV (native tools disallowed):** enforced via D28 (`--disallowedTools` + isolation
  flags + shim rejection). Unchanged intent.
- **V, VI, VII:** unchanged; the driver swap preserves system-prompt fidelity,
  concurrent-path isolation (independent claude-p subprocesses), and failure-surfacing.

---

# Historical design (in-house node-pty plan — Rounds 1–5)

> Retained for provenance. Superseded where the amendment above says so.

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

**Choice (resolved by Round-1 adversarial review verification; Phase-0 T0.1+T0.8+T0.11 confirmed):** Use `claude --system-prompt <text>` for small prompts and `claude --system-prompt-file <path>` for large prompts (cold-start replays). Both replace CC's default (the file-form is undocumented in `--help` but referenced in the `--bare` description and works identically). Threshold: ~50 KB heuristic — well under the empirically-observed argv ceiling (~256 KB worked at T0.11; 250 KB had the system prompt effectively dropped due to argv truncation). The capture path passes `ctx.systemPrompt` verbatim (file or arg depending on size); the main-provider path passes pi-combined text. Constitution V is fully satisfied for the capture path; the main path retains its documented additive composition.

**Alternatives considered**
- **`--append-system-prompt`.** Documented as appending to CC's default. Unacceptable for capture path — constitution V demands verbatim.
- **Inline `--settings '{"systemPrompt": "..."}'`.** Undocumented; behavior unverified; likely interacts with `--setting-sources ""` in unspecified ways.
- **Inject system content as a first user message.** Lossy semantically. Was the fallback plan in pre-Round-1 D7; eliminated.

**Rationale:** the flag exists and documentation states the behavior we need. No fallback required.

**Phase 0 verification (T0.1 + T0.8, 2026-05-21):** PASS. Spawned `claude --system-prompt 'TOKEN_S3NT1NEL_X9K7'` in `node-pty` in INTERACTIVE mode with a project-local `CLAUDE.md` containing `BANANA_CANARY_42` directives, while the user's real `~/.claude/CLAUDE.md` was present on disk. Assistant reply was exactly `TOKEN_S3NT1NEL_X9K7` — sentinel present, CLAUDE.md canary absent. Constitution V satisfied. `--bare` escalation NOT needed.

**Phase 0 verification (T0.11, 2026-05-21):** PASS. `claude --system-prompt-file <path>` works in both `--print` and interactive modes (verified by sentinel returned verbatim from file-supplied prompt). Cold-start replays of arbitrary size are unblocked by routing through the file path.

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

### D18: Deterministic transcript path via pre-generated `--session-id` (added Round-3; corrected Phase-0 F1)

> ⚑ **SUPERSEDED — see D27 + the amendment's Constitution-impact note.** This
> decision's claim that "Constitution III was amended to add exemption (b),
> ratified by THIS change" is HISTORICAL: under claude-p the bridge reads NO
> transcript file, so exemption (b) is DEAD (must not be exercised). A
> constitution-III auditor (task 4.2) must NOT cite this decision as a live amendment.

**Choice:** Discover the transcript path WITHOUT depending on hook payload contracts. For each PTY spawn:

1. Bridge generates a UUID at spawn time via `crypto.randomUUID()`.
2. Spawn flag `--session-id <uuid>` is added (per `claude --help`: "Use a specific session ID for the conversation (must be a valid UUID)").
3. Bridge computes the transcript path: `path.join(os.homedir(), ".claude", "projects", encodeCwd(fs.realpathSync(process.cwd())), uuid + ".jsonl")` where `encodeCwd(p)` replaces `/` with `-`. **Phase 0 F1 correction (2026-05-21):** the cwd MUST be passed through `realpath` before encoding — macOS `/var/folders/...` resolves to `/private/var/folders/...` and `claude` uses the realpath-encoded form. Without `realpathSync`, the computed path will MISS the actual transcript file on macOS for any tmpdir-based cwd.
4. The transcript tailer opens the path AS SOON AS the file appears via a brief `fs.watch` on the parent directory.
5. The `SessionStart` hook is still registered (D9), but its only purpose is to confirm the model run has begun. If `SessionStart` payload happens to include `transcript_path`, the bridge asserts it matches the computed path and logs a warn-level entry if not.

**Constitution III compliance:** the bridge reads `~/.claude/projects/<encoded-realpath-cwd>/<uuid>.jsonl` where `<uuid>` is a value the bridge itself generated. **Constitution III was amended in this change (v1.0.0 → v1.1.0)** to add exemption (b): "the path was deterministically computed from a session UUID the bridge itself generated." Amendment ratified by THIS Scale-L change's adversarial-review-cycle.

**Eliminates** the Round-2 "directory-snapshot + mtime" fallback (constitution-III-violating per Round-3 B.P1#2 + race-prone per Round-3 A.P2) AND the dependency on `SessionStart` payload containing `transcript_path` (Round-2 B.P1#1).

**4-point test:** multiple-approaches? yes. lasting? yes. disagreement? minor. future-constraint? yes. → **ADR candidate Y** (4 of 4).

### D25: Workspace trust-dialog handling (added 2026-05-21 after Phase 0 T0.14)

**Choice:** The bridge implements an ANSI-aware PTY-output scanner that detects the `claude` interactive workspace-trust dialog and auto-answers it. Detection looks for the substring `Quick safety check` (or alternately `Accessing workspace:`) in ANSI-stripped PTY output for the first ~5 seconds after spawn. On detection, the scanner sends `\r` over the PTY (which selects the default "Yes, trust this project" option per current `claude` 2.1.114 layout). The scanner stops watching on first match OR after the bounded window expires OR on first transcript-file-creation event.

**Why a scanner (not a pre-trusted dir):** Trust state lives under `~/.claude/` (constitution III forbids writes). Pre-trusting a dir requires spawning `claude` there once and answering the dialog — which requires the scanner anyway. Pre-trusted-dir would only amortize scanner work, not replace it. Single mechanism covers all cases:
  - First-time pi project: scanner runs once, the user's project is then trusted by `claude`'s persistent state for all subsequent runs.
  - Capture mode (`cwd = tmpdir()`): scanner runs every call (~100–500ms latency overhead).
  - Already-trusted cwd: scanner sees nothing matching, times out silently, no harm done.

**Detection contract:**
- Strip ANSI escape sequences (CSI `\x1b\[...`, OSC `\x1b]...\x07`, 8-bit-character escapes) from PTY output via a small reusable helper in `src/driver/ansi.ts`.
- Search the stripped buffer for either trigger substring case-insensitively.
- On match: write `\r` to PTY input. Mark dialog answered.
- After 5s without a match: stop scanning, proceed normally.
- ALSO stop scanning on first transcript-file-creation event (dialog can't fire after that).

**Failure modes (per constitution VII):**
- IF the dialog fires but the scanner does NOT detect it within the window, the PTY hangs. After 30s of no transcript creation AND process still alive, the driver SHALL emit an `error` event whose `errorMessage` is `"workspace trust dialog not detected; claude TUI may have changed its boot UI"` and kill the PTY. R18 captures this.
- IF the scanner matches a FALSE POSITIVE (model output contains "Quick safety check" in the first 5s), the auto-answer keystroke goes into the PTY input buffer. Benign (model is busy producing output). The 5s window minimizes this risk; the dialog appears within ~500ms of spawn empirically.

**Test surface (Phase 4):**
- T4.9: scanner robustness — spawn `claude` in fresh tmpdir, assert detect+answer within 1s, transcript appears within 5s.
- T4.10: scanner non-interference — spawn in already-trusted cwd, assert silent timeout with no keystroke.
- T4.11: scanner failure surface — spoof a PTY stream with no dialog + no transcript, assert documented error emitted within timeout.

**Phase 0 spike re-run:** T0.14 re-attempted with scanner in place. All other Phase 0 spikes that need a live interactive `claude` either run in a pre-trusted cwd (this repo's worktree, already trusted) OR include the scanner.

**4-point test:** multiple-approaches? yes. lasting? yes. disagreement? yes. future-constraint? yes. → **ADR candidate Y** (4 of 4).

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

> ⚑ **SUPERSEDED — see D27.** This (historical) decision claims interactive mode
> emits no `result` entry and uses `stop_hook_summary` as the terminal marker. The
> claude-p spike (Exp C) showed claude-p's stdout DOES carry a terminal `result`
> line (after `stop_hook_summary`/`turn_duration`); D27 detects turn-end from
> `result`. The bridge no longer tails the transcript file or runs a settle window.
> Whether `result` is per-turn or per-segment is hard gate G3.

**Choice:** When the `Stop` hook fires, the transcript tailer does NOT close the file immediately. Instead it enters a bounded settle window (default 250ms, env-overridable via `CLAUDE_BRIDGE_TRANSCRIPT_SETTLE_MS`) during which it continues to read newly-appended lines. The window closes when either (a) the configured timeout elapses, OR (b) the tailer observes a terminal `system / stop_hook_summary` JSONL entry (Phase-0 finding: interactive mode does NOT emit a separate `result` entry as originally assumed; the `stop_hook_summary` line written AFTER the Stop hook executes is the true terminal marker). This protects against the documented race where the hook fires before the last transcript write hits disk.

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

> ⚑ **SUPERSEDED (historical) — Migration Plan, Risks, and Open Questions below
> describe the in-house node-pty plan.** The authoritative phase order, risk set,
> and gates are in the Replan Amendment at the top (G1–G9 + G-resume-flags + the
> "no SDK deletion before gates" rule) and in tasks.md/plan.md. Individual risks
> here that are moot under claude-p (R3 node-pty install, R4 fs.watch, R11 PTY boot,
> R19 spawn-helper chmod, R21 realpath-cwd, AND the transcript-coupled rows R1
> hook/transcript-schema drift, R8 mid-turn session-id, R13 transcript-file
> accumulation — the bridge reads no transcript under claude-p) no longer apply;
> claude-p-specific risks live in proposal.md "Operational risk". Provenance only.

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
| ~~R11~~ | ~~`node-pty` alone insufficient for `claude` interactive boot~~ — **RESOLVED Phase 0 T0.6 / T0.14: node-pty alone suffices. `claude` emits XTVERSION/DA/iTerm2-progress queries; none require synthetic responses for boot to proceed. Drop this risk.** |  |  |  |
| R12 | Hooks are subprocesses; per-event fork/exec latency on per-turn hooks | Low | Low | Post-Round-3 the bridge registers only TWO per-session hooks (`SessionStart`, `Stop`) — two subprocess invocations per turn, ~50–100ms each cold-start of a Node script. The high-frequency `PreToolUse` hook was dropped (per D11); `SessionEnd` was also dropped as redundant with PTY-exit + D17. Phase 4 benchmark T4.7 measures actual cold-start cost. |
| R15 | Cold-start positional argument exceeds OS argv size limit (~256 KB macOS, ~2 MB Linux) on long-history turns (Round-2 B.P1#2) | Low (most turns) / Medium (after long sessions + restart) | High | **Round-5 A.P1#2 insight**: `claude --help` shows `--system-prompt[-file]` and `--append-system-prompt[-file]`, implying `--system-prompt-file <path>` and `--append-system-prompt-file <path>` exist. These read prompt content FROM A FILE, escaping argv entirely. Phase 0 T0.11 verifies the flags exist + work in interactive mode. If verified: on argv-overflow, the bridge writes cold-start history to a per-PTY temp file in `os.tmpdir()` (permissible per constitution III — not under `~/.claude/`) and passes `--system-prompt-file <tempfile>` instead of `--system-prompt <inline>`. The positional argument carries only the new user message. File is cleaned up on PTY exit. If `--system-prompt-file` does not exist or is `--print`-only, fall back to surfacing `stopReason: "error"` (v1 hard limit; CHANGELOG documents). |
| R16 | Model-asks-itself "what tools do you have?" as a verification mechanism is non-deterministic (Round-2 A.P2#3) | High | Medium | Integration tests T1.15/T1.16 use deterministic MCP `tools/list` introspection (against the shim's advertised set) instead of model self-report. Spike T0.7 uses the same deterministic introspection. |
| R17 | Model ignores capture-mode's "end your turn now" English instruction (Round-2 A.P3#3) | Low (modern instruction-following models) | Low (D16's repeated-call -32603 limits damage) | Phase 4 benchmark T4.8 measures capture-mode termination latency distribution across N runs; if median diverges materially from "end_turn after first call", evaluate setting `max_tokens` via inline `--settings` for capture turns. |
| R18 | Trust-dialog scanner brittle to `claude` TUI redesigns (D25) — Anthropic shipping an Ink redesign changing the trust dialog wording/layout would stop detection; every fresh-trust spawn would hang until the documented timeout | Medium | High | Pin tested `claude` version range (T4.7); CI tests T4.9/T4.10/T4.11 exercise scanner against pinned binary; runtime warn on version skew; scanner failure surfaces as `stopReason: "error"` per constitution VII rather than silent hang. |
| R19 | `node-pty` 1.1.0 prebuild ships `spawn-helper` without execute bit (Phase 0 F2) — `posix_spawnp` fails until `chmod +x` is applied | High (every fresh `npm install`) | High (blocks all bridge functionality) | `package.json` `postinstall` script: `chmod +x node_modules/node-pty/prebuilds/*/spawn-helper 2>/dev/null \|\| true`. File upstream issue. Document in README. T1.2a includes the postinstall hook. |
| R20 | Interactive `claude` injects `attachment.skill_listing` regardless of `--system-prompt` (Phase 0 F4) — model sees user's global skill metadata even on capture path | Low | Low | For capture mode ALSO pass `--disable-slash-commands` (per `claude --help`). Verify in follow-up spike. Document. |
| R21 | Transcript path uses `realpath(cwd)` not lexical cwd (Phase 0 F1) — macOS `/var/folders/...` resolves to `/private/var/folders/...`; D18's original `cwd.replaceAll("/","-")` was wrong | Resolved in D18 | Was-blocker if shipped | D18 amended (see above); driver calls `fs.realpathSync(cwd)` before encoding. T0.8 transcript inspection confirmed. |
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

ALL Phase 0 OQs RESOLVED 2026-05-21. See `.spike-notes/_phase0-summary.md`.

- **OQ1 (D7):** ✓ RESOLVED — `--system-prompt` works in interactive mode; sentinel verified verbatim; CLAUDE.md does NOT leak (T0.1 + T0.8).
- **OQ7 (transcript_path):** ✓ RESOLVED per D18 + T0.12 — deterministic path `~/.claude/projects/<realpath-encoded-cwd>/<uuid>.jsonl` confirmed. `SessionStart` payload DOES include `transcript_path` in interactive mode (bonus cross-check).
- **OQ8 (cold-start prompt size):** ✓ RESOLVED — argv ceiling ~256 KB on macOS; `--system-prompt-file <path>` is the file-form escape hatch (works in both `--print` and interactive modes, sentinel verified). Bridge will switch to file-form above 50 KB heuristic.
- **OQ9 (--json-schema):** ✓ RESOLVED — flag exists; works under `--print`; interactive availability unverified but non-blocking (D5 remains forced-MCP-tool-call for v1).
- **OQ2 (fs.watch reliability):** ✓ RESOLVED — `fs.watch(parent, {recursive:true})` fires ≥5× per turn, first event @ ~400ms (T0.4).
- **OQ3 (thinking blocks):** ✓ RESOLVED — `assistant.message.content` blocks include `{type:"thinking", thinking, signature}` when `--effort high` (or higher) is set (T0.2).
- **OQ4 (session_id rotation):** ✓ RESOLVED — `session_id` STABLE across multi-turn within one PTY (T0.5). No mid-turn rotation observed.
- **OQ5 (I4):** Defining behavior for pi mid-turn cwd change — currently undefined. Recorded as outstanding risk; defer until pi adds the capability.
- **OQ6:** Concrete abort grace window in D10 — currently 3s. Tune if Phase 0/1 evidence suggests otherwise.
