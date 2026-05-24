# Proposal: normalize-output-capture-spec-post-sdk-removal

## Why

The `replace-sdk-with-pty-tui` change (archived 2026-05-24) introduced
three net-new capability specs (`claude-tui-driver`, `mcp-stdio-shim`,
`transcript-stream`) and modified `output-capture` to express the
capture path in PTY-driver terms instead of SDK terms. Archive was done
with `--skip-specs` because the `MODIFIED Requirements` block in
`output-capture` contained a requirement title that did not match the
main spec (one PTY-era rename: "Surface absent capture-tool call as
error" was the new wording for the SDK-era "Surface terminal `result`
lacking `structured_output` as error").

Main `openspec/specs/` is therefore now out of date relative to the
shipping codebase: it lists three never-existed capabilities as absent,
and the `output-capture` spec describes the v0 SDK driver.

This change reconciles main specs to match the v1.0.0 PTY implementation.

## What

- Add three capability specs to main: `claude-tui-driver`,
  `mcp-stdio-shim`, `transcript-stream`. Delta = `ADDED Requirements`
  blocks copied verbatim from the archived `replace-sdk-with-pty-tui`
  change.
- Re-express `output-capture` to PTY-era language. Delta blocks:
  - `ADDED Requirements`: two new requirements — "Surface absent
    capture-tool call as error" (replacement for the SDK-era
    structured_output error) and "Capture path honors `AbortSignal`"
    (new external API surface).
  - `MODIFIED Requirements`: four requirements have unchanged titles
    but mechanism wording updated from SDK terms (`outputFormat`,
    `result.structured_output`, `system:init`) to PTY terms (transcript
    JSONL, MCP shim IPC, `Stop` hook).
  - `REMOVED Requirements`: four SDK-specific requirements that have no
    PTY analog (SDK iterator close, SDK synchronous construction,
    structured_output result wording, defensive schema clone for
    `outputFormat`).

## Impact

- Spec docs only. No code changes.
- After archive, `openspec/specs/` matches the shipping bridge.
- Future changes against any of the four capabilities will work
  against a current spec instead of the v0 SDK one.

## Scope

S — spec sync, no code, no behavior change.
