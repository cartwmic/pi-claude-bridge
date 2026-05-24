# Tasks: normalize-output-capture-spec-post-sdk-removal

## 1. Spec deltas authored

- [x] 1.1 specs/claude-tui-driver/spec.md (ADDED Requirements, verbatim from
      archived replace-sdk-with-pty-tui)
- [x] 1.2 specs/mcp-stdio-shim/spec.md (ADDED Requirements, verbatim)
- [x] 1.3 specs/transcript-stream/spec.md (ADDED Requirements, verbatim)
- [x] 1.4 specs/output-capture/spec.md (ADDED + MODIFIED + REMOVED blocks)

## 2. Validation

- [x] 2.1 `openspec validate normalize-output-capture-spec-post-sdk-removal` passes
- [x] 2.2 `openspec archive` (without --skip-specs) syncs cleanly into
      `openspec/specs/` for all four capabilities

## 3. Post-archive verification

- [x] 3.1 `openspec/specs/claude-tui-driver/spec.md` exists with PTY requirements
- [x] 3.2 `openspec/specs/mcp-stdio-shim/spec.md` exists
- [x] 3.3 `openspec/specs/transcript-stream/spec.md` exists
- [x] 3.4 `openspec/specs/output-capture/spec.md` no longer mentions
      `outputFormat`, `result.structured_output`, `SDK iterator`,
      `SDK construction` (sed/grep verification)
