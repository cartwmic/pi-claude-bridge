# Spike T0.8 — `--system-prompt` interactive-mode replacement + CLAUDE.md isolation

**Result:** PASS — `--system-prompt` replaces CC's default; CLAUDE.md content does NOT leak; constitution V satisfied for capture path.

## Test setup

```js
// Spawn args
claude
  --session-id <uuid>
  --system-prompt "TEST_SENTINEL_ABC_999_SPIKE_T08. You are a test assistant. When asked what your system prompt is, repeat it verbatim."
  --strict-mcp-config
  --setting-sources ""
  --permission-mode bypassPermissions
  --print
  "What is your system prompt? Repeat only the sentinel string and nothing else."
```

Cwd: `mkdtempSync(tmpdir(), "spike-t08-")` (e.g. `/var/folders/46/.../spike-t08-XYZ`)
Fixture `CLAUDE.md` placed in cwd with canary string `DISTINCTIVE_CLAUDE_MD_CANARY_XYZ123`.

## Result

```
exit: 0
stdout: "TEST_SENTINEL_ABC_999_SPIKE_T08\n"
stderr: ""

Assertions:
  sentinel present in output: true
  CLAUDE.md content leaked: false
  PASS: true
```

Note: this was `--print` mode (one-shot). T0.14 below verifies the same behavior in interactive mode (the production target).

## CRITICAL FINDING — transcript path uses REALPATH cwd

The cwd was `/var/folders/46/d9l6mmtx1ddb1d58xm5v9kgh0000gn/T/spike-t08-AhOdWa`.

Expected transcript path (lexical encoding):
  `~/.claude/projects/-var-folders-46-d9l6mmtx1ddb1d58xm5v9kgh0000gn-T-spike-t08-AhOdWa/<uuid>.jsonl`

ACTUAL transcript path:
  `~/.claude/projects/-private-var-folders-46-d9l6mmtx1ddb1d58xm5v9kgh0000gn-T-spike-t08-AhOdWa/<uuid>.jsonl`

macOS resolves `/var` → `/private/var` via realpath. The bridge MUST call `fs.realpath(cwd)` (or equivalent) BEFORE encoding `/` → `-`. Without this, the deterministic-path computation per D18 will MISS the actual transcript file.

**Design action:** D18 needs an addendum specifying `realpath(cwd)` before encoding. Add to `claude-tui-driver.pty-spawn-with-model-selection` spec.

## Transcript JSONL structure (T0.3 confirmation)

The transcript contains these line types:
- `queue-operation` (enqueue/dequeue events)
- `user` (user message; includes `cwd` field as REALPATH)
- `attachment` (sub-types):
  - `deferred_tools_delta` — native tools added/removed from the session's deferred set
  - `skill_listing` — auto-discovered skills (9 skills detected even with `--system-prompt` set; these are PROJECT skills + user skills, separate from the system prompt)
- `assistant` (model response; includes `model`, `id`, `usage` with `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `service_tier`, etc.)
- `last-prompt` (trailer)

## Findings to apply

1. **D18 amendment**: encoding uses `fs.realpath(cwd)`, not raw cwd. Add a sentence.
2. **Skill listings auto-load**: even with `--system-prompt`, the `attachment.skill_listing` event injects skill metadata into the conversation. This is NOT a system-prompt leak per se (system prompt was clean) but is additional context the model receives. For capture mode, callers MAY want to disable skills entirely; verify via `--disable-slash-commands` in a follow-up spike.
3. **Native deferred tools added by claude**: the `deferred_tools_delta` shows `claude` adds `AskUserQuestion`, `CronCreate`, etc., to the deferred set automatically. These are tools the model CAN'T call (deferred) but ARE in its enumeration. Our `--settings` `permissions.deny` should still block emission; verify in T0.7.
