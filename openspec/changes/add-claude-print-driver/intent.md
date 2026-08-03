# Intent: add-claude-print-driver

<!-- authored: in-session -->

## Intent

Add `claude-print` as a second, first-class inference driver beside the existing `claude-p` interactive-TUI driver. `claude-print` invokes the real Claude Code CLI through its documented non-interactive surface (`claude -p`) while preserving the bridge's current pi-canonical conversation model, held-open MCP tool execution, capture behavior, session continuity, usage/cost reporting, abort semantics, diagnostics, and scenario-level conversation coherence. `claude-print` is the default; the existing `claude-p` path remains supported as an explicit interactive rollback. Neither driver is a fallback for the other.

Users select the driver through bridge config with `"driver": "claude-p" | "claude-print"`. Project config at `<project>/.pi/claude-bridge.json` overrides global config at `~/.pi/agent/claude-bridge.json`; missing config defaults to `claude-print`. The existing `CLAUDE_BRIDGE_DRIVER` environment variable remains only as a compatibility and test override. Invalid configuration fails loudly rather than silently selecting another driver.

The direct driver is not a break-early completion wrapper. It preserves one Claude Code process per pi user turn, including all held MCP tool rounds. It uses `--input-format stream-json` and submits the user NDJSON frame only after the bridge's existing per-spawn MCP readiness sentinel proves the shim tool surface is live. Feasibility spikes against Claude Code 2.1.198 proved token-level partial streaming, a three-round held MCP sequence, forced capture through the existing shim, warm resume with cache reads, and abort-time partial preservation. The supported direct-driver version floor is Claude Code 2.1.208 because earlier versions have a documented large-stream truncation defect that can omit the terminal `result` record.

## Constraints

- Treat `claude-p` and `claude-print` as equally supported drivers. Shipping criteria apply to both; `claude-print` is not experimental after this change completes.
- Keep `claude-p` first-class as the explicit interactive rollback. Do not remove it or automatically switch drivers after failure.
- Select `claude-print` through config key `driver`; preserve the environment selector only as an override for compatibility and test harnesses.
- Resolve project config from the pi/session project cwd, not from the capture path's isolated `os.tmpdir()` spawn cwd. Capture and nested calls use the driver selected for their owning invocation.
- Pin the selected driver on each in-flight frame. A config change can affect a later fresh turn but MUST NOT change the driver handling a parked tool call or its eventual result.
- Add driver identity to in-memory session-cache state and persisted resume sidecars. A session created by one driver MUST NOT be resumed by the other. Existing sidecars without a driver field are interpreted as `claude-p` for migration compatibility.
- Keep pi as the sole conversation authority. Driver session IDs remain cache hints; history divergence, cwd changes, forks, compaction, tree navigation, driver changes, malformed sidecars, and version skew force a safe cold start.
- Implement a driver-neutral orchestration contract around process handles, normalized stream events, usage, session identity, and lifecycle. Keep driver-specific argv, stdin protocol, parser schema, and termination behavior in separate driver modules; do not add growing driver conditionals throughout `index.ts` or `src/capture.ts`.
- Invoke the direct path with `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages`. Deliver prompts as user NDJSON frames on stdin; do not use positional/plain-stdin print mode for bridge turns.
- Reuse the existing per-spawn MCP router, stdio shim, IPC protocol, and readiness sentinel. Start the direct subprocess and shim, wait until the sentinel proves `tools/list` has been served, then submit exactly one user frame for the pi turn. Never let the model generate against a pending or absent bridged tool surface.
- A bounded pre-submit MCP startup gate is permitted so readiness failure surfaces before billing; it is not an inference liveness watchdog. Once the prompt is submitted, retain the existing no-idle/no-wall-clock-watchdog policy: recovery comes from subprocess exit or caller-driven abort.
- Disable Claude Code's upstream stdio-MCP idle cutoff for bridge-held calls (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0` in child environment) so a healthy long-running pi tool is not killed by an upstream idle timer. Apply the same parity fix to both drivers.
- Preserve one direct subprocess across arbitrary sequential and parallel tool rounds. The shim/router remains authoritative for tool-call correlation and execution; direct stream `tool_use` / `input_json_delta` events are observational only.
- Use the direct stream's partial `stream_event` records for text/thinking delivery, avoiding duplicate emission from later complete `assistant` records. Use complete assistant/result records for final-call context usage, cumulative turn billing, stop reason, and session metadata.
- Treat local abort state as authoritative. Claude print mode may emit `result.subtype === "error_during_execution"` and exit zero after SIGINT; a caller-aborted turn still resolves as `aborted`, preserves already-streamed partial content, ignores late output, and reaps the process group.
- Keep the existing forced-MCP capture mechanism and IPC stash as the authoritative structured result. Do not switch capture to `--json-schema`; capture-system-prompt fidelity and main/capture state isolation remain unchanged.
- Require Claude Code >=2.1.208 only when `claude-print` is selected. Fail before a billed turn when the installed version is too old. The version floor MUST NOT block the `claude-p` path from loading or running under its independently documented tested range.
- Close the direct driver's native tool surface with the strongest available built-in control (`--tools ""`) while preserving explicitly configured MCP tools, plus defense-in-depth filtering. Keep the advertised direct-driver roster exactly equal to `mcp__custom-tools__*`.
- Re-audit the existing `claude-p` denylist against the installed Claude version. At minimum, add the newly observed `ReportFindings` and `SendMessage` built-ins, which leaked under Claude Code 2.1.198. No native tool may be routed, executed, or surfaced on either driver.
- Keep `--strict-mcp-config` and `--setting-sources ""`; never load user/project MCP servers into a bridge turn. Do not use `--bare`, because bare mode disables OAuth/keychain reads and would break Max/Pro subscription authentication.
- Preserve diagnostics parity: bridge-owned Claude debug file, per-spawn stderr capture, bounded stderr tail in surfaced premature-exit errors, abnormal-termination state dump, structured driver identity, and no diagnostic writes under `~/.claude/`.
- Preserve text-only image behavior unless separately changed: main turns warn and drop image blocks; capture follows its current documented text-only contract.
- `/claude-peek` is the sole explicit feature-parity exception. When `claude-print` is selected, the command must report that no underlying TUI exists; it must not show stale interactive-driver content or pretend a synthetic view is equivalent.
- Do not silently fall back between drivers after failure. A direct-driver failure surfaces as a direct-driver error and retains side-effect-aware retry rules; switching execution surfaces mid-turn is forbidden.
- Validate with unit fixtures for both stream schemas, real-driver integration tests, and the full pi-TUI S0-S27 scenario suite for each driver. `claude-print` may exempt only the explicitly accepted `/claude-peek` behavior. Conversation coherence, not process exit alone, remains the pass criterion.
- Scale is M with `full_rigor: true`: this is a cross-capability, ADR-worthy addition affecting driver selection, streaming, MCP readiness, lifecycle, capture, resume persistence, diagnostics, configuration, and scenario coverage.

