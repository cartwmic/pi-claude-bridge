# Clarify Findings

<!-- authored: in-session -->

Three-pass delta-spec review. All questions resolved autonomously from frozen intent, constitution/domain, live spike evidence, and safest fail-loud interpretation. Advisory choices bind design/tasks without changing frozen intent.

## Pass 1 — Ambiguity (semantic-entropy lite)

| # | AC ref | Question | Option A (keep/resolve) | Option B (alternative) | Status | Resolution |
|---|---|---|---|---|---|---|
| A1 | bridge-driver-selection.selected-driver-is-pinned-to-invocation-lifecycle | Which cwd resolves standalone capture driver? | Explicit caller invocation cwd, else pi session project cwd | Always pi session cwd | answered | A — caller invocation cwd is owning project input; temp spawn cwd never participates |
| A2 | claude-peek-overlay.overlay-toggle-command | Which driver does peek follow during an in-flight pinned turn after config edit? | Active frame's pinned driver; new config only when no active frame | New config immediately disposes live mirror | answered | A — live pinned TUI is not stale; frame pinning wins until turn ends |
| A3 | claude-p-driver.claude-p-spawn-with-model-selection | Which flag carries large system prompt? | `--system-prompt-file` | Reuse user-prompt `--input-file` | answered | A — separate channels prevent payload collision |
| A4 | claude-print-driver.direct-print-invocation-uses-bidirectional-stream-protocol | What cold-start conversion applies? | Existing bridge text flattening, image policy, and 200/500-char tool truncations | Implementation-defined direct conversion | answered | A — pi-canonical replay parity |
| A5 | bridge-driver-selection.driver-selection-uses-layered-bridge-configuration | How are non-object JSON config roots handled? | Reject as invalid | Treat as missing `driver` | answered | A — fail loud |
| A6 | claude-print-driver.partial-stream-is-normalized-without-duplication | What if complete assistant content lacks expected partial lifecycle? | Protocol error for text/thinking because partial mode is mandatory | Emit complete record as fallback | answered | A — clean direct schema fails closed; avoids ambiguous duplication |
| A7 | claude-print-driver.direct-protocol-drift-surfaces-explicitly | Which unknown records may be ignored? | Explicit observational allowlist; all others fail as drift | Ignore any unrecognized well-formed record | answered | A — Constitution VII fail-loud behavior |
| A8 | warm-pi-resume.driver-guarantees-a-live-resume-result-no-bridge-side-stale-guard | What proves direct resume result is live? | Successful terminal result after this readiness-gated submitted user frame | Add bridge freshness heuristic | answered | A — trust documented direct turn boundary; bridge remains stateless |
| A9 | claude-print-driver.direct-native-tool-surface-is-closed | What is defense-in-depth beyond `--tools ""`? | Bridge-side native non-routing/drop + exact roster check | Additional direct denylist required | answered | A — direct strong closure plus Constitution IV enforcement |
| A10 | mcp-stdio-shim.shim-readiness-proves-exact-tool-availability | Does evidence clause delay readiness? | No; readiness remains first successful exact `tools/list`; evidence proves later ordering | Redefine readiness post-submit | answered | A — preserves proven sentinel protocol |

## Pass 2 — Inconsistency (pairwise antecedent overlap)

