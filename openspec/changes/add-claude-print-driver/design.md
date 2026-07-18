## Context

<!-- authored: in-session -->

Bridge currently couples orchestration to `claude-p`: `index.ts` assembles attempts, `src/driver/claudeP.ts` owns spawn/lifecycle, `src/driver/stream.ts` decodes wrapper NDJSON, `src/capture.ts` runs isolated forced-MCP capture, and `src/resume.ts` persists content-free hints. Existing MCP router/shim already provides driver-independent held-open tool execution.

Real spikes proved direct Claude print mode can preserve one process across sequential tool rounds, capture through existing shim, warm resume/cache reads, partial streaming, and abort partials. Plain prompt submission raced MCP (`system/init` pending); stream-json input plus existing shim readiness sentinel produced connected exact tools. Direct path therefore needs a distinct process/protocol adapter, not a break-early wrapper.

Constitution I keeps pi canonical and permits only content-free typed sidecar metadata; II keeps tools in pi; III forbids bridge access to mutable Claude files; IV requires exact MCP-only tools; VI requires per-invocation state isolation; VII requires config/protocol/process failures to surface. Domain invariants keep one main turn, pi-delivered results, safe cold floor, no native routing, and text-normalized history.

## Goals / Non-Goals

**Goals:**
- Add equally supported `claude-print` while retaining default `claude-p`.
- Keep one shared orchestration path with separate argv/stdin/parser/lifecycle adapters.
- Preserve all main, held-tool, capture, resume, abort, concurrency, usage, diagnostics, and coherence behavior except accepted peek unavailability.
- Make config, protocol drift, version skew, and process failures deterministic and explicit.
- Keep direct model generation behind exact MCP readiness.

**Non-Goals:**
- Replacing/removing `claude-p`, changing provider ids, or automatic fallback.
- Agent SDK / `pi-claude-cli` break-early process-per-tool architecture.
- Native Claude tools, user MCP servers/settings, `--bare`, or direct JSON-schema capture.
- Synthetic peek UI, new image transport, conversation persistence, or post-submit watchdogs.

## Decisions

### D1: Driver-neutral orchestration with separate adapters

**Choice:** Introduce `DriverKind = "claude-p" | "claude-print"` and an `InferenceDriver` contract consumed by shared turn/capture orchestration. Contract owns runtime preflight, attempt spawn, normalized events, abort, cleanup, and capabilities (`peek`). `claudeP` and new `claudePrint` modules keep driver-specific argv/protocol/parser state. Shared retry, router/frame, usage-to-pi, capture classification, sidecar, and logging code receives driver identity explicitly.

**Alternatives considered:**
- **Mode branches throughout `index.ts`/capture:** smallest initial diff, but creates cross-product conditionals and violates frozen modularity constraint.
- **Force direct output through current parser:** record schemas differ (partial stream events vs wrapper assistant/result records), causing duplicate or dropped blocks.
- **Separate provider registration:** easy switching but duplicates provider/model surface and permits accidental cross-driver session assumptions.

**Rationale:** Stable normalized seam limits driver schema drift and keeps Constitution II/VI auditable.

**4-point test:** multiple approaches yes; lasting yes; disagreement yes; constrains future drivers yes → ADR candidate Y.

### D2: Layered config resolution and invocation pinning

**Choice:** Add config loader returning validated `DriverKind`. Parse every present global/project file as object; invalid JSON/root/driver fails. Value precedence is non-empty env override, explicit caller invocation cwd project config (else pi session cwd), global config, default `claude-p`. Resolve once before replacing capture cwd with `os.tmpdir()`. Store driver on each frame/capture request; nested calls inherit active owner. In-flight tool delivery never re-resolves. Peek follows active main frame; without one it resolves current project config.

**Alternatives considered:**
- **Environment only:** existing compatibility but user selected config and project-local behavior.
- **Resolve every callback:** permits mid-turn cross-driver tool delivery.
- **Resolve from subprocess cwd:** capture tmpdir silently chooses wrong driver.

**Rationale:** Gives deterministic selection without expanding pi provider ids and honors domain invariant 3.

**4-point test:** multiple yes; lasting yes; disagreement yes; constrains config evolution yes → ADR candidate Y.

### D3: Readiness-gated direct stream-json input

**Choice:** Spawn `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages` with explicit shim config, strict/empty settings sources, permission bypass, `--tools ""`, debug file, model/system prompt, and session identity. Start shim with ready-file. Wait for exact `tools/list` sentinel (default 30s; documented positive env override), then write exactly one user NDJSON frame and keep stdin open until result/abort/failure. Caller abort during readiness reaps without submission. Integration proves no generation before connected MCP init.

Multiline or >=50KB system prompts use bridge-temp `--system-prompt-file`; user history always rides stdin NDJSON. Temp files and sentinel clean on every exit.

