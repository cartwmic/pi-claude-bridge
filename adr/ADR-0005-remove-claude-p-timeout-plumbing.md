# ADR-0005: Remove claude-p timeout plumbing

**Status:** Accepted
**Date:** 2026-06-16
**Source change:** `openspec/changes/no-liveness-timeouts-add-visibility/`
**Supersedes:** None
**Superseded by:** None

## Context

The bridge previously had `CLAUDE_BRIDGE_CLAUDE_P_TIMEOUT_SECONDS` plumbing that could emit `claude-p --timeout`. The default had already moved to no cap, but the knob remained as a public liveness lever. A wall-clock timeout counts time spent while pi tools are held open, so it can kill a healthy turn parked on a long-running tool or human-in-the-loop action.

The owner principle for this change is no liveness or wedge timeouts. Unattended-batch ceilings belong outside the bridge and should cancel through pi's abort signal. This is a breaking change because the public timeout knob and config fields are removed.

4-point score: multiple viable approaches yes; lasting consequences yes; disagreement potential yes; future constraints yes = **4/4**.

## Decision Drivers

- Prevent bridge-side wall-clock caps from killing healthy held tool rounds.
- Remove public timeout knobs that contradict no-liveness-timeouts.
- Keep recovery policy caller-driven through `AbortSignal`.
- Preserve resilience retry for real subprocess exits.
- Avoid maintaining timeout config fields whose approved value is absent.

## Considered Options

### Option A: Remove timeout plumbing entirely

Delete `CLAUDE_P_TIMEOUT_SECONDS`, `timeoutSeconds` config fields, and `--timeout` argument emission so `claude-p` runs without a bridge-supplied wall cap.

**Pros:**
- Fully enforces no bridge-side wall-clock liveness cap.
- Removes a known held-tool failure mode.
- Simplifies argument assembly and capture/main dependency threading.

**Cons:**
- Operators lose the bridge-provided timeout knob.
- External supervisors must enforce ceilings by aborting pi turns.

### Option B: Keep the knob default-undefined

Leave timeout plumbing available but do not emit `--timeout` by default.

**Pros:**
- Keeps compatibility for operators who set the env var.
- Provides a simple rollback if no-timeout behavior causes operational issues.

**Cons:**
- Still exposes a liveness lever that can kill healthy parked tools.
- Preserves code and docs for a behavior the owner principle rejects.

### Option C: Compute a very large timeout

Derive a wall cap larger than expected tool latency and boot overhead.

**Pros:**
- Gives some protection against unattended hangs.
- Reduces false positives compared with short caps.

**Cons:**
- Still guesses liveness from elapsed wall time.
- Cannot know future human/subagent/tool latency safely.
- Keeps timeout policy inside the bridge instead of the caller/supervisor.

## Decision Outcome

**Chosen option:** Option A: Remove timeout plumbing entirely

**Rationale:** A wall-clock timeout is the same class of liveness heuristic as the watchdog. Because tool rounds may be intentionally parked for unbounded time, bridge-owned wall caps are unsafe; callers that need ceilings must abort explicitly.

## Consequences

**Positive:**
- Held tool rounds cannot be killed by `claude-p --timeout` from the bridge.
- Main and capture paths share the same no-timeout contract.
- Config/docs no longer advertise a contradictory timeout control.

**Negative:**
- Existing users of `CLAUDE_BRIDGE_CLAUDE_P_TIMEOUT_SECONDS` must move timeout policy to an external supervisor.
- No bridge-local wall cap remains for a no-exit hang.

**Neutral:**
- `SessionStartTimeout`/`StopTimeout` emitted by `claude-p` itself still count as real driver errors when they occur.
- Abort still performs SIGINT then grace-period SIGKILL of the process group.

## Links

- Source design discussion: `openspec/changes/no-liveness-timeouts-add-visibility/design.md` (Decision D3)
- Related ADRs: ADR-0003, ADR-0004
- External references: None

---

<!--
IMMUTABILITY RULE: once this ADR is Accepted, do not edit the body. To
change a decision, create a new ADR and mark this one Superseded with
Superseded-by link → new ADR.

MADR 4.0 short form — see https://adr.github.io/madr/
-->