| # | AC pair | Shared antecedent | Conflict on output | Option A (resolve) | Option B | Status | Resolution |
|---|---|---|---|---|---|---|---|
| I1 | claude-p-driver.image-content-handling-in-v1 × output-capture image warning | capture contains image | reject vs warn/drop/proceed | Warn/drop/proceed for both drivers | Reject capture | answered | A — output-capture owns capture semantics; reconciles pre-existing conflict |
| I2 | claude-peek-overlay overlay toggle × interactive behavior | interactive overlay shown | toggle-time vs continuous focus | Preserve focus continuously while shown | Only at toggle | answered | A — existing UX invariant remains |
| I3 | direct retry × interactive retry record | failure after visible text, before tool | direct stops; interactive may retry | Document direct stricter rule due immediate partial delivery | Force false stream-model parity | answered | A — no duplicate visible direct attempt; external safety wins |
| I4 | driver diagnostics × spawn argv | debug forwarding disabled | mandatory argv vs disable escape hatch | Default-on; omit only for documented disable env | Always mandatory | answered | A — preserves existing operator escape hatch |
| I5 | direct concurrency × interactive concurrency | mixed drivers overlap | direct-only isolation wording | Same disjoint state guarantees cover mixed-driver overlap | Forbid overlap | answered | A — driver-neutral orchestration |
| I6 | shim D32 correlation × identical calls | repeated identical calls | unbounded positional pairing | Batch closes at completed assistant tool-use batch; then reconcile counts | Invocation-global pairing | answered | A — prevents later-call cross-wiring |

## Pass 3 — Completeness (priority-bounded enumeration)

| # | Combination | Question | Option A (resolve) | Option B | Status | Resolution |
|---|---|---|---|---|---|---|
| C1 | direct abort mid-tool × warm resume | Required direct evidence? | Retain live resume repair/closure scenario | Rely on generic cold fallback | answered | A — equal resume parity |
| C2 | direct pre-submit readiness × caller abort | What outcome? | Abort, reap process/shim, never submit/bill | Generic later abort only | answered | A — caller abort authoritative at every phase |
| C3 | sidecar × invalid driver field | How handled? | Malformed hint; invalidate and cold-start | Treat as mismatch only | answered | A — fail safe |
| C4 | direct version floor × process spawn | When reject? | Before child spawn | Any time before prompt submission | answered | A — no unnecessary process/readiness work |
| C5 | direct system prompt × argv boundary | File threshold? | Multiline always file; default 50 KB threshold | Unspecified threshold | answered | A — deterministic parity with established boundary |
| C6 | diagnostics stderr tail × pathological line | What cap? | Fixed line count and encoded-byte cap | Line count only | answered | A — genuinely bounded surfaced error |
| C7 | direct capture × valid stash × missing result | Success or error? | Error; stash authoritative only after successful terminal completion | Success with zero usage | answered | A — terminal contract remains mandatory |
| C8 | direct terminal result × recognized error subtype | Mapping? | `stopReason:error`, surfaced message, diagnostics, hint invalidation | Protocol error or implementation-defined | answered | A — distinguish valid inference error from schema drift |
| C9 | direct readiness × startup bound | Concrete envelope? | Default 30s, validated positive env override, spawn→ready interval | Implementation-defined bound | answered | A — pre-billing failure is deterministic; no post-submit timeout |
| C10 | direct retry × transient pre-output failure | Concrete envelope? | At most two retries, short backoff, fresh process/shim | Any finite bound | answered | A — matches existing resilience envelope |

## Outstanding (status != answered)

- None.

## Review Provenance

- Round 1 at `8e6e71fc2bc71260e050a1dbaa9abd60417aa499`: fail/fail/fail; max P0=0, P1=17, P2=4, P3=7.
- Round 2 at `92d39851b5d3883238cc77b108a72ab1c3c8025e`: pass/fail/fail; max P0=0, P1=10, P2=7, P3=6.
- Round 3 at `f73bc6e5745953dc40cd8b6bdb5cdfd29c960b14`: pass/pass/pass; max P0=0, P1=0, P2=9, P3=4 — quiet round, sealed READY.
- Invalid attempts (no round-budget count): one timeout with two missing findings files; one cursor-provider `EPIPE` with one missing findings file. All counted verdicts came exclusively from attested findings files; every read-only window remained unchanged.

## Summary

- Pass 1 findings: 10; unanswered: 0; deferred: 0
- Pass 2 findings: 6; unanswered: 0; deferred: 0
- Pass 3 findings: 10; unanswered: 0; deferred: 0
- **Gate status:** READY for design
