# Archive notes — replace-sdk-with-pty-tui

Archived: 2026-05-24
Archived by: human (cartwmic) via `openspec archive --skip-specs`

## Why `--skip-specs`

The change's delta specs at `specs/output-capture/spec.md` (in this archive)
contain a `## MODIFIED Requirements` block that renames the requirement
"Surface terminal result lacking structured_output as error" →
"Surface absent capture-tool call as error". The rename reflects the
PTY rewrite (no SDK = no `structured_output` / `result` events), but
`openspec archive` requires the MODIFIED block's requirement-title to
match the existing main spec's title. It does not match, so default sync
aborted.

The same delta also implicitly REMOVES three SDK-only requirements from
the main spec (SDK-iterator errors, SDK-synchronous construction errors)
and may need explicit `## REMOVED Requirements` blocks for a clean sync.

**Decision (2026-05-24):** archive with `--skip-specs`. Verify GREEN, all
artifacts complete (8/8), tasks complete (102/102), `npm run build` clean,
`npm run test:unit` 202/202 PASS, scenario suite GREEN. The change is
implementationally complete; spec drift is documentation hygiene that
can be normalized in a follow-up change.

## Follow-up change

File a small change `normalize-output-capture-spec-post-sdk-removal`:

- Re-shape `specs/output-capture/spec.md`'s deltas to use:
  - `## REMOVED Requirements` for the 3 SDK-only entries
  - `## RENAMED Requirements` (or REMOVED+ADDED) for the
    structured_output → absent-capture-tool-call rename
- Add the 3 new ADDED Requirements that the PTY path actually
  implements (e.g. capture path tarball verification gate, etc.)
- Sync into main `openspec/specs/output-capture/spec.md` cleanly.

## ADR promotion candidates (deferred)

Design.md contains 26 decisions (D1–D27, D7 superseded). Per the
opsx-superpowers archive HARD-GATE 3, the following pass the 4-point
test and should be promoted to `<repo>/adr/ADR-NNNN-*.md` in a
follow-up:

- D1  PTY-driven `claude` invocation (over SDK)
- D2  node-pty as PTY library
- D3  MCP stdio transport via shim subprocess
- D5  Capture mode as forced MCP tool-call (tool-as-output)
- D9  Hook set: SessionStart + Stop only
- D11 4-layer defense against disallowed tools
- D15 Abort lifecycle — PTY torn down, router-state preserved
- D17 Bounded post-Stop transcript settle window
- D18 Deterministic transcript path via pre-generated --session-id
- D22 Warm-resume cache (sid + cwd, drop on history divergence)
- D25 Workspace trust-dialog handling
- D26 Prompt injection via typed input post-SessionStart
- D27 System prompt bundled into typed user message

(13 candidates. Run promotion separately to avoid blocking archive.)

## Retrospective (deferred)

Scale = L; retrospective.md was not produced (recommended, not required
at Scale L). If a retrospective is desired, the template is at:
`~/.local/share/openspec/schemas/opsx-superpowers/templates/retrospective.md`

Key wins to capture in any future retrospective:
- PTY architecture survived 28-scenario suite without regression
- Adversarial-review-cycle (5 rounds across 2 reviewers) caught all
  pre-implementation risks; only OAuth interactive-mode tier cap was
  missed (D13 → D26 supersession resolved it post-validation)
- Tool round-trip semantics ported cleanly from SDK path to PTY path
  via promise-stack drain-on-supersede pattern
- Bundle size: -3131 lines net in index.ts (1746 → 493) without
  losing any externally-observable behavior
