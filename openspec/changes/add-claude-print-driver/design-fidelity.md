# Design Fidelity

**Fidelity:** delivered

**Judge Provenance:** claude-bridge/claude-fable-5 + openai-codex/gpt-5.6-sol + cursor/cursor-grok-4.5 via pi host fallback after opsx_dispatch refused unarmed runtime; review_mode: adversarial-multimodel
**Attested HEAD:** d701c827b737e221e0642a5506b2f54b1987ce3d
**Attested Path:** /Volumes/Workshop/git/pi-claude-bridge

**Digest sha256 (intent.md):** 49ea499f343b9a31915687cf67c31acd80d4251da6bf9b49e4c1bf7399735f16
**Digest sha256 (design.md):** 2e4aa7a5f98b1017d33454391e27c2f10f5cf24e264c69955ef7c312a2210dd1
**Digest sha256 (specs/bridge-driver-selection/spec.md):** e12b1d1dd29e629145449fdfdf80c9dcd714dd57b29df95ccff4f5fea66d77b4
**Digest sha256 (specs/claude-p-driver/spec.md):** b025f6294e3273a3568f3c4a500ac836feedadf12a6be9eaf2ad6385f933e075
**Digest sha256 (specs/claude-peek-overlay/spec.md):** 3553bd2cbce88f76fb2ee6a4381210e281a4cf01a84c89d7a4f32ddf54bb124d
**Digest sha256 (specs/claude-print-driver/spec.md):** a27d32faeb6796d36403c0cf9623464a2efb542415286ef48baf75229c7a19c2
**Digest sha256 (specs/driver-diagnostics/spec.md):** 8ceaf8adc1131ea6939ba0fd291aa6942b9dc8da7d8f6a7c21910df96bcab97f
**Digest sha256 (specs/mcp-stdio-shim/spec.md):** e2d34849db87a848d7ed90fcc863bddd9a974a0f1f9054d79b65a94b2cd0f667
**Digest sha256 (specs/output-capture/spec.md):** e6c4c155e585b2b34b212d239523658765040e2e409c3cdd163600710d83f0b1
**Digest sha256 (specs/scenario-coverage/spec.md):** e7f46564d74f62931ea0dc21d60e2bddfbd35a2457d0152c9ee0037eda0655c3
**Digest sha256 (specs/warm-pi-resume/spec.md):** 968a0738f33a269693da0ac714d1faecf37cf8d0ebd897dfc98ade37527a23e6

## Per-AC verdict table

