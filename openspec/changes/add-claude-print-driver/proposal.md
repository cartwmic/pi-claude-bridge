## Why

<!-- authored: in-session -->

Bridge currently has one inference path: maintained `claude-p` fork drives Claude Code through headless interactive TUI. Direct `claude -p` now exposes enough streaming, session, and MCP behavior to support an equally capable second path, reducing dependence on PTY automation without replacing it. Change preserves Constitution I–IV: pi remains conversation/tool authority, Claude sessions remain cache hints, bridge never reads mutable Claude state, and native Claude tools stay closed.

## What Changes

- Add `claude-print` driver using `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages`.
- Gate user NDJSON submission on existing MCP shim readiness sentinel; retain one subprocess across held sequential/parallel tool rounds.
- Normalize direct partial events, usage, session metadata, abort result semantics, stderr/debug diagnostics, and process-group cleanup behind driver-neutral orchestration.
- Add global/project `claude-bridge.json` driver selection with project precedence, `claude-p` default, compatibility env override, invalid-value errors, and no cross-driver fallback.
- Scope in-memory resume state and persisted sidecars by driver; missing legacy driver field means `claude-p`.
- Run output capture through selected driver while retaining forced-MCP capture and isolated tmpdir execution.
- Close direct native tools with `--tools ""`; re-audit interactive denylist for `ReportFindings` and `SendMessage`; disable upstream MCP held-call idle cutoff on both paths.
- Require Claude Code >=2.1.208 only for `claude-print` and fail before billing on older versions.
- Make `/claude-peek` explicitly unavailable under `claude-print`; this is sole accepted feature-parity exception.
- Add dual-driver unit/integration/TUI validation and driver-aware diagnostics/documentation.
- No public default or provider/model identifier changes; no automatic failover; no `claude-p` removal.

## Capabilities

### New Capabilities

- `bridge-driver-selection`: Config precedence, frame pinning, version policy, driver-scoped resume identity, and no-fallback guarantees.
- `claude-print-driver`: Direct CLI argv/stdin protocol, readiness-gated submission, normalized stream/lifecycle behavior, held MCP rounds, native isolation, and abort semantics.

### Modified Capabilities

- `claude-p-driver`: Keep interactive path first-class while closing newly observed native tools and disabling upstream MCP idle cutoff.
- `mcp-stdio-shim`: Define shim/readiness behavior for either selected inference driver rather than only `claude-p`.
- `output-capture`: Execute forced-MCP capture through selected driver with unchanged isolation and stash contract.
- `warm-pi-resume`: Persist and validate driver identity; forbid cross-driver resume while accepting legacy sidecars as `claude-p`.
- `driver-diagnostics`: Require equivalent stderr, debug-file, state-dump, and driver-identity visibility for both drivers.
- `claude-peek-overlay`: Report explicit unsupported state for `claude-print` and never display stale interactive content.
- `scenario-coverage`: Require equivalent main/capture/resume/abort/tool-round scenario evidence for both drivers, excluding accepted peek difference.

## Impact

- **Provider surface:** same `claude-bridge/*` models; config adds `driver: "claude-p" | "claude-print"`.
- **Runtime:** new direct subprocess driver/parser; shared orchestration and existing router/shim/capture/resume modules become driver-neutral.
- **Persistence:** content-free warm-resume sidecar gains driver field with legacy migration behavior.
- **Dependencies:** no new runtime package required; direct path resolves authenticated `claude` from PATH.
- **Compatibility:** `claude-p` remains default and keeps its independent version support; direct mode requires Claude Code 2.1.208+.
- **Affected files:** `index.ts`, `src/driver/**`, `src/capture.ts`, `src/mcp/**`, `src/resume.ts`, `src/peek/**`, tests, scenario scripts, README, domain/spec artifacts, and project validation manifest.
- **Affects which projects:** this repository only; maintained `claude-p` fork needs no new feature for direct path.
