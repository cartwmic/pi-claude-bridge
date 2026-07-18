## Context

<!-- authored: in-session -->

Bridge currently couples orchestration to `claude-p`: `index.ts` assembles attempts, `src/driver/claudeP.ts` owns spawn/lifecycle, `src/driver/stream.ts` decodes wrapper NDJSON, `src/capture.ts` runs isolated forced-MCP capture, and `src/resume-store.ts` persists content-free hints. Existing MCP router/shim already provides driver-independent held-open tool execution.

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

Interactive adapter preserves exact isolation contract and changes its audited denylist to include `ReportFindings` and `SendMessage`, with deterministic argv coverage plus live roster/non-execution gates. Its large/multiline static system prompt remains `--system-prompt-file`; user prompt overflow remains separate `--input-file`.

**Alternatives considered:**
- **Mode branches throughout `index.ts`/capture:** smallest initial diff, but creates cross-product conditionals and violates frozen modularity constraint.
- **Force direct output through current parser:** record schemas differ (partial stream events vs wrapper assistant/result records), causing duplicate or dropped blocks.
- **Separate provider registration:** easy switching but duplicates provider/model surface and permits accidental cross-driver session assumptions.

**Rationale:** Stable normalized seam limits driver schema drift and keeps Constitution II/VI auditable.

**4-point test:** multiple approaches yes; lasting yes; disagreement yes; constrains future drivers yes → ADR candidate Y.

### D2: Layered config resolution and invocation pinning

**Choice:** Add config loader returning validated `DriverKind`. Only `ENOENT` means an absent global/project file. Every present path uses `lstat → O_NOFOLLOW open → fstat` same-object verification on supported macOS/Linux; final-component symlink, replacement race, permission, directory-at-path, stat/read, invalid JSON/root, or invalid driver fails with layer + path before spawn. Platforms lacking race-resistant final-component no-follow fail closed rather than silently weaken config identity. Value precedence is non-empty env override, explicit caller invocation cwd project config (else pi session cwd), global config, default `claude-p`. Resolve once before replacing capture cwd with `os.tmpdir()`. Store driver on each frame/capture request; nested calls inherit active owner. In-flight tool delivery never re-resolves. Peek follows active main frame; without one it resolves current project config.

**Alternatives considered:**
- **Environment only:** existing compatibility but user selected config and project-local behavior.
- **Resolve every callback:** permits mid-turn cross-driver tool delivery.
- **Resolve from subprocess cwd:** capture tmpdir silently chooses wrong driver.

**Rationale:** Gives deterministic selection without expanding pi provider ids and honors domain invariant 3.

**4-point test:** multiple yes; lasting yes; disagreement yes; constrains config evolution yes → ADR candidate Y.

### D3: Readiness-gated direct stream-json input

**Choice:** Spawn `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages` with explicit shim config, strict/empty settings sources, permission bypass, `--tools ""`, debug file, model/system prompt, and session identity. Start shim with ready-file. Direct main/capture system prompts omit historical `WaitForMcpServers` readiness preamble because `--tools ""` removes that native tool and structural gate supersedes it; interactive `claude-p` retains its current preamble/fork gate. Wait for exact `tools/list` sentinel (default 30s; positive integer `CLAUDE_BRIDGE_MCP_READY_TIMEOUT_MS` override), then write exactly one user NDJSON frame and keep stdin open until result/abort/failure. Caller abort during readiness reaps without submission. Integration proves no generation before connected MCP init.

Multiline or >=50KB system prompts use bridge-temp `--system-prompt-file`; user history always rides stdin NDJSON. Fresh direct frame is the existing canonical cold conversion: all pi history flattened text-only, main images warn/drop, assistant tool arguments truncate to 200 characters, and tool results to 500. Validated warm frame contains only newly appended user material; it never repacks or omits prior history outside validator rules. Allocate one per-invocation temporary directory with mode `0700`; create prompt/sentinel artifacts exclusively (`O_CREAT|O_EXCL`, no-follow where platform supports) with mode `0600`; register them on driver-handle resource owner and remove in `finally` on result, readiness error, retry, abort, spawn failure, and capture completion. Never place prompt-bearing artifacts in a shared-mode temp file.

**Alternatives considered:**
- **Plain stdin/positional prompt:** spike starts generation while MCP pending and fails tools/capture.
- **Artificial sleep:** nondeterministic across host load.
- **Wait forever:** broken shim wedges before billing and violates failure surfacing.
- **Agent SDK:** different dependency/process semantics and prior architecture rejection.

**Rationale:** Reuses proven readiness channel and keeps upstream CLI as protocol owner.

**4-point test:** multiple yes; lasting yes; disagreement yes; constrains protocol yes → ADR candidate Y.

### D4: Direct stream state machine and authoritative sources

