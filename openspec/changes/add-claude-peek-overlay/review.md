---
scale: M
full_rigor: false
# worktree_mode: (derived when absent: M ⇒ worktree-required)
execution_mode: standard
verification_mode: retained-recommended
debug_mode: standard
review_status: not-requested
delegation_mode: subagent-eligible
# code_review_mode: (derived when absent: M ⇒ gating-required)
loop_max_iterations: 40
validation_source_mode: required
spec_level: spec-anchored
doneness_mode: required
---

# Review

## Modes

| Mode | Value | Notes |
|---|---|---|
| Scale | M | Cross-repo feature (claude-p fork + bridge extension), single capability, new npm dep — typical M per schema heuristics; no cross-capability/breaking/migration traits that would demand full_rigor |
| full_rigor | false | No ADR-worthy decisions, no breaking change, no migration |
| Execution Mode | standard | |
| Verification Mode | retained-recommended | |
| Debug Mode | standard | |
| Review Status | not-requested | |
| Delegation Mode | subagent-eligible | Blind review/doneness dispatches per openspec-loop |
| Worktree Mode | derived (absent) | M ⇒ worktree-required |
| Code Review Mode | derived (absent) | M ⇒ gating-required |
| Loop Max Iterations | 40 | M authoring-time default |
| Validation Source Mode | required | tsc + unit tests + e2e tmux scenario (intent.md validation constraint) |
| Doneness Mode | required | |
| Spec Level | spec-anchored | |
| Model Config | (unset) | session model |

## Diff Base + Worktree locator

**Diff Base SHA:** <empty until apply captures it>
**Worktree Path:** <empty until apply captures it>
**Integration Branch:** main

## Manual Adjustments

- Scale M chosen per the explore session's recommendation (frozen in
  intent.md context; spike record `.spike-notes/claude-peek/CONCLUSION.md`):
  cross-repo but single-capability, no full_rigor traits.
- Delegation Mode subagent-eligible (template default single-agent): the
  openspec-loop drive requires blind subagent dispatch for gating reviews.

## Execution Notes

- 2026-07-04 — review.md authored by the loop (gate: review.md absent).

## Scope Expansions

- (none)
