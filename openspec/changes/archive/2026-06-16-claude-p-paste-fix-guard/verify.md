# Verify

**Change:** `claude-p-paste-fix-guard`  
**Schema:** `opsx-superpowers`  
**Worktree base SHA:** `d8fa12a3fb9a621eefad447c67ed5345872a16ee`  
**Generated:** 2026-06-16 by worker

## Validation evidence

### npm install / fixed claude-p resolution

`npm install` exited 0:

```text
npm warn skipping integrity check for git dependency ssh://git@github.com/cartwmic/claude-p.git

changed 1 package, and audited 366 packages in 22s
```

Resolution evidence:

```text
root claude-p: github:cartwmic/claude-p#f47f71dfa34593a32cb911f617f9cf8ca1fa0073
node_modules/claude-p resolved: git+ssh://git@github.com/cartwmic/claude-p.git#f47f71dfa34593a32cb911f617f9cf8ca1fa0073
installed claudePPatch: echo-confirm-input
strings node_modules/claude-p/zig-out/bin/claude-p | grep -E "Pastedtext|paste again to expand"
Pastedtext
paste again to expand
```

Package diff evidence:

```diff
-    "claude-p": "github:cartwmic/claude-p#b24e3827a5c10ce5475578e4130ead74024d8b30",
+    "claude-p": "github:cartwmic/claude-p#f47f71dfa34593a32cb911f617f9cf8ca1fa0073",
```

### Unit tests

`npm run test:unit` exited 0.

Representative tail from the run showed green subtests, including claude-p argument and spawn coverage:

```text
✔ buildClaudePArgs — required flags (2.184125ms)
✔ buildClaudePArgs — session id XOR resume (0.153916ms)
✔ buildClaudePArgs — forbidden-flag and mcp-token guards (0.854792ms)
✔ spawnClaudeP — clean turn classification (864.49ms)
```

### Live S31

`bash scripts/run-scenario-s31-large-cold-start-prompt.sh` exited 0 on first run:

```text
==== S31 large cold-start prompt (model=claude-bridge/claude-opus-4-8 bytes=1592 sentinel=S31_SENTINEL_1781590265_39863) ====
==== S31 results ====
  PromptNotAccepted count: 0
  PASS: mechanical: no PromptNotAccepted in bridge log
  cold fresh-spawn count: 1
  PASS: mechanical: first turn used cold fresh spawn (resume=no)
  completed turn count: 1
  PASS: mechanical: cold-start turn completed and cached a session
  PASS: mechanical: no bridge error path recorded
  PASS: coherence: large cold-start prompt reached the model — model affirmed: ' S31_SENTINEL_1781590265_39863'
====================
```

## Check 1 — Structural validation

Command:

```sh
openspec validate claude-p-paste-fix-guard --strict --json
```

Result:

```json
{
  "items": [
    {
      "id": "claude-p-paste-fix-guard",
      "type": "change",
      "valid": true,
      "issues": [],
      "durationMs": 2
    }
  ],
  "summary": {
    "totals": { "items": 1, "passed": 1, "failed": 0 },
    "byType": { "change": { "items": 1, "passed": 1, "failed": 0 } }
  },
  "version": "1.0"
}
```

**Status:** PASS.

## Check 2 — Task completion

Command:

```sh
grep -c '^- \[ \]' openspec/changes/claude-p-paste-fix-guard/tasks.md
```

Result: `0` pending tasks.

**Status:** PASS.

## Check 3 — Delta vs current spec coherence

Delta files:

- `openspec/changes/claude-p-paste-fix-guard/specs/scenario-coverage/spec.md`
  - New capability spec.
  - Contains `## ADDED Requirements` with one parseable requirement: `Large Cold Start Prompt Coverage`.
- `openspec/changes/claude-p-paste-fix-guard/specs/claude-p-driver/spec.md`
  - Modified existing capability delta.
  - Contains `## ADDED Requirements` with one parseable requirement: `Fixed claude-p fork pin`.

Both delta specs use required ADDED/MODIFIED/REMOVED/RENAMED section headers and EARS scenarios with `#### Scenario:` headings.

**Status:** PASS.

## Check 4 — Commit hygiene

Base: `d8fa12a3fb9a621eefad447c67ed5345872a16ee`.

Commits authored for this change:

| Subject | Subject <=72 | Body explains why | Status |
|---|---:|---:|---|
| `docs(opsx): propose claude-p paste fix guard` | yes | yes | pass |
| `fix(deps): pin claude-p paste-collapse fix` | yes | yes | pass |
| `test(scenarios): add large prompt cold-start guard` | yes | yes | pass |

**Status:** PASS.

## Check 5 — AC↔test mapping

Forward mapping:

| AC ID | Evidence |
|---|---|
| `scenario-coverage.large-cold-start-prompt-coverage` | `scripts/run-scenario-s31-large-cold-start-prompt.sh` comment cites the AC and implements the live mechanical + coherence assertions. |
| `claude-p-driver.fixed-claude-p-fork-pin` | `scripts/run-scenario-s31-large-cold-start-prompt.sh` comment cites the AC; `package.json`/`package-lock.json` implement the pin, and S31 proves installed-driver behavior. |

Reverse mapping:

- No changed files under `tests/**` or `*.test.*`.
- Changed executable acceptance script `scripts/run-scenario-s31-large-cold-start-prompt.sh` cites both canonical AC IDs in its header.

**Status:** PASS.

## Check 6 — Constitution compliance audit

Changed files audited (all changed files; count <50):

| File or group | Audit result |
|---|---|
| `package.json`, `package-lock.json` | Dependency pin only; no bridge-owned conversation state, no `~/.claude/` access, no native-tool policy change. |
| `scripts/run-scenario-s31-large-cold-start-prompt.sh` | Scenario harness starts fresh pi and inspects logs; no production behavior or persisted state change. |
| `scripts/scenario-overrides.conf` | Scenario runner metadata only. |
| `SCENARIOS.md` | Documentation only. |
| `openspec/changes/claude-p-paste-fix-guard/**` | Planning and verification artifacts only; explicitly preserve Constitution I–VII boundaries. |

Principles:

| Principle | Result |
|---|---|
| I. Pi owns conversation state | PASS — no new bridge conversation persistence. |
| II. Bridge is inference-only | PASS — no production bridge logic added. |
| III. No filesystem coupling to driver mutable state | PASS — no `~/.claude/` read/write introduced. |
| IV. Native Claude tools are disallowed | PASS — claude-p pin preserves existing invocation and disallow flags. |
| V. System prompt fidelity per path | PASS — no prompt path mutation. |
| VI. Concurrent paths share no state | PASS — no shared state change. |
| VII. Failures surface; degradation explicit | PASS — S31 fails loudly on `PromptNotAccepted`, missing completion, bridge errors, or non-delivery response. |

**Status:** PASS.

## Completion Decision

All 6 checks pass.

**Completion Decision:** green