**Choice:** New parser recognizes required direct records and explicit observational allowlist. `stream_event` top-level text/thinking lifecycle emits pi blocks; complete assistant records never re-emit those blocks. Missing required partial lifecycle is protocol error because partial mode is mandatory. Complete assistant supplies final-call context usage and tool observations for D32 correlation/cross-check only. Parser admits observations into D5 only when qualified name begins `mcp__custom-tools__`; native/housekeeping/foreign observations are structured-log dropped, never counted, matched, routed, surfaced, or treated as correlation failure. Records with non-null `parent_tool_use_id` are nested observations and never top-level pi content. Router/shim is sole pi-visible tool-call execution/correlation source. Terminal result supplies cumulative usage/billing, session id, and completion subtype; pi cost remains calculated from normalized usage while reported billing is logged separately.

First top-level model `message_start` after submitted user frame marks `turnAccepted` for resume-persistence safety. Require one terminal result, consistent session identity/completion, valid block lifecycle, and final assistant usage. Result matrix is closed and fixture-backed: `success` with required result/usage/session maps normal completion; local-abort plus any late subtype maps aborted; `error_during_execution`, `error_max_turns`, `error_max_budget_usd`, and `error_max_structured_output_retries` map pi error + diagnostics + hint invalidation when not locally aborted; every other subtype or incompatible stop reason is protocol drift until deliberately added with a fixture. NDJSON decoder caps pending/single line at 8 MiB and fails with UTF-8-safe 16 KiB diagnostic excerpt before unbounded growth. Exact ignorable top-level allowlist is `system` with subtype `status` or `api_retry`, plus `rate_limit_event`; each gets retained fixture/schema guards and cannot carry content, usage, session, or completion semantics. Required `system/init`, `stream_event`, `assistant`, and `result` records follow dedicated parsers. Every other top-level type/subtype fails closed until deliberately added with fixtures. Local abort overrides all late records, including `error_during_execution` + exit zero.

**Alternatives considered:**
- **Emit complete assistant records:** duplicates already streamed partials.
- **Route stream tool_use directly:** creates second execution/correlation path.
- **Ignore unknown records:** can silently miss future completion/usage semantics.
- **Fallback to complete text without partials:** hides protocol regression under partial-required invocation.

**Rationale:** Explicit authority prevents duplication and preserves Constitution VII.

**4-point test:** multiple yes; lasting yes; disagreement yes; constrains parser evolution yes → ADR candidate Y.

### D5: Reuse router/shim correlation with driver observations

**Choice:** Keep existing IPC and held Promise model. Extend D32 observation source from claude-p records to normalized selected-driver tool observations through an explicit join coordinator:

1. `shim-first`: park request, mint pi id, emit one pi tool call, and queue canonical name/args awaiting optional model-id observation; result resolver remains keyed by that pi id for its entire lifetime.
2. `observation-first`: queue observation within current assistant tool-use batch; matching shim request consumes it and records `modelId ↔ piId` metadata before/after pi emission without changing resolver key or execution authority.
3. `identical parallel calls`: pair request and observation queues positionally only inside one assistant tool-use batch.
4. `batch-close`: assistant `message_stop` seals expected observation count but does not reject a delayed shim request. Close successfully when sealed expected count equals matched shim count; reject immediately if shim count exceeds sealed expected count; if fewer shim requests exist, wait without a new liveness timer until missing requests arrive, terminal/process failure, or caller abort. Any unmatched count at terminal/failure transitions to correlation error, drains pending resolvers, and invalidates resume.
5. `teardown`: abort/error closes coordinator idempotently; late observations/results cannot mutate settled state.

When shim request carries model id directly, correlation metadata is authoritative immediately, but pi id remains resolver key because that is the id pi returns. Alias metadata is removed with resolver on completion/abort. Each concurrent frame owns process, shim, socket, router, queues, and session state, including mixed-driver overlap.

**Alternatives considered:**
- **New direct router:** duplicated correctness-critical state.
- **Invocation-global positional matching:** later identical calls can satisfy earlier batch.
- **Best-effort mismatch logging:** resolver hangs/cross-wiring.

**Rationale:** Preserves proven held-round architecture and domain invariant 2.

**4-point test:** multiple yes; lasting yes; disagreement yes; future constraint yes → ADR candidate Y.

### D6: Driver-typed resume hints and direct version preflight

**Choice:** Add `driver` to in-memory cache and sidecar schema. Legacy missing field decodes as `claude-p`; invalid field is malformed/cold. Mismatch invalidates and cold-starts. Sidecar key/history/version rules stay unchanged. Track attempt phase `spawned → ready → promptSubmitted → turnAccepted → terminal`; `turnAccepted` requires first top-level model `message_start`, not a successful stdin write. Persist selected driver/history for non-error main completion, including direct abort only after `turnAccepted`. Abort before user-frame submission preserves prior validated hint/sidecar unchanged. Abort after submission but before acceptance invalidates that possibly mutated direct session hint/sidecar and forces next turn cold; a fresh attempt creates no hint. Thus current user history is never marked as seen before model acceptance evidence and no uncertain resumed session is reused. Direct floor >=2.1.208 is checked before child spawn; interactive path keeps independent support.

