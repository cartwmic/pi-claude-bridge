# Round 4 — Reviewer B (openai-codex/gpt-5.4)

## Verdict

needs revision — the proposal still has unresolved runtime and contract gaps around transcript discovery and shim invocation.

## Findings

### [P1] Shim executable is not locatable from the nested `claude` subprocess contract
- **Where:** `openspec/changes/replace-sdk-with-pty-tui/proposal.md:13`; `openspec/changes/replace-sdk-with-pty-tui/design.md:72,251-255`; `openspec/changes/replace-sdk-with-pty-tui/plan.md:46-47`; `package.json:22-35`
- **Issue:** The change assumes `claude` can invoke `pi-claude-bridge-shim` by bare command name for both MCP and hooks, but the package is currently a pi extension, not a globally installed CLI. Adding a `bin` entry is not enough unless the running extension also resolves that path or injects the package bin dir into the child PATH, and no artifact specifies that. The planned verification only runs the bin directly, not through `claude --mcp-config` / hook execution.
- **Impact:** Normal installs can fail at first spawn with `ENOENT`, leaving the PTY without MCP tools and without hook callbacks.
- **Fix direction:** Make the invocation contract absolute-path based (for example `process.execPath <resolved dist/mcp/shim.js>` or an explicitly resolved package bin path), and add an installed-package E2E test that proves a spawned `claude` process can invoke both shim modes.

### [P1] Deterministic transcript discovery conflicts with Constitution III
- **Where:** `openspec/constitution.md:34-44`; `openspec/changes/replace-sdk-with-pty-tui/proposal.md:12`; `openspec/changes/replace-sdk-with-pty-tui/specs/transcript-stream/spec.md:5-16`; `openspec/changes/replace-sdk-with-pty-tui/design.md:76,79,434`
- **Issue:** Constitution III permits reading only a transcript path delivered via `SessionStart`/`Stop`. The proposal/spec instead compute `~/.claude/projects/.../<uuid>.jsonl` locally and open it before any hook payload, with hook `transcript_path` reduced to a cross-check. `design.md` currently states both rules.
- **Impact:** The change is not internally governable: following the new spec violates the constitution, while following the constitution forbids the proposed discovery mechanism.
- **Fix direction:** Either amend Constitution III in this change, or revert the PTY/transcript specs back to hook-delivered transcript-path discovery as the authoritative read path.

### [P1] Warm-resume turns have no defined transcript-path rule
- **Where:** `openspec/changes/replace-sdk-with-pty-tui/specs/claude-tui-driver/spec.md:11-30,53-65`; `openspec/changes/replace-sdk-with-pty-tui/specs/transcript-stream/spec.md:16-20`; `openspec/changes/replace-sdk-with-pty-tui/design.md:53-54`
- **Issue:** Transcript tailing is only specified for spawns with a pre-generated `--session-id <uuid>`, but the warm-resume path switches to `--resume <session-id>` and the design says that path ignores `--session-id`. The artifacts never say how the bridge discovers the live transcript for resumed turns.
- **Impact:** The main multi-turn path is underspecified; resumed conversations may lose streaming/tool-round support or depend on undocumented flag precedence.
- **Fix direction:** Add an explicit resumed-turn discovery rule (for example compute from the cached resumed session id, or use the hook-delivered path on resume) and cover it with ACs/tests.

### [P2] Capture-mode source of truth is inconsistent across proposal, design, and specs
- **Where:** `openspec/changes/replace-sdk-with-pty-tui/proposal.md:11`; `openspec/changes/replace-sdk-with-pty-tui/design.md:128,337-345`; `openspec/changes/replace-sdk-with-pty-tui/specs/mcp-stdio-shim/spec.md:71-88`; `openspec/changes/replace-sdk-with-pty-tui/specs/output-capture/spec.md:135-167`
- **Issue:** One artifact says capture success comes from IPC-stashed validated args, another says it comes from transcript tool-use blocks, and `design.md` uses both depending on section. Those are different authority models, especially for invalid-first/valid-later or repeated tool calls.
- **Impact:** An implementation can satisfy one artifact while violating another, and edge-case behavior is left to guesswork.
- **Fix direction:** Choose one authoritative capture result source and rewrite all capture artifacts around it, including repeated-call and validation-failure behavior.

### [P2] The planned Constitution III audit will likely false-fail on `claude` child side effects
- **Where:** `openspec/changes/replace-sdk-with-pty-tui/design.md:74-77`; `openspec/changes/replace-sdk-with-pty-tui/tasks.md:276-283`
- **Issue:** `design.md` says `~/.claude/sessions/<pid>.json` is written by `claude` processes, but task 4.2 plans a directory-diff assertion that treats anything new in `~/.claude/sessions/` as bridge-attributable and forbidden.
- **Impact:** Hardening/CI can fail even when bridge code never writes those paths, weakening the enforcement signal and forcing ad-hoc exemptions.
- **Fix direction:** Define the audit in terms of bridge-authored operations (code-path checks, explicit allowlists, or child-process side-effect filtering), not raw directory diffs over paths the spawned `claude` process may legitimately create.

## Challenged Assumptions

- A package `bin` entry automatically makes the shim invocable from a `claude` subprocess.
- Deterministic path computation can replace hook-delivered transcript discovery without a constitutional change.
- Fresh-turn transcript discovery logic automatically covers resumed turns.
- IPC-stashed capture args and transcript-derived capture args are interchangeable enough to leave both in the contract.

## Stronger Alternatives

- Invoke the shim via an absolute resolved path under the current package, not by bare binary name.
- Keep hook-delivered `transcript_path` authoritative, and use deterministic path computation only as a warning-level cross-check.
- If deterministic discovery is required, specify separate fresh-turn and resume-turn rules explicitly.
- Make capture-mode success depend on exactly one authority source, with the other used only for diagnostics.

## Open Questions

- What PATH does pi actually provide to extension-launched subprocesses on installed npm packages?
- Does `claude --resume` accept `--session-id` concurrently, and if so which one controls transcript location?
- Does bridge-spawned interactive `claude` create `~/.claude/sessions/<pid>.json` on every run, and how should Constitution III audits treat that side effect?

## Minimal Revision Checklist

- Specify how hook/MCP commands resolve the shim executable on installed packages.
- Reconcile transcript discovery with Constitution III.
- Add an explicit transcript-discovery contract for warm-resume turns.
- Unify capture-mode result authority across proposal/design/specs.
- Redefine the Constitution III hardening audit so it distinguishes bridge writes from spawned-`claude` side effects.
