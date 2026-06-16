## Context

The root-cause spike in `.spike-notes/claude-p-gate/promptnotaccepted-rootcause-2026-06-16T02-29-11-767Z/CONCLUSION.md` proved the failure boundary: generated single-line prompts up to 800 bytes pass, while 801+ byte prompts fail 5/5 with `claude-p: PromptNotAccepted`. The raw PTY probe showed Ink renders `[Pastedtext#1]` plus `paste again to expand` after CSI stripping, so literal echo confirmation missed a prompt that was accepted into the input widget. The fixed fork commit `f47f71dfa34593a32cb911f617f9cf8ca1fa0073` recognizes that normalized paste-collapse marker.

The bridge must consume that fixed driver while preserving the domain split: pi owns conversation state, the bridge remains inference-only, and native tools stay disallowed. Constitution VII also requires the prior failure to surface loudly; S31 proves the corrected path completes instead.

## Goals / Non-Goals

**Goals:**
- Resolve the bridge dependency pin to fixed claude-p commit `f47f71dfa34593a32cb911f617f9cf8ca1fa0073`.
- Add a live scenario whose first cold-start prompt exceeds the 801-byte paste-collapse threshold and proves model-level delivery with a sentinel response.
- Document the regression class and validation evidence in the OpenSpec change.

**Non-Goals:**
- Modify bridge prompt-building, retry, timeout, native-tool policy, or persistent state behavior.
- Re-implement the claude-p echo-confirm patch in this repository.
- Push commits or archive the change.

## Decisions

### D1: Consume the fixed claude-p fork by exact commit pin

**Choice:** Update `claude-p` from `b24e3827a5c10ce5475578e4130ead74024d8b30` to `f47f71dfa34593a32cb911f617f9cf8ca1fa0073` in `package.json` and refresh `package-lock.json` through `npm install`.

**Alternatives considered:**
- **Patch bridge retry logic:** would not fix a deterministic single-spawn echo-confirm miss and would leave the driver rejecting accepted paste-collapse prompts.
- **Vendor a local claude-p binary:** would bypass npm resolution evidence and make future fork sync harder.

**Rationale:** The bug lives in claude-p echo confirmation. Exact npm git pin gives reproducible installation and keeps the bridge code unchanged.

**4-point test:** multiple approaches yes; lasting dependency consequence yes; reasonable disagreement low; future constraint low → ADR candidate N.

### D2: Add S31 as a live cold-start scenario, not a unit-only fixture

**Choice:** Create `scripts/run-scenario-s31-large-cold-start-prompt.sh` using `scenario-lib.sh`, `pi --no-session`, an opus model default, a >1500 byte first prompt, bridge-log mechanical assertions, and `scn_assert_response` positive/negative coherence checks.

**Alternatives considered:**
- **Unit-test only:** could prove string matching but not the tmux → pi → bridge → claude-p → Ink → model chain.
- **Warm-resume large prompt:** would not cover the first-turn cold-start path that failed before any session cache existed.

**Rationale:** Existing scenario prompts top out at 236 bytes, far below the 801-byte threshold. The missing acceptance evidence is live end-to-end delivery on the first prompt.

**4-point test:** multiple approaches yes; lasting consequence yes; reasonable disagreement low; future constraint low → ADR candidate N.

### D3: Use sentinel echo as coherence proof

**Choice:** The first large prompt embeds a unique sentinel and instructs the model to reply with exactly that sentinel. S31 asserts the response contains the sentinel and does not contain prompt-delivery disclaimers.

**Alternatives considered:**
- **Only assert no `PromptNotAccepted`:** mechanical pass could still miss a dropped or wrong prompt.
- **Ask a broad comprehension question:** more model variance and harder regex.

**Rationale:** Sentinel echo gives a tight positive proof that the large prompt reached the model, matching the scenario charter's coherence bar.

**4-point test:** multiple approaches yes; lasting consequence low; reasonable disagreement low; future constraint no → ADR candidate N.

## Risks / Trade-offs

| # | Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|---|
| R1 | Live S31 can fail from transient Claude boot/network issues | Medium | Medium | Retry once; scenario keeps log evidence in `.test-output/scenarios/` |
| R2 | Opus default increases scenario runtime/cost | Medium | Low | Respect `SCENARIO_MODEL`; pin opus only for reliability and document override |
| R3 | npm git install build can fail if Zig is absent | Low | Medium | Validate `npm install`; task context states Zig 0.15.2 is on PATH |

## Migration Plan

1. Commit OpenSpec artifacts for `claude-p-paste-fix-guard`.
2. Update npm pin and run `npm install` to rebuild `node_modules/claude-p` from the fixed fork ref.
3. Add S31 script, override, and SCENARIOS entry.
4. Run unit tests and live S31.
5. Write `verify.md` and commit validation artifacts.

Rollback: revert the pin and scenario commits. The bridge then returns to the prior vulnerable dependency and S31 documents the expected failing regression.

## Open Questions

- None. Owner pre-approved Scale M, spec-anchored mode, exact pin, S31 behavior, validation commands, and no-push boundary.
