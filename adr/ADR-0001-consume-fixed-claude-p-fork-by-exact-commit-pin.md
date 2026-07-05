# ADR-0001: Consume the fixed claude-p fork by exact commit pin

**Status:** Accepted
**Date:** 2026-06-16
**Source change:** `openspec/changes/claude-p-paste-fix-guard/`
**Supersedes:** None
**Superseded by:** None

## Context

The root-cause spike for `claude-p-paste-fix-guard` proved that generated single-line prompts up to 800 bytes pass, while prompts of 801 bytes or more fail with `claude-p: PromptNotAccepted`. The raw PTY probe showed Ink rendering `[Pastedtext#1]` plus `paste again to expand`, so the old literal echo-confirmation path missed a prompt that had been accepted into the input widget.

The fix exists in the `cartwmic/claude-p` fork at commit `f47f71dfa34593a32cb911f617f9cf8ca1fa0073`. The bridge must consume that fixed driver while preserving the pi/bridge split: pi owns conversation state, the bridge stays inference-only, and native Claude tools remain disallowed.

## Decision Drivers

- Fix the bug at the actual failure boundary: claude-p echo confirmation.
- Keep bridge prompt-building, retry, timeout, native-tool policy, and persistent-state behavior unchanged.
- Preserve reproducible dependency resolution through `package.json` and `package-lock.json`.
- Avoid vendoring a local binary that would make future fork sync and install verification harder.
- Preserve Constitution III/IV boundaries: no new writes under `~/.claude/`, and existing disallow flags remain forwarded.

## Considered Options

### Option A: Exact npm git commit pin

Update `claude-p` from `b24e3827a5c10ce5475578e4130ead74024d8b30` to `f47f71dfa34593a32cb911f617f9cf8ca1fa0073` in `package.json` and refresh `package-lock.json` with `npm install`.

**Pros:**
- Consumes the fixed echo-confirmation implementation directly.
- Keeps bridge code unchanged.
- Leaves npm lockfile evidence for the resolved fork commit.
- Maintains normal install/update workflow.

**Cons:**
- Continues relying on npm git dependency resolution and fork build prerequisites.
- Future updates require approving and pinning a later fork commit.

### Option B: Patch bridge retry logic

Add bridge-side retry behavior around prompt acceptance failure.

**Pros:**
- Would stay within this repository.
- Could improve resilience for some transient driver failures.

**Cons:**
- Does not fix the deterministic claude-p echo-confirmation miss.
- Could leave accepted paste-collapse prompts rejected by the driver.
- Changes bridge behavior outside the proven failure boundary.

### Option C: Vendor a local claude-p binary

Check in or otherwise ship a local fixed claude-p binary.

**Pros:**
- Avoids npm git resolution at runtime/install time.
- Can directly control the executable bytes.

**Cons:**
- Bypasses package-lock resolution evidence.
- Makes future fork sync harder.
- Adds binary distribution and verification burden to this repo.

## Decision Outcome

**Chosen option:** Option A: Exact npm git commit pin

**Rationale:** The bug lives in claude-p echo confirmation, not bridge orchestration. Exact npm git pinning consumes the fixed fork at the commit that recognizes the normalized Ink paste-collapse marker, keeps the bridge implementation unchanged, and gives reproducible lockfile evidence.

## Consequences

**Positive:**
- Large paste-collapse prompts can be accepted by the fixed claude-p driver.
- Bridge behavior envelope stays unchanged.
- Install verification can inspect the resolved package and commit.

**Negative:**
- Future claude-p updates must deliberately move the pin to a later approved fork commit.
- npm git install remains part of dependency setup and can fail if fork build prerequisites are unavailable.

**Neutral:**
- The driver remains the interactive TUI path; this decision does not change model invocation architecture.

## Links

- Source design discussion: `openspec/changes/claude-p-paste-fix-guard/design.md` (Decision D1)
- Related ADRs: None
- External references: `github.com/cartwmic/claude-p` commit `f47f71dfa34593a32cb911f617f9cf8ca1fa0073`

---

<!--
IMMUTABILITY RULE: once this ADR is Accepted, do not edit the body. To
change a decision, create a new ADR and mark this one Superseded with
Superseded-by link → new ADR.

MADR 4.0 short form — see https://adr.github.io/madr/
-->