**Alternatives considered:**
- **Plain stdin/positional prompt:** spike starts generation while MCP pending and fails tools/capture.
- **Artificial sleep:** nondeterministic across host load.
- **Wait forever:** broken shim wedges before billing and violates failure surfacing.
- **Agent SDK:** different dependency/process semantics and prior architecture rejection.

**Rationale:** Reuses proven readiness channel and keeps upstream CLI as protocol owner.

**4-point test:** multiple yes; lasting yes; disagreement yes; constrains protocol yes → ADR candidate Y.

### D4: Direct stream state machine and authoritative sources

**Choice:** New parser recognizes required direct records and explicit observational allowlist. `stream_event` top-level text/thinking lifecycle emits pi blocks; complete assistant records never re-emit those blocks. Missing required partial lifecycle is protocol error because partial mode is mandatory. Complete assistant supplies final-call context usage and tool observations for D32 correlation/cross-check only. Router/shim is sole pi-visible tool-call execution/correlation source. Terminal result supplies cumulative usage/billing, session id, and completion subtype; pi cost remains calculated from normalized usage while reported billing is logged separately.

Require one terminal result, consistent session identity/completion, valid block lifecycle, and final assistant usage. Recognized non-abort error subtype maps to pi error and hint invalidation. Unknown records outside allowlist fail closed. Local abort overrides all late records, including `error_during_execution` + exit zero.

**Alternatives considered:**
- **Emit complete assistant records:** duplicates already streamed partials.
- **Route stream tool_use directly:** creates second execution/correlation path.
- **Ignore unknown records:** can silently miss future completion/usage semantics.
- **Fallback to complete text without partials:** hides protocol regression under partial-required invocation.

**Rationale:** Explicit authority prevents duplication and preserves Constitution VII.

**4-point test:** multiple yes; lasting yes; disagreement yes; constrains parser evolution yes → ADR candidate Y.

### D5: Reuse router/shim correlation with driver observations

**Choice:** Keep existing IPC and held Promise model. Extend D32 observation source from claude-p records to normalized selected-driver tool observations. Pair by authoritative model id when available, else name + canonical arguments; identical calls pair in completed assistant tool-use-batch order. Count mismatch fails invocation, drains safely, invalidates resume. Each concurrent frame owns process, shim, socket, router, queues, and session state, including mixed-driver overlap.

**Alternatives considered:**
- **New direct router:** duplicated correctness-critical state.
- **Invocation-global positional matching:** later identical calls can satisfy earlier batch.
- **Best-effort mismatch logging:** resolver hangs/cross-wiring.

**Rationale:** Preserves proven held-round architecture and domain invariant 2.

**4-point test:** multiple yes; lasting yes; disagreement yes; future constraint yes → ADR candidate Y.

### D6: Driver-typed resume hints and direct version preflight

**Choice:** Add `driver` to in-memory cache and sidecar schema. Legacy missing field decodes as `claude-p`; invalid field is malformed/cold. Mismatch invalidates and cold-starts. Sidecar key/history/version rules stay unchanged. Persist selected driver for non-error main completion including abort. Direct floor >=2.1.208 is checked before child spawn; interactive path keeps independent support.

Direct resume treats successful terminal result after this submitted user frame as live. Dangling mid-tool direct resume must pass retained live integration, matching interactive repair guarantee. Missing/corrupt external session surfaces then invalidates for next cold turn; bridge never reads `~/.claude/`.

**Alternatives considered:**
- **Cross-driver resume:** currently plausible transcript compatibility but unsupported and unsafe under future schema drift.
- **Separate sidecar namespaces:** avoids field migration but duplicates files and loses explicit provenance.
- **Bridge stale-result heuristic:** reintroduces conversation authority/coupling.

**Rationale:** Typed hints make driver switches safe while preserving always-safe cold floor.

**4-point test:** multiple yes; lasting yes; disagreement yes; constrains persistence yes → ADR candidate Y.

### D7: Unified lifecycle, conservative retry, and no held-call idle cutoff

**Choice:** Both drivers run detached process groups. Caller abort transitions stream locally, commits partial, SIGINTs group, escalates after existing grace, ignores late output, and verifies descendants reaped. Direct retry is at most two attempts with short backoff and fresh process/shim only before first pi-visible text/thinking delta and before routed tool; this is intentionally stricter than interactive record behavior because direct deltas cannot be retracted without duplication. No cross-driver retry.

Set `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0` in both child environments. This removes upstream held-call idle cutoff but does not add bridge inference timeout. Pre-submit readiness deadline remains separate.

**Alternatives considered:**
- **Retry after visible direct text:** mixes attempts in one pi message.
- **Retry after tool routing:** duplicates side effects.
- **Wall/idle watchdog:** reverses no-liveness policy.
- **Kill pid only:** can orphan shim/Claude descendants.

**Rationale:** Local lifecycle state is authoritative and side-effect safety wins over availability.

**4-point test:** multiple yes; lasting yes; disagreement yes; constrains resilience yes → ADR candidate Y.

