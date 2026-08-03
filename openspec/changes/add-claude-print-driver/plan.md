# Execution Plan

<!-- authored: in-session -->

> Follow-up: after this original additive rollout completed its dual-driver gates, the owner authorized promoting `claude-print` to the implicit default. Historical step ordering below still records the initial safe bring-up.

## Plan step 1: Layered configuration and direct preflight

- **Covers:** T1.1
- **Pre-conditions:** isolated apply worktree; baseline `npm run typecheck` and config-related units green.
- **Action (5-step micro-tasks):**
  1. Add failing `tests/unit-driver-config.mjs` cases for ACs `bridge-driver-selection.driver-selection-uses-layered-bridge-configuration` and `bridge-driver-selection.direct-driver-enforces-independent-version-floor`, including non-object/unreadable/symlink paths and pre-spawn version rejection.
  2. Run targeted test → expect missing loader/preflight failures.
  3. Implement minimal validated loader, precedence, project-cwd resolution, race-resistant regular-file open, default, and memoized Claude version probe.
  4. Run targeted test + `npm run typecheck` → expect PASS.
  5. Commit `feat: add bridge driver configuration`.
- **Verification:** `node --import tsx --test tests/unit-driver-config.mjs`; `npm run typecheck`.
- **Rollback:** revert step commit; default import path remains old `claude-p` behavior.

## Plan step 2: Driver-neutral adapter seam

- **Covers:** T1.2
- **Pre-conditions:** step 1 committed; initial bring-up default config resolves `claude-p`.
- **Action (5-step micro-tasks):**
  1. Add failing adapter contract/regression cases citing `claude-p-driver.claude-p-spawn-with-model-selection` and `bridge-driver-selection.selected-driver-is-pinned-to-invocation-lifecycle`.
  2. Run targeted existing/new adapter tests → expect FAIL at missing seam.
  3. Extract shared types/adapter selection and wrap existing driver without changing argv/events/lifecycle.
  4. Run `unit-driver-claude-p`, stream, resilience, capture, and typecheck → expect PASS.
  5. Commit `refactor: introduce inference driver adapter`.
- **Verification:** `node --import tsx --test tests/unit-driver-claude-p.mjs tests/unit-driver-stream.mjs tests/unit-driver-resilience.mjs`; `npm run typecheck`.
- **Rollback:** revert seam commit; no persistence migration has landed yet.

## Plan step 3: Driver-typed resume and rollback quarantine

- **Covers:** T1.3
- **Pre-conditions:** driver kind exists and frame selection is injectable.
- **Action (5-step micro-tasks):**
  1. Add failing resume-store/gate tests for typed hints, legacy decode, cross-driver cold start, pre-submit/pre-accept abort boundaries, submitted retry invalidation, and quarantine crash/idempotency ACs under `warm-pi-resume`.
  2. Run targeted resume tests → expect FAIL.
  3. Implement additive sidecar/cache type, phase-safe writes, invalidation, active-store lock, quarantine script, and package command.
  4. Run resume tests, quarantine rehearsal, and typecheck → expect PASS.
  5. Commit `feat: type resume hints by driver`.
- **Verification:** `node --import tsx --test tests/unit-resume-store.mjs tests/unit-warm-resume-gate.mjs tests/unit-warm-resume-roundtrip.mjs`; quarantine script fixture command.
- **Rollback:** stop test processes; revert commit; remove only test-owned resume directory.

## Plan step 4: Direct stream decoder

- **Covers:** T2.1
- **Pre-conditions:** adapter event contract committed; retained spike schemas available only as reference.
- **Action (5-step micro-tasks):**
  1. Add failing fixture matrix in `tests/unit-claude-print-stream.mjs` for ACs `claude-print-driver.partial-stream-is-normalized-without-duplication`, `direct-protocol-drift-surfaces-explicitly`, and `direct-usage-and-session-metadata-are-authoritative`.
  2. Run targeted parser test → expect FAIL.
  3. Implement byte-bounded NDJSON decoder, exact type/subtype matrix, partial block state, nested/native filtering, usage/result authority, and abort precedence.
  4. Run direct + interactive stream tests and typecheck → expect PASS with no interactive regression.
  5. Commit `feat: decode claude print streams`.
- **Verification:** direct parser test; `tests/unit-driver-stream.mjs`; `tests/unit-usage-context.mjs`; typecheck.
- **Rollback:** revert parser commit; no direct process path selectable yet.

## Plan step 5: Direct process adapter and readiness gate

- **Covers:** T2.2
- **Pre-conditions:** direct parser exists; config floor/adapter seam committed.
- **Action (5-step micro-tasks):**
  1. Add failing spawn/argv/temp/readiness/abort fixture tests for `claude-print-driver.direct-print-invocation-uses-bidirectional-stream-protocol`, `prompt-submission-waits-for-exact-mcp-readiness`, and native closure ACs.
  2. Run targeted tests → expect FAIL.
  3. Implement direct detached process, private artifacts, exact argv/env, shim sentinel wait, one user NDJSON frame/backpressure, cleanup, and normalized handle.
  4. Run direct-driver units + typecheck → expect PASS; assert no billed/live invocation in unit tier.
  5. Commit `feat: add claude print process driver`.
