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

## ADR promotion (completed 2026-05-24)

Per opsx-superpowers archive HARD-GATE 3, decisions passing the
4-point rubric (≥3/4) were promoted to `adr/ADR-NNNN-*.md`. Initial
estimate was 13; full audit of pre-scored 4-point tests in design.md
found 16 qualifying decisions:

| ADR | Source decision | 4-point score |
|---|---|---|
| ADR-0001 | D1 PTY-driver over SDK | 4/4 |
| ADR-0002 | D2 node-pty as PTY library | 3/4 |
| ADR-0003 | D3 MCP stdio transport | 4/4 |
| ADR-0004 | D4 Per-block transcript JSONL streaming | 4/4 |
| ADR-0005 | D5 Capture mode as forced MCP tool-call | 4/4 |
| ADR-0006 | D7-final `--system-prompt` flag (Superseded by ADR-0016) | 3/4 |
| ADR-0007 | D12 Hook IPC channel via shim relay | 3/4 |
| ADR-0008 | D14 Packaging — build to dist/ | 3/4 |
| ADR-0009 | D15 Abort lifecycle | 4/4 |
| ADR-0010 | D16 Capture-mode MCP completion semantics | 4/4 |
| ADR-0011 | D18 Deterministic transcript path | 4/4 |
| ADR-0012 | D19 Shim path resolution | 3/4 |
| ADR-0013 | D21 Capture-mode authoritative result source | 3/4 |
| ADR-0014 | D25 Workspace trust-dialog handling | 4/4 |
| ADR-0015 | D26 Typed prompt injection | 4/4 |
| ADR-0016 | D27 System prompt bundled into typed message | 4/4 |

Design decisions NOT promoted (scoring ≤2/4 or borderline 3/4 deemed
not worth a standalone ADR by the change author): D6, D8, D9, D10,
D11, D17, D20, D22, D23, D24. Their content remains in the archived
`design.md` for historical reference.

Index: `<repo>/adr/README.md`.

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