### D8: Capture remains forced MCP through selected adapter

**Choice:** Resolve owning driver before tmpdir isolation, then run existing dedicated capture process/router/shim. Ignore partial records. Require schema-valid IPC stash plus successful terminal result; stash owns arguments, terminal metadata owns usage/completion. Emit only start + terminal. Missing result is error even with stash. Images warn/drop under capture's established text-only contract. No main frame/cache/hash mutation.

**Alternatives considered:**
- **`--json-schema`:** changes prompt fidelity/result mechanism.
- **Always use claude-p for capture:** violates pinned selection/equal support.
- **Trust stream tool_use arguments:** bypasses shim validation/IPC authority.

**Rationale:** One capture mechanism minimizes parity gaps and preserves Constitution V/VI.

**4-point test:** multiple yes; lasting yes; disagreement yes; constrains capture yes → ADR candidate Y.

### D9: Peek capability is explicit, diagnostics are driver-neutral

**Choice:** Adapter advertises peek support. `/claude-peek` follows active frame's pinned driver; `claude-p` uses mirror, `claude-print` reports unavailable and creates no tailer. On next resolution to print with no active interactive frame, stale overlay disposes. Diagnostics include driver/session/pid, distinct stderr/debug files, bounded stderr ring (20 lines plus encoded-byte cap), terminal state dump, and default-on debug forwarding disabled only by existing env escape hatch.

**Alternatives considered:**
- **Synthetic stream overlay:** user rejected equivalence.
- **Silent idle under print:** looks like stale/broken peek.
- **Shared diagnostics filenames:** collisions under concurrency.

**Rationale:** Makes sole parity exception explicit while preserving inference isolation.

**4-point test:** multiple yes; lasting moderate; disagreement yes; future constraint moderate → ADR candidate Y (3/4).

### D10: Validation matrix gates equal support

**Choice:** Add deterministic config/argv/parser/lifecycle/capture/resume fixtures for both schemas; real direct integrations for readiness, sequential+parallel tools, capture, abort/orphans, warm/cache/dangling resume, native roster, mixed concurrency; parameterize `SCENARIOS.md` applicable S0–S27 by driver with only direct peek-unavailable expectation. Validation manifest runs typecheck, unit/integration, strict OpenSpec, and dual-driver scenario bundle. Tests cite canonical AC IDs.

**Alternatives considered:**
- **Unit-only:** cannot prove CLI/MCP/process semantics.
- **Live-only:** costly/nondeterministic and weak edge coverage.
- **Partial scenario subset:** contradicts equal-supported choice.

**Rationale:** Conversation coherence, not process exit, is shipping evidence.

**4-point test:** multiple yes; lasting yes; disagreement low; constrains future yes → ADR candidate Y (3/4).

## Risks / Trade-offs

| # | Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|---|
| R1 | Claude stream schema changes | Medium | High | explicit allowlist, fixtures, version floor, fail-loud parser |
| R2 | MCP readiness race returns | Low | High | sentinel before submit + connected-order integration |
| R3 | Native built-ins appear after upgrade | Medium | High | direct `--tools ""`, interactive audited denylist, live exact-roster gate |
| R4 | Cross-driver resume/session contamination | Low | High | typed cache/sidecar + frame pinning + cold mismatch |
| R5 | Abort leaves descendants | Medium | High | process-group SIGINT/SIGKILL + orphan integration |
| R6 | Live dual-driver suite cost/flakes | Medium | Medium | deterministic fixtures first, bounded retries only in harness, retained evidence |
| R7 | Installed Claude below 2.1.208 | High initially | Medium | pre-spawn clear error; interactive default remains usable; update environment before live direct gate |
| R8 | Config errors block despite env override | Low | Medium | intentional fail-loud all-present-file validation, clear path/error logs |
| R9 | Output-capture spec compression loses behavior | Low | High | implementation tests preserve mapping/truncation/event ordering; analyze fidelity sweep |
| R10 | Existing user worktree changes contaminate loop | Medium | High | apply only in isolated `opsx/add-claude-print-driver` worktree; path-scoped integration commits |

## Migration Plan

1. Promote qualifying ADR candidates during full-rigor archive; keep intent immutable.
2. Create isolated apply worktree from current integration base and record locator/diff base.
3. Land driver-neutral types/config loader and tests without changing default behavior.
4. Add direct parser/process adapter behind `driver: "claude-print"`; default remains `claude-p`.
5. Add typed sidecar field; read legacy missing field as `claude-p`; malformed/mismatch cold-starts.
6. Wire capture, diagnostics, peek capability, idle env, and interactive denylist update.
7. Run deterministic validation, then real integrations on Claude >=2.1.208, then dual-driver TUI scenarios.
8. Rollout is additive. Rollback sets/removes config to `claude-p`; no data migration rollback needed. Direct sidecars cold-start safely when driver mismatches.

## Open Questions

- None. Clarify round 3 resolved all behavioral choices; implementation details stay within decisions above.