Direct resume treats successful terminal result after this submitted user frame as live. Dangling mid-tool direct resume must pass retained live integration, matching interactive repair guarantee. Missing/corrupt external session surfaces then invalidates for next cold turn; bridge never reads `~/.claude/`.

**Alternatives considered:**
- **Cross-driver resume:** currently plausible transcript compatibility but unsupported and unsafe under future schema drift.
- **Separate sidecar namespaces:** avoids field migration but duplicates files and loses explicit provenance.
- **Bridge stale-result heuristic:** reintroduces conversation authority/coupling.

**Rationale:** Typed hints make driver switches safe while preserving always-safe cold floor.

**4-point test:** multiple yes; lasting yes; disagreement yes; constrains persistence yes → ADR candidate Y.

### D7: Unified lifecycle, conservative retry, and no held-call idle cutoff

**Choice:** Both drivers run detached process groups. Caller abort transitions stream locally, commits partial, SIGINTs group, escalates after existing grace, ignores late output, and verifies descendants reaped. Direct retry is at most two retries (three total attempts) with short backoff and fresh process/shim only before first pi-visible text/thinking delta and before routed tool; every retry logs driver, attempt number, prior failure class, and new session/process identity. A failure after any user-frame submission abandons that driver session/hint; retry always uses a new session id plus full pi-canonical cold history. It never resends a warm-only delta to a possibly mutated resumed session, preventing duplicate turn and lost history. this is intentionally stricter than interactive record behavior because direct deltas cannot be retracted without duplication. No cross-driver retry.

Steering never injects a second user frame into a live direct process: shared orchestrator first performs the same local abort/partial commit and waits for old stream detachment, then starts a fresh invocation pinned to the same selected driver with updated pi history. Old/new stream events cannot interleave.

Set `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0` in both child environments. This removes upstream held-call idle cutoff but does not add bridge inference timeout. Pre-submit readiness deadline remains separate. Shim lifetime is owned by MCP stdin/IPC/process teardown, never by user-input stream closure alone.

**Alternatives considered:**
- **Retry after visible direct text:** mixes attempts in one pi message.
- **Retry after tool routing:** duplicates side effects.
- **Wall/idle watchdog:** reverses no-liveness policy.
- **Kill pid only:** can orphan shim/Claude descendants.

**Rationale:** Local lifecycle state is authoritative and side-effect safety wins over availability.

**4-point test:** multiple yes; lasting yes; disagreement yes; constrains resilience yes → ADR candidate Y.

### D8: Capture remains forced MCP through selected adapter

**Choice:** Resolve owning driver before tmpdir isolation, then run existing dedicated capture process/router/shim. Ignore partial records. Require schema-valid IPC stash plus successful terminal result; stash owns arguments, terminal metadata owns usage/completion. Normalize `input_tokens → usage.input`, `output_tokens → usage.output`, `cache_read_input_tokens → usage.cacheRead`, and `cache_creation_input_tokens → usage.cacheWrite`, then calculate pi-visible model cost exactly once. Emit only start + terminal. Missing result is error even with stash. Images warn/drop under capture's established text-only contract. No main frame/cache/hash mutation.

Static system-prompt bytes at selected-driver boundary equal caller `ctx.systemPrompt` exactly (text or `--system-prompt-file`). Remove current readiness/capture guard prepends from static system prompt. Readiness is enforced structurally by driver gate; capture forcing instructions become a bridge-owned user-prompt control suffix after replay, preserving system-prompt fidelity while keeping sole-tool behavior.

Extend capture IPC with bounded `capture-validation-failed` observation containing monotonic attempt count, first schema field path, and UTF-8-safe message truncated to 500 bytes. Shim sends it whenever capture arguments fail validation; router stores the most recent failure by attempt number alongside stash. A later valid stash suppresses earlier validation failures. Finalizer with no stash prefers most recent failure over generic absent-call error. Valid stash still requires successful terminal result, and missing/divergent stream observation emits structured warning before stash is trusted.

**Alternatives considered:**
- **`--json-schema`:** changes prompt fidelity/result mechanism.
- **Always use claude-p for capture:** violates pinned selection/equal support.
- **Trust stream tool_use arguments:** bypasses shim validation/IPC authority.

**Rationale:** One capture mechanism minimizes parity gaps and preserves Constitution V/VI.

**4-point test:** multiple yes; lasting yes; disagreement yes; constrains capture yes → ADR candidate Y.

### D9: Peek capability is explicit, diagnostics are driver-neutral