- **Verification:** `tests/unit-claude-print-driver.mjs`; driver stderr/abort units; typecheck.
- **Rollback:** revert commit; selector continues using the initial interactive bring-up default.

## Plan step 6: Router/shim two-channel correlation and capture validation IPC

- **Covers:** T2.3
- **Pre-conditions:** direct tool observations normalize without execution.
- **Action (5-step micro-tasks):**
  1. Add failing observation-first, shim-first, identical-parallel, delayed-under-count, mismatch-drain, native-drop, readiness, and validation-failure IPC cases citing `mcp-stdio-shim.*` and capture invalid-arguments AC.
  2. Run MCP unit tests → expect FAIL.
  3. Implement stable pi-id resolver/alias coordinator, batch seal rules, bridged-only admission, teardown, exact ready signal, and bounded validation evidence.
  4. Run router/shim/IPC/capture units + typecheck → expect PASS.
  5. Commit `feat: correlate driver tool observations`.
- **Verification:** `tests/unit-mcp-router.mjs`, `unit-mcp-shim.mjs`, `unit-mcp-ipc.mjs`, capture units.
- **Rollback:** revert coordinator commit as one unit; retain prior router implementation.

## Plan step 7: Shared main-turn direct orchestration

- **Covers:** T2.4
- **Pre-conditions:** direct process + parser + router correlation green in isolation.
- **Action (5-step micro-tasks):**
  1. Add failing main-turn tests for held sequential/parallel rounds, cold/warm frame construction, submitted warm retry cold-repack, abort partial, steering detachment, images, no fallback, and mixed isolation ACs.
  2. Run targeted orchestration tests → expect FAIL.
  3. Wire pinned selected adapter through fresh/tool-result/retry/abort/steer paths with same-driver one-process lifecycle and no watchdog.
  4. Run main/abort/resilience/warm/tool units + typecheck → expect PASS.
  5. Commit `feat: route main turns through selected driver`.
- **Verification:** complete unit bundle subset for abort, resilience, cold/warm prompts, thinking/usage, late tool results.
- **Rollback:** revert orchestration commit; direct selection must fail explicitly rather than silently fallback.

## Plan step 8: Selected-driver capture parity

- **Covers:** T3.1
- **Pre-conditions:** both adapters support isolated capture spawn and readiness.
- **Action (5-step micro-tasks):**
  1. Add failing selected-driver capture tests covering every `output-capture` delta AC, especially verbatim system bytes, interactive `--mcp-ready-file`, direct readiness, image warn/drop, validation path, terminal-result requirement, and partial suppression.
  2. Run capture tests → expect FAIL.
  3. Refactor capture to pinned adapter, preserve classification/strict shape/isolation, move control text to user suffix, normalize terminal usage, and clean all resources.
  4. Run all capture units + typecheck → expect PASS for both drivers.
  5. Commit `feat: run capture through selected driver`.
- **Verification:** `tests/unit-capture.mjs`, output-capture shape/cleaner tests, prompt fidelity fixtures.
- **Rollback:** revert capture commit; no partial mixed capture state persists.

## Plan step 9: Diagnostics, native hardening, and peek capability

- **Covers:** T3.2
- **Pre-conditions:** driver handles expose identity/capability and shared lifecycle events.
- **Action (5-step micro-tasks):**
  1. Add failing diagnostics/native/peek tests citing all `driver-diagnostics` and `claude-peek-overlay` ACs plus interactive denylist/idle ACs.
  2. Run targeted tests → expect FAIL.
  3. Add driver identity/artifact names/tails/state dumps/debug escape hatch, child idle env, denylist additions, native drop, and capability-aware peek disposal/unavailability.
  4. Run diagnostics, disallow, peek, and typecheck tests → expect PASS.
  5. Commit `feat: add dual-driver diagnostics and peek policy`.
- **Verification:** driver stderr/version/disallow tests; all peek tests; typecheck.
- **Rollback:** revert commit; preserve diagnostics files as evidence.

## Plan step 10: Complete deterministic regression suite

- **Covers:** T4.1
- **Pre-conditions:** all production slices above committed.
- **Action (5-step micro-tasks):**
  1. Enumerate uncovered canonical AC IDs and add failing unit/fixture cases, including temp crash cleanup, config FIFO/race, timer overflow, rollback quarantine, parser chunk boundaries, and harness failure propagation.
  2. Run `npm run test:unit` → expect at least one new failing case before fixes.
  3. Apply only minimal fixes within task contract until full deterministic suite covers both schemas.
  4. Run `npm run typecheck`, `npm run test:unit`, and build → expect PASS.
  5. Commit `test: complete dual-driver unit coverage`.
