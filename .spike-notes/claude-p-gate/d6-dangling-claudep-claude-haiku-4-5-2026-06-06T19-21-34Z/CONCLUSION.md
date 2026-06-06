# Spike T0.2 — dangling-tool_use resume through the full claude-p path (Design D6-limit / spec R7)

**Date:** 2026-06-06 · **Binaries:** claude 2.1.159 + claude-p 0.1.0 (fork) · **Model:** claude-haiku-4-5
**Harness:** `d6-dangling-claudep-spike.mjs` (phases 0–1) + `d6-dangling-craft-resume.mjs` (phase 2B)

## Question
D6 proved `claude --resume` (direct) self-repairs a dangling tool_use. R7 asserts the **bridge** SHALL warm-resume such a session. T0.2: does this hold through the FULL `claude-p` + `suppressResumeReplay` path (not `claude` direct)? If not, R7 must INVERT (dangling → cold-start trigger).

## Findings (all observed)

### Phase 0 — `claude-p --resume <missing-uuid>` (T0.1 TUI-path confirmation)
`exit code 2`, stderr ends `claude-p: SessionStartTimeout`. The underlying `claude` errors ("No conversation found", per T0.1), claude never reaches ready, claude-p times out → **non-zero exit → the bridge's error→cold path catches it.** Confirms T0.1 on the bridge's real (TUI) path: a missing resume target does NOT silently start fresh.

### Finding A — a hard kill mid-tool does NOT leave a dangling tool_use
Spawned fresh; the model called `mcp__custom-tools__work`; at `onPark` I SIGKILL'd the claude-p process group **without delivering a result**. The on-disk transcript ended **well-formed**, not dangling:
```
assistant: thinking
assistant: tool_use(id=toolu_01S7ke…)
user:      tool_result(for=toolu_01S7ke…)  content="MCP error -32000: Connection closed"  is_error=true
```
**Mechanism:** killing claude-p kills the MCP shim → claude sees the MCP connection close and writes a synthetic `is_error` tool_result for the pending call (31 ms after the tool_use) **before** it dies. So the bridge's abort/`killWedged` path leaves a **closed** tool round, not a dangling one. The R7 precondition (transcript ends in an *unclosed* tool_use) is therefore **harder to reach in production than assumed** — it would require claude to die before processing the MCP disconnect (e.g. OOM/crash mid-write), not a normal abort.

### Finding B — even a genuinely-dangling transcript resumes cleanly (R7 HOLDS)
To test R7's literal precondition, I crafted the dangling state (removed the trailing `tool_result`, leaving the transcript ending in the unclosed `tool_use toolu_01S7ke`) and resumed it through claude-p + `suppressResumeReplay:true` + `livePromptText`:
```
exit code        = 0
sawResult        = true        (terminal result line)
answered          = true        (live prompt answered: "SPIKE_RESUME_OK")
danglingErrorSeen = false       (no API/4xx error about the unclosed tool_use)
resumeDiag = { sawReplayBoundary:true, livePromptAfterBoundary:true,
               livePromptTextMatched:true, staleSuspected:false, numTurns:5 }
```
claude repairs the dangling call at request-construction (D6 hypothesis), and the bridge's **`staleSuspected` guard correctly classifies it as a healthy live turn** (replay boundary seen AND a live prompt ran after it → not stale). **R7 HOLDS through the full claude-p + suppression path. It does NOT invert.**

### Bonus finding — transcript-dir encoding uses claude's OS-RESOLVED cwd
claude-p was spawned with `cwd=/tmp/d6-dangling-spike-cwd`, but the transcript landed under `~/.claude/projects/-private-tmp-d6-dangling-spike-cwd/` — claude recorded the **resolved** cwd (`/tmp`→`/private/tmp` firmlink). This **refines D3/R4/T2.4**: the fail-closed existence-check encoder must match claude's *exact* cwd canonicalization (OS firmlink/symlink resolution, plus the `/`-and-`.`→`-` substitution, plus possibly `$PWD`-vs-`getcwd` logic — the latter is the most likely cause of the earlier-observed `-Users-`/`-Volumes-` split). A mis-encode only ever **false-colds** (safe: cold is the floor), so it is low-risk, but the encoding is more subtle than "replace / and . in `frame.cwd`."

## Verdicts
- **T0.1 / C4:** `claude --resume <missing>` ERRORS (direct: exit 1 "No conversation found"; via claude-p: exit 2 SessionStartTimeout). No silent-fresh. The fail-closed existence check is **belt-and-suspenders** (owner kept it); the error→cold path is the real safety.
- **T0.2 / D6-limit / R7:** **CONFIRMED — R7 holds.** Dangling tool_use resumes cleanly through claude-p + suppression; `staleSuspected` does not misfire. R7 is de-provisionalized.
- **Production note:** the bridge's own abort path self-closes the tool round (Finding A), so the dangling case is an edge that's now also proven safe even when it does arise.