## Invariants honored

- **Constitution I — Pi owns conversation state:** both drivers consume pi history; driver sessions remain validated cache hints. Sidecars gain only driver identity, never conversation content.
- **Constitution II — Bridge is inference-only:** Claude Code requests pi tools through MCP; pi executes them. The bridge does not execute tool business logic.
- **Constitution III — No filesystem coupling to mutable Claude state:** the bridge does not read or write `~/.claude/`; it configures and observes direct print mode through flags, stdin/stdout, bridge-owned diagnostics, and content-free sidecars.
- **Constitution IV — Native Claude tools are disallowed:** direct mode uses `--tools ""` plus defense-in-depth filtering; interactive mode's denylist is re-audited. Both paths must prove an exact MCP-only roster and native non-execution.
- **Constitution V — System prompt fidelity per path:** main-provider prompt assembly remains documented; capture forwards caller `ctx.systemPrompt` under its existing fidelity contract.
- **Constitution VI — Concurrent paths share no state:** main, capture, and nested invocations retain disjoint processes, routers, sockets, queues, and session state under either driver.
- **Constitution VII — Failures surface:** invalid config, unsupported direct-driver versions, readiness failure, protocol drift, premature exit, and missing terminal result become explicit structured errors; no silent fallback or degraded tool-less generation is allowed.
- **Domain invariant 1:** each main-provider conversation has at most one in-flight main turn; capture/nested work remains isolated.
- **Domain invariant 2:** real tool results reach the bridge only through pi's next `streamSimple()` delivery.
- **Domain invariant 3:** cwd/history/driver divergence invalidates resume hints and cold-starts safely.
- **Domain invariant 4:** native tools are neither routed, executed, nor surfaced.
- **Domain invariant 5:** driver conversion remains text-normalized and does not make pi message-shape changes architectural.

## Non-goals

- Replacing or deleting `claude-p`, or adding automatic cross-driver fallback.
- Automatic failover, load balancing, per-turn racing, or retrying a failed turn on the other driver.
- Registering a second pi provider/model namespace; driver selection remains internal to `claude-bridge`.
- Making `/claude-peek` display a synthetic print-stream overlay or adding a TUI to print mode.
- Switching capture to Claude Code's native `--json-schema` output.
- Reusing a driver session across driver kinds, even if Claude's current transcript format happens to permit it.
- Adding native Claude tool execution, permission prompts, user-global MCP servers, plugins, project settings, or `--bare` authentication changes.
- Expanding image support beyond the bridge's current text-only behavior.
- Introducing inference idle watchdogs, wall-clock turn limits, or a default unattended-batch timeout.
- Depending on `pi-claude-cli` or the Claude Agent SDK as the implementation; their break-early/process-per-tool model does not satisfy this bridge's held-open one-process-per-pi-turn parity contract.