- **Verification:** typecheck, unit, build all zero; AC-to-test inventory generated.
- **Rollback:** revert test/fix commit; do not proceed to billed integrations.

## Plan step 11: Authenticated driver integration gates

- **Covers:** T4.2
- **Pre-conditions:** deterministic tier green; authenticated Claude binary >=2.1.208 available; no unrelated live processes from prior tests.
- **Action (5-step micro-tasks):**
  1. Add integration assertions and command wiring for readiness, exact roster/non-execution, held tools, capture, resume/cache/dangling, abort/orphans, mixed concurrency, S28/S29; initially expect missing command/gates to fail.
  2. Run preflight/selected smallest integration → expect FAIL before complete harness.
  3. Implement `test:integration:drivers`, fail-not-skip preflight, evidence retention, and any integration-exposed minimal defects.
  4. Run command → expect PASS for required matrix; inspect no orphan processes and retained evidence.
  5. Commit `test: add live driver integration matrix`.
- **Verification:** `npm run test:integration:drivers`; process descendant scan; evidence files.
- **Rollback:** abort live children, preserve diagnostics, revert harness/fixes; never weaken a hard stop.

## Plan step 12: Fail-closed dual-driver TUI scenario matrix

- **Covers:** T4.3
- **Pre-conditions:** integration gate green; scenario sandbox available; billing budget follows deterministic-first stop order.
- **Action (5-step micro-tasks):**
  1. Add forced-failure/skip/driver-mismatch harness tests and explicit inventory; expect existing S21/S22/S31/S32 orchestration gaps to fail.
  2. Run harness tests only → expect FAIL.
  3. Convert S21 assertions, make skips fail, assert spawned driver, backfill catalog, wire S0–S27 + S31 dual runs and S32 path-specific expectation.
  4. Run `npm run test:scenarios:drivers` → expect conversation-coherent PASS with retained transcripts/evidence.
  5. Commit `test: add dual-driver TUI scenarios`.
- **Verification:** harness self-tests + full scenario command; no pass from exit-only/investigation scripts.
- **Rollback:** stop scenario sessions, preserve outputs, revert harness commit.

## Plan step 13: Two-driver documentation and source-of-record sync

- **Covers:** T5.1
- **Pre-conditions:** final behavior/commands proven by tests.
- **Action (5-step micro-tasks):**
  1. Add doc/source-of-record assertions or grep checks for stale sole-driver/SDK framing and required config/operator keys; expect FAIL.
  2. Run doc checks → expect stale references.
  3. Update README, domain entities, current specs/context, SCENARIOS catalog, config/version/peek/diagnostics/rollback docs.
  4. Run strict OpenSpec validation + doc checks → expect PASS.
  5. Commit `docs: document both bridge drivers`.
- **Verification:** `openspec validate --specs --strict`; change strict validation; stale-term sweep.
- **Rollback:** revert docs commit; do not archive with stale source of record.

## Plan step 14: Required manifest gates and final retained evidence

- **Covers:** T5.2
- **Pre-conditions:** all prior tasks committed and commands green.
- **Action (5-step micro-tasks):**
  1. Add failing manifest contract check for required typecheck/unit/OpenSpec/integration/scenario ids and fail-closed ordering.
  2. Run gate contract → expect missing entries.
  3. Extend `openspec/opsx-gates.yaml`, use `$OPSX_CHANGE`, and retain final command evidence without hard-coded archived path.
  4. Run every required validation and `opsx gate add-claude-print-driver --worktree <path>` → expect no validation GATE-FAIL.
  5. Commit `ci: require dual-driver validation gates`.
- **Verification:** all completion commands below and clean worktree diff against immutable base.
- **Rollback:** revert manifest commit if command portability fails; keep implementation unarchived.

## Completion Verification

- `npm run typecheck` → exit 0.
- `npm run build` → exit 0.
- `npm run test:unit` → all tests pass.
- `npm run test:integration:drivers` → all required authenticated gates pass; no skips/orphans.
- `npm run test:scenarios:drivers` → both drivers conversation-coherent; only direct peek behavior differs.
- `openspec validate add-claude-print-driver --strict` → valid.
- `openspec validate --specs --strict` → all specs valid.
- `opsx gate add-claude-print-driver --worktree <recorded-path>` → no `GATE-FAIL`.

## Manual Adjustments

- Execution mode is `tdd-preferred`; every implementation step still uses fail→minimal fix→pass because driver lifecycle/protocol risk warrants TDD even though schema does not mandate it.
- Live validation cannot be skipped or downgraded when Claude/auth/version preconditions fail; unavailable precondition is a hard stop.
- `opsx_dispatch` reported no armed loop despite arm-generation context during proposal review. Exact configured models were launched as parallel blind `pi --no-session` host fallback; this incident and provenance are retained in review/fidelity artifacts.
- Original five-round review budget was extended to eight under owner's explicit autonomous drive-to-green instruction; no human fidelity waiver was used.