**Choice:** Adapter advertises peek support. `/claude-peek` follows active frame's pinned driver; `claude-p` uses mirror, `claude-print` reports unavailable and creates no tailer. On next resolution to print with no active interactive frame, stale overlay disposes. Diagnostics include driver/session/pid, distinct stderr/debug files, bounded surfaced stderr tail (last 20 lines, capped at 16 KiB encoded), terminal state dump, and default-on debug forwarding disabled only by `CLAUDE_BRIDGE_CLAUDE_DEBUG_FILE=0`. Diagnostic file open/write failure logs structurally but never breaks inference; premature exit with no stderr preserves base error message.

**Alternatives considered:**
- **Synthetic stream overlay:** user rejected equivalence.
- **Silent idle under print:** looks like stale/broken peek.
- **Shared diagnostics filenames:** collisions under concurrency.

**Rationale:** Makes sole parity exception explicit while preserving inference isolation.

**4-point test:** multiple yes; lasting moderate; disagreement yes; future constraint moderate → ADR candidate Y (3/4).

### D10: Validation matrix gates equal support

**Choice:** Add deterministic config/argv/parser/lifecycle/capture/resume fixtures for both schemas; real direct integrations for readiness, sequential+parallel tools, capture, abort/orphans, warm/cache/dangling resume, native roster, mixed concurrency; parameterize `SCENARIOS.md` explicit applicable inventory by driver: frozen S0–S27 matrix, required S28/S29 integration cases, required S31 large cold-start on both drivers, and S32 with driver-specific interactive-overlay versus direct-unavailable expectation. Tests cite canonical AC IDs.

Extend `openspec/opsx-gates.yaml` with required stable commands: existing `npm run typecheck`; complete unit bundle; new `npm run test:integration:drivers` (deterministic + authenticated direct protocol gates); `openspec validate "$OPSX_CHANGE" --strict`; and new `npm run test:scenarios:drivers` dual-driver TUI matrix. Live commands preflight authenticated Claude >=2.1.208 and fail explicitly rather than skip. Retain per-driver evidence paths and stop before full scenario cost when deterministic or integration tier fails.

Before matrix use, make harness itself fail closed: maintain explicit S0–S27 required inventory, convert S21 investigation into deterministic assertions (do not exclude it), make S22/any required precondition skip a nonzero gate failure, assert requested driver actually spawned in every script, and add harness fixtures proving forced scenario failure/skip propagates nonzero. S28 idle-cutoff and S29 mid-held failure run as required driver integration gates; S31 runs as required dual-driver large-prompt gate; S32 remains the sole driver-specific peek expectation.

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
| R11 | Capture forcing move weakens tool-call compliance | Medium | High | user-prompt control suffix + sole-tool surface + absent-call error; live capture gate is stop condition |
| R12 | Direct dangling resume cannot repair tool call | Medium | High | dedicated live gate; implementation cannot claim parity/complete if proof fails |

## Migration Plan

1. Promote qualifying ADR candidates during full-rigor archive; keep intent immutable.
2. Create isolated apply worktree from current integration base and record locator/diff base.
3. Land driver-neutral types/config loader and tests without changing default behavior.
4. Add direct parser/process adapter behind `driver: "claude-print"`; default remains `claude-p`.
5. Add typed sidecar field; read legacy missing field as `claude-p`; malformed/mismatch cold-starts.
6. Wire capture validation IPC, verbatim static system prompt + user control suffix, diagnostics, peek capability, idle env, and explicit interactive denylist additions `ReportFindings`/`SendMessage`. Update claude-p-driver Purpose, `openspec/domain.md`, and README from sole-interactive framing to two-driver framing while keeping claude-p adapter/fork non-print guarantees scoped.
7. Add required manifest commands, run deterministic validation, then real integrations on Claude >=2.1.208, then dual-driver TUI scenarios. Direct dangling-resume, capture fidelity/success, exact native roster, or orphan failure is a hard stop—not a waiver or reduced-parity path.
8. Rollout is additive. Operational rollback sets/removes config to `claude-p`. If shared refactor regresses interactive mode, revert change commits/reinstall prior package rather than relying on selection. New reader treats missing field as `claude-p`. Before package downgrade, first stop pi and all bridge/direct children so no writer remains; then run new idempotent maintenance command `npm run resume:quarantine-direct` under an active-store lock to atomically move every `driver:"claude-print"` or invalid sidecar into timestamped bridge-owned backup outside active resume directory, fsync directory, and verify zero active direct/invalid sidecars. Only then reinstall/revert package. Old reader may ignore additive fields only after direct hints are quarantined; first downgraded turn must prove cold. Preserve diagnostics and quarantine backup until rollback verification passes.

## Open Questions

- None. Clarify round 3 resolved all behavioral choices; implementation details stay within decisions above.