| # | Capability / Requirement / Scenario (AC key) | Verdict | Evidence (design section) |
|---|---|---|---|
| 1 | bridge-driver-selection / Driver Selection Uses Layered Bridge Configuration / Environment override wins | entailed | D2 |
| 2 | bridge-driver-selection / Driver Selection Uses Layered Bridge Configuration / Project config selects direct driver | entailed | D2 |
| 3 | bridge-driver-selection / Driver Selection Uses Layered Bridge Configuration / Project config omits driver | entailed | D2 |
| 4 | bridge-driver-selection / Driver Selection Uses Layered Bridge Configuration / Existing default remains interactive | entailed | D2 |
| 5 | bridge-driver-selection / Driver Selection Uses Layered Bridge Configuration / Malformed or invalid configuration fails loud | entailed | D2 |
| 6 | bridge-driver-selection / Selected Driver Is Pinned To Invocation Lifecycle / Config changes during held tool call | entailed | D2/D8 |
| 7 | bridge-driver-selection / Selected Driver Is Pinned To Invocation Lifecycle / Capture follows owning selection | entailed | D2/D8 |
| 8 | bridge-driver-selection / Selected Driver Is Pinned To Invocation Lifecycle / Standalone capture resolves project before isolation | entailed | D2/D8 |
| 9 | bridge-driver-selection / Selected Driver Is Pinned To Invocation Lifecycle / Nested invocation follows owner | entailed | D2/D8 |
| 10 | bridge-driver-selection / In-Memory Session Hints Are Driver Typed / Same-process driver switch | entailed | D6 |
| 11 | bridge-driver-selection / Driver Failures Never Trigger Cross-Driver Fallback / Direct driver exits before result | entailed | D2/D7 |
| 12 | bridge-driver-selection / Direct Driver Enforces Independent Version Floor / Unsupported direct version | entailed | D6 |
| 13 | bridge-driver-selection / Direct Driver Enforces Independent Version Floor / Interactive path remains independently supported | entailed | D6 |
| 14 | claude-p-driver / claude-p spawn with model selection / Fresh turn spawns one claude-p subprocess with bridged tool surface | entailed | D1/D3 |
| 15 | claude-p-driver / claude-p spawn with model selection / User-global MCP server isolated from interactive driver | entailed | D1/D3 |
| 16 | claude-p-driver / claude-p spawn with model selection / User permissions cannot re-enable disallowed native tool | entailed | D1/D3 |
| 17 | claude-p-driver / claude-p spawn with model selection / Direct selection does not spawn interactive driver | entailed | D1/D3 |
| 18 | claude-p-driver / Native tool emission is blocked via `--disallowedTools` / Current native set is closed | entailed | D1/D4/D10 |
| 19 | claude-p-driver / Native tool emission is blocked via `--disallowedTools` / Built-in housekeeping is not surfaced | entailed | D1/D4/D10 |
| 20 | claude-p-driver / Native tool emission is blocked via `--disallowedTools` / Native refusal is verified beyond roster introspection | entailed | D1/D4/D10 |
| 21 | claude-p-driver / Image content handling in v1 / Main interactive turn with image | entailed | D3/D8 |
| 22 | claude-p-driver / Image content handling in v1 / Interactive capture with image | entailed | D3/D8 |
| 23 | claude-p-driver / Interactive Held Calls Have No Upstream Idle Cutoff / Tool exceeds upstream idle default | entailed | D7 |
| 24 | claude-peek-overlay / Overlay Toggle Command / Toggle on in interactive mode | entailed | D9 |
| 25 | claude-peek-overlay / Overlay Toggle Command / Toggle off in interactive mode | entailed | D9 |
| 26 | claude-peek-overlay / Overlay Toggle Command / Prompt submits while interactive overlay open | entailed | D9 |
| 27 | claude-peek-overlay / Overlay Toggle Command / Command in direct mode | entailed | D9 |
| 28 | claude-peek-overlay / Overlay Toggle Command / Driver switches while overlay open | entailed | D9 |
| 29 | claude-peek-overlay / Peek Follows Latest Main-Turn Spawn Only / Retarget on new interactive turn | entailed | D9 |
| 30 | claude-peek-overlay / Peek Follows Latest Main-Turn Spawn Only / Direct main turn excluded | entailed | D9 |
| 31 | claude-peek-overlay / Peek Follows Latest Main-Turn Spawn Only / Capture path excluded | entailed | D9 |
| 32 | claude-peek-overlay / Peek Explicitly Rejects Non-TUI Driver / Direct-mode peek | entailed | D9 |
| 33 | claude-peek-overlay / Interactive Peek Behavior Remains Available / Interactive main turn | entailed | D9 |
| 34 | claude-print-driver / Direct Print Invocation Uses Bidirectional Stream Protocol / Fresh direct invocation | entailed | D3/D4 |
| 35 | claude-print-driver / Direct Print Invocation Uses Bidirectional Stream Protocol / Private temporary prompt artifacts | entailed | D3/D4 |
| 36 | claude-print-driver / Direct Print Invocation Uses Bidirectional Stream Protocol / Warm direct invocation | entailed | D3/D4 |
| 37 | claude-print-driver / Prompt Submission Waits For Exact MCP Readiness / Readiness precedes prompt | entailed | D3/D4 |
| 38 | claude-print-driver / Prompt Submission Waits For Exact MCP Readiness / Readiness never arrives | entailed | D3/D4 |
| 39 | claude-print-driver / Prompt Submission Waits For Exact MCP Readiness / Caller aborts before readiness | entailed | D3/D4 |
| 40 | claude-print-driver / Direct Native Tool Surface Is Closed / MCP tools survive native closure | entailed | D3/D4 |
| 41 | claude-print-driver / Direct Native Tool Surface Is Closed / User configuration cannot widen surface | entailed | D3/D4 |
| 42 | claude-print-driver / Partial Stream Is Normalized Without Duplication / Text and thinking deltas | entailed | D4 |
| 43 | claude-print-driver / Partial Stream Is Normalized Without Duplication / Tool observations arrive | entailed | D4 |
| 44 | claude-print-driver / Partial Stream Is Normalized Without Duplication / Nested records arrive | entailed | D4 |
| 45 | claude-print-driver / Direct Protocol Drift Surfaces Explicitly / Malformed stream line | entailed | D4 |
| 46 | claude-print-driver / Direct Protocol Drift Surfaces Explicitly / Allowlisted observational record | entailed | D4 |
| 47 | claude-print-driver / One Direct Process Spans Held Tool Rounds / Three sequential held calls | entailed | D5 |
| 48 | claude-print-driver / One Direct Process Spans Held Tool Rounds / Parallel held calls | entailed | D5 |
| 49 | claude-print-driver / Direct Usage And Session Metadata Are Authoritative / Multi-round terminal accounting | entailed | D4 |
| 50 | claude-print-driver / Direct Usage And Session Metadata Are Authoritative / Terminal result missing | entailed | D4 |
| 51 | claude-print-driver / Direct Abort Preserves Partial And Reaps Process Group / Claude reports error after SIGINT | entailed | D7 |
| 52 | claude-print-driver / Direct Abort Preserves Partial And Reaps Process Group / Process ignores graceful signal | entailed | D7 |
| 53 | claude-print-driver / Direct Failure And Retry Preserve Side-Effect Safety / Pre-output transient exit | entailed | D7 |
| 54 | claude-print-driver / Direct Failure And Retry Preserve Side-Effect Safety / Warm attempt fails after submission but before visible output | entailed | D7 |
| 55 | claude-print-driver / Direct Failure And Retry Preserve Side-Effect Safety / Failure after visible output or routed tool | entailed | D7 |
| 56 | claude-print-driver / Direct Driver Has No Inference Liveness Timeout / Long healthy held tool | entailed | D7 |
| 57 | claude-print-driver / Direct Concurrent Invocations Are Isolated / Nested and capture overlap main | entailed | D5/D7 |
| 58 | claude-print-driver / Direct Image Behavior Matches Bridge Contract / Main image input | entailed | D3/D8 |
| 59 | claude-print-driver / Direct Image Behavior Matches Bridge Contract / Capture image input | entailed | D3/D8 |
| 60 | claude-print-driver / Direct Steering Uses Abort And Fresh Dispatch / Mid-stream steer | entailed | D7 |
| 61 | claude-print-driver / Direct Driver Avoids Mutable Claude Filesystem Coupling / Direct warm resume | entailed | D3/D6 |
| 62 | driver-diagnostics / Child stderr is captured to a per-spawn debug file / Selected-driver stderr persisted | entailed | D9 |
| 63 | driver-diagnostics / Child stderr is captured to a per-spawn debug file / stderr capture write fails | entailed | D9 |
| 64 | driver-diagnostics / Premature-exit error surfaces the last stderr lines / Premature exit with stderr | entailed | D9 |
| 65 | driver-diagnostics / Premature-exit error surfaces the last stderr lines / Premature exit without stderr | entailed | D9 |
| 66 | driver-diagnostics / In-flight state dump on abnormal termination / Abort emits selected-driver state dump | entailed | D9 |
| 67 | driver-diagnostics / In-flight state dump on abnormal termination / Premature exit emits selected-driver state dump | entailed | D9 |
| 68 | driver-diagnostics / claude debug logging is forwarded to a bridge-owned file / Debug flag emitted | entailed | D9 |
| 69 | driver-diagnostics / claude debug logging is forwarded to a bridge-owned file / Debug forwarding disabled | entailed | D9 |
| 70 | driver-diagnostics / Diagnostics Identify Selected Driver / Concurrent driver diagnostics | entailed | D9 |
| 71 | mcp-stdio-shim / Shim lifecycle is bound to its spawn / Selected driver exits | entailed | D7 |
| 72 | mcp-stdio-shim / Shim lifecycle is bound to its spawn / Direct user-input stream does not own shim lifetime | entailed | D7 |
| 73 | mcp-stdio-shim / Tool-call correlation across the split channels (D32) / Interactive correlation | entailed | D5 |
| 74 | mcp-stdio-shim / Tool-call correlation across the split channels (D32) / Direct correlation | entailed | D5 |
| 75 | mcp-stdio-shim / Tool-call correlation across the split channels (D32) / Parallel identical calls | entailed | D5 |
| 76 | mcp-stdio-shim / Shim readiness proves exact tool availability / Readiness signal follows exact tools list | entailed | D3/D5 |
| 77 | mcp-stdio-shim / Shim readiness proves exact tool availability / List never succeeds | entailed | D3/D5 |
| 78 | output-capture / Output-capture classification of `ctx.tools` / All tools are pi-registered | entailed | D2/D8 |
| 79 | output-capture / Output-capture classification of `ctx.tools` / One unregistered tool, no others | entailed | D2/D8 |
| 80 | output-capture / Output-capture classification of `ctx.tools` / Registered-but-inactive tool | entailed | D2/D8 |
| 81 | output-capture / Output-capture classification of `ctx.tools` / Tool-result delivery | entailed | D2/D8 |
| 82 | output-capture / Output-capture classification of `ctx.tools` / Empty tools | entailed | D2/D8 |
| 83 | output-capture / Strict call-shape — capture mode mutually exclusive with executable tools, root must be object / Two capture tools rejected | entailed | D2/D8 |
| 84 | output-capture / Strict call-shape — capture mode mutually exclusive with executable tools, root must be object / Capture plus executable rejected | entailed | D2/D8 |
| 85 | output-capture / Strict call-shape — capture mode mutually exclusive with executable tools, root must be object / Non-object root rejected | entailed | D2/D8 |
| 86 | output-capture / Strict call-shape — capture mode mutually exclusive with executable tools, root must be object / Object-root capture accepted | entailed | D2/D8 |
| 87 | output-capture / Capture path isolation / Capture concurrent with active main turn | entailed | D2/D8 |
| 88 | output-capture / Capture path isolation / Capture session does not pollute cache | entailed | D2/D8 |
| 89 | output-capture / Capture path isolation / Capture does not pollute message hashes | entailed | D2/D8 |
| 90 | output-capture / Synthesized `toolCall` content block on success / Successful capture | entailed | D8 |
| 91 | output-capture / Synthesized `toolCall` content block on success / Stash present but observed stream divergent | entailed | D8 |
| 92 | output-capture / Synthesized `toolCall` content block on success / Stash present but terminal result missing | entailed | D8 |
| 93 | output-capture / Synthesized `toolCall` content block on success / Caller receives direct-provider shape | entailed | D8 |
| 94 | output-capture / Surface absent capture-tool call as error / Text only | entailed | D8 |
| 95 | output-capture / Surface absent capture-tool call as error / Invalid arguments only | entailed | D8 |
| 96 | output-capture / Capture path honors `AbortSignal` / Abort during capture | entailed | D8 |
| 97 | output-capture / Capture path forwards `systemPrompt` and replays message history (text-only, lossy) / Caller system prompt reaches selected driver | entailed | D8 |
| 98 | output-capture / Capture path forwards `systemPrompt` and replays message history (text-only, lossy) / Multi-message capture preserves prior turns | entailed | D8 |
| 99 | output-capture / Capture path does not leak resources / No user-stack drain text | entailed | D8 |
| 100 | output-capture / Capture path does not leak resources / Capture resources cleaned | entailed | D8 |
| 101 | output-capture / Empty-prompt handling / System-prompt-only call accepted | entailed | D8 |
| 102 | output-capture / Empty-prompt handling / Both empty rejected | entailed | D8 |
| 103 | output-capture / Capture path emits no intermediate stream events / Direct partial records suppressed | entailed | D8 |
| 104 | output-capture / Capture Uses Owning Invocation Driver / Direct-driver capture succeeds | entailed | D8 |
| 105 | output-capture / Capture Uses Owning Invocation Driver / Interactive capture remains unchanged | entailed | D8 |
| 106 | output-capture / Capture Uses Owning Invocation Driver / Capture driver fails | entailed | D8 |
| 107 | scenario-coverage / Large Cold Start Prompt Coverage / Large cold-start prompt reaches model through either driver | entailed | D10 |
| 108 | scenario-coverage / Full Bridge Scenarios Run Against Both Drivers / Direct parity run | entailed | D10 |
| 109 | scenario-coverage / Full Bridge Scenarios Run Against Both Drivers / Interactive regression run | entailed | D10 |
| 110 | scenario-coverage / Full Bridge Scenarios Run Against Both Drivers / Peek exception is narrow | entailed | D10 |
| 111 | scenario-coverage / Direct Protocol Integration Gates Are Retained / MCP readiness regression | entailed | D10 |
| 112 | scenario-coverage / Direct Protocol Integration Gates Are Retained / Native roster regression | entailed | D10 |
| 113 | scenario-coverage / Both Stream Schemas Have Deterministic Fixtures / Parser regression without live billing | entailed | D10 |
| 114 | scenario-coverage / Direct Concurrency Scenarios Prove State Isolation / Concurrent direct paths | entailed | D10 |
| 115 | warm-pi-resume / Resume Sidecar Persisted On Successful Turn / Successful turn writes typed sidecar | entailed | D6 |
| 116 | warm-pi-resume / Resume Sidecar Persisted On Successful Turn / Subagent does not write sidecar | entailed | D6 |
| 117 | warm-pi-resume / Resume Sidecar Persisted On Successful Turn / Sidecar write failure does not break turn | entailed | D6 |
| 118 | warm-pi-resume / Resume Sidecar Persisted On Successful Turn / Abort before direct prompt submission | entailed | D6 |
| 119 | warm-pi-resume / Resume Sidecar Persisted On Successful Turn / Abort after write but before direct turn acceptance | entailed | D6 |
| 120 | warm-pi-resume / Validated Warm Resume On Pi Resume / Valid same-driver sidecar | entailed | D6 |
| 121 | warm-pi-resume / Validated Warm Resume On Pi Resume / Unseen intervening messages | entailed | D6 |
| 122 | warm-pi-resume / Validated Warm Resume On Pi Resume / Missing external transcript | entailed | D6 |
| 123 | warm-pi-resume / Driver Guarantees A Live-Resume Result (no bridge-side stale guard) / Warm turn returns live answer | entailed | D6/D7 |
| 124 | warm-pi-resume / Driver Guarantees A Live-Resume Result (no bridge-side stale guard) / Driver refuses live turn | entailed | D6/D7 |
| 125 | warm-pi-resume / Warm Path Performs No New Claude Config Access / Warm resume touches bridge state only | entailed | D6/D7 |
| 126 | warm-pi-resume / Aborted-Mid-Tool Sessions Remain Resumable / Interactive dangling call | entailed | D6/D7 |
| 127 | warm-pi-resume / Aborted-Mid-Tool Sessions Remain Resumable / Direct dangling call | entailed | D6/D7 |
| 128 | warm-pi-resume / Resume Sidecar Records Driver Identity / Direct turn writes typed sidecar | entailed | D6 |
| 129 | warm-pi-resume / Resume Sidecar Records Driver Identity / Legacy sidecar has no driver | entailed | D6 |
| 130 | warm-pi-resume / Cross-Driver Warm Resume Is Forbidden / Interactive to direct | entailed | D6 |
| 131 | warm-pi-resume / Cross-Driver Warm Resume Is Forbidden / Direct to interactive | entailed | D6 |

## Advisory Findings

- None affecting entailment. Round-8 P2/P3 plan advisories are retained in `analyze.md` and do not weaken any canonical AC.

## Verdict rationale

All three blind judges attested integration HEAD d701c827b737e221e0642a5506b2f54b1987ce3d, returned review approval with P0=0/P1=0, and judged Fidelity delivered. Deterministic worst-of consolidation over all 131 canonical keys is `entailed` for every row; no intent/design contradiction or ambiguity-routed blocker remains.
