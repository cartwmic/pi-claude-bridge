# Round 5 — Reviewer A (claude-bridge/claude-opus-4-7)

## Verdict

**needs revision** — Two P1 gaps: (1) Phase 0 has no explicit pass/fail gate
proving interactive `claude` with a positional prompt remains running (the
core assumption of the entire driver); (2) the argv-overflow fallback story
(R15 / T0.11) omits `--system-prompt-file` despite `claude --help`'s `--bare`
text confirming the flag exists, leaving an architectural escape hatch
unexamined.

## Findings

### [P1] Interactive-mode positional-prompt liveness is unverified

**Impact.** Every spec AC (`pty-spawn-with-model-selection`,
`prompt-injection-via-cli-positional-argument`, `tail-transcript-while-turn-is-in-flight`)
assumes that `claude [options] <prompt>` *without* `-p` (a) sends the
positional prompt as the first user message AND (b) keeps the TUI running so
hooks fire and the transcript JSONL is appended. Help text only confirms
"starts an interactive session by default, use -p/--print for non-interactive
output" — it does not say what happens when a positional `[prompt]` is
present WITHOUT `-p`. Three plausible behaviors:
  1. Prompt is sent, TUI stays interactive, hooks fire (design's assumption).
  2. Prompt is sent, claude treats it as one-shot and exits (effectively `-p`).
  3. Prompt is queued but the picker (`/resume`) intercepts boot.

T0.8 *implicitly* relies on behavior (1) (it "drives a turn" via positional)
but its stated pass criterion is the sentinel system-prompt check, not
liveness. T0.12 also uses `--session-id` but its pass criterion is path
encoding. No spike has "interactive-mode positional-prompt stays running →
SessionStart hook fires → Stop hook fires" as its EXPLICIT pass/fail gate.

If behavior (2) is the truth, D4's transcript-tail-during-turn collapses —
the file appears, content drops, claude exits, hooks may or may not fire
relative to the tailer's open. The entire driver design needs `-p` semantics
or a stdin-based prompt-feed mechanism (which D13 explicitly forbids).

**Fix direction.**
- Add an explicit spike T0.6a (or rename a portion of T0.8): `claude
  --session-id <uuid> "hello"` in `node-pty`, wait 30s, assert
  (i) `SessionStart` hook fires, (ii) at least one assistant-message JSONL
  line appears, (iii) the TUI process is still alive when interrupted by
  SIGINT, (iv) `Stop` hook fires on SIGINT.
- Make this spike a HARD GATE in plan.md step 1 verification (today's
  verification list checks D7-final, not positional-prompt liveness).
- If the assumption fails, design.md needs a new D-decision (likely:
  spawn with positional prompt, accept that claude treats it as `-p` mode
  semantics inside the PTY → re-evaluate trust posture vs. `-p` since that
  was the path D1 explicitly rejected).

### [P1] Argv-overflow fallback omits `--system-prompt-file`

**Impact.** R15 / T0.11 / `prompt-injection-via-cli-positional-argument`'s
size-overflow branch enumerate candidates: "(a) extending `--system-prompt`
with overflow context, (b) `--add-dir <dir>` referencing a temp file…, (c)
document hard limit". Round-4 A.P1#1 correctly observed that (a) shares the
same ARG_MAX budget — so it is not a real escape. (b) breaks because native
`Read` is disallowed (so the model can't load the file).

What's missing: `claude --help`'s `--bare` flag description lists
"`--system-prompt[-file]`, `--append-system-prompt[-file]`" — the `[-file]`
suffix strongly implies `--system-prompt-file <path>` and
`--append-system-prompt-file <path>` exist and take a filesystem path
(escaping argv entirely). T0.11's candidate list never names it. If the
flag is real and behaves as suggested (read prompt text from file), the
"v1 hard limit" exit is avoidable: cold-start history goes into a temp
file referenced by `--system-prompt-file`; the positional argument carries
only the new user message.

Caveat: pi-combined system prompt material currently lives in
`--system-prompt`. Using `--system-prompt-file` for cold-start history would
require shifting "history-as-context" out of the positional and into the
system slot. That has its own semantic implications (system prompt fidelity
on the main path) — but the main path's contract per constitution V already
permits documented additions (skills, agents, append-system). Adding "prior
conversation context" to that ordered list is at minimum a defendable design
move worth evaluating in T0.11 rather than skipping outright.

**Fix direction.**
- Add `--system-prompt-file` (and `--append-system-prompt-file`) to T0.11's
  candidate-list spike. Verify existence + interactive-mode honor +
  ARG_MAX-independence.
- If verified, design.md gets a D-revision: when the positional-arg fallback
  triggers, the bridge writes the cold-start history to a per-PTY tempfile
  and passes `--system-prompt-file <tempfile>` instead of `--system-prompt
  <inline>`. Document the file cleanup path (constitution III forbids writes
  under `~/.claude/`, NOT under `os.tmpdir()`, so this is permissible).
- If not viable, the spec's hard-limit branch can stand — but only after
  the flag is actually checked.

### [P2] Hook-command shell quoting may break on paths with spaces

**Impact.** D19 specifies the hook command string as
`"command": "node <resolved-absolute-path> --mode hook --event session-start
--socket <socket>"`. `<resolved-absolute-path>` comes from
`require.resolve(...)` and includes the user's npm install prefix. On macOS
this commonly contains spaces (e.g. `/Users/Some Name/...`,
`/Users/x/Library/Application Support/...`, or `~/Documents/My Projects/...`).
CC's hook contract treats `command` as a shell string (the documented format
is `{ "type": "command", "command": "<shell command>" }`). An unquoted path
with spaces splits into multiple argv tokens; the hook subprocess invocation
fails silently and the bridge times out waiting for hook payload delivery.

Same hazard applies to `<socket>` if `$TMPDIR` contains spaces (rare but
possible).

**Fix direction.**
- Specify in D19 that the bridge constructs the command string with
  shell-safe quoting (single-quote each path, escape embedded single
  quotes), or use an array form if CC's hook schema accepts one.
- Add a unit test that spawns a hook command with a path containing a
  space and asserts the payload is relayed correctly.
- Same fix for the `--mcp-config` JSON's `args` array (already an array
  there per D19 — no quoting needed; document explicitly).

### [P2] `CLAUDE.md` auto-discovery interaction with `--system-prompt` has no documented escape

**Impact.** D7-final / T0.8 verify that `--system-prompt <text>` in
interactive mode produces a system prompt containing the sentinel and NO
CLAUDE.md / auto-memory content. If verification fails, the escape is
`--bare` — but `--bare` "disables hooks" per its own help text, which
breaks D9 (SessionStart + Stop) and D12 (hook IPC channel). Tasks T4.3
correctly asserts `--bare` is in the disallowed-flags set.

This leaves the design with a **single point of failure**: if T0.8 shows
CLAUDE.md leaks, the only fallback (`--bare`) is incompatible with the
hook-based transcript discovery. The design.md text acknowledges this
("would invalidate D9/D12; we'd need a different transcript-discovery
mechanism") but does not pre-specify what that mechanism IS or commit to
a fallback design.

Compound risk: D18's deterministic transcript-path discovery via
`--session-id <uuid>` makes hooks NON-CRITICAL for discovery — the file
appears at a known path regardless of hooks. So `--bare` is closer to
viable than the current text admits: the bridge would lose `Stop`-driven
turn-finalization but could fall back to "watch transcript for terminal
`result` entry; treat that as end-of-turn." This is worth examining
before the spike fails, because it changes whether T0.8 is a blocker or
a routine verification.

**Fix direction.**
- Add to D7-final a pre-specified contingency: "If T0.8 shows CLAUDE.md
  leakage, escalate to `--bare`; turn-finalization moves from `Stop` hook
  to terminal-`result` detection in the transcript JSONL; D9 reduces to
  zero hooks; D12 reduces to MCP-shim-only IPC."
- Or: add a spike T0.8a verifying whether per-PTY `HOME=<scratch>` (the
  same fallback already pinned for T0.7) ALSO suppresses CLAUDE.md
  auto-discovery when CLAUDE.md lives under cwd (not `~/.claude/`). If
  yes, the HOME-override sandbox solves both `--setting-sources ""` and
  CLAUDE.md-leak at once.

### [P2] D8 module structure conflicts with proposal/index.ts entry path

**Impact.** Proposal.md states the top-level `index.ts` stays as pi's
extension entry (`pi.extensions: ["./index.ts"]` unchanged); the .ts file
becomes a thin wrapper importing from `dist/`. D8's structure block shows
`src/index.ts # extension entry; preserves current public surface`. These
disagree: either `index.ts` (top-level) is the entry and `src/index.ts`
should be named differently (e.g. `src/main.ts` or `src/extension.ts`), or
`src/index.ts` is the entry and `pi.extensions` must change (which the
proposal forbids).

This is a docs-consistency issue, not a runtime defect — but the next
implementer reads D8 + proposal.md and gets ambiguous direction on which
file holds the top-level orchestration.

**Fix direction.** In D8, rename `src/index.ts` to `src/main.ts` (or
similar) and add a one-line note: "top-level `./index.ts` (referenced by
`pi.extensions`) imports from `dist/main.js`." Or remove `src/index.ts`
from the tree and explicitly note that the top-level `index.ts` orchestrates
the new `driver/` and `mcp/` modules directly.

### [P2] `--session-id` + `--resume` interaction unspecified; D22 transcript-path formula needs spike confirmation

**Impact.** D22 declares: "warm-resume passes ONLY `--resume <cached-id>`
(NOT `--session-id`); transcript path is computed from the resumed id." This
relies on the assumption that `claude --resume <id>` appends to the EXISTING
transcript at `~/.claude/projects/<encoded-cwd>/<id>.jsonl` rather than (a)
forking to a new id with a new transcript, (b) writing only in-memory then
flushing at end, or (c) using `--fork-session`-style behavior implicitly.

`claude --help` documents `--fork-session` as opt-in to "create a new session
ID instead of reusing the original (use with --resume…)" — implying default
`--resume` reuses, which supports D22. But the implication is not the same as
verification. T0.12 verifies `--session-id <uuid>` honors the supplied UUID;
the spike does NOT explicitly verify the `--resume <id>` transcript-append
behavior or that the path formula holds across resume.

**Fix direction.**
- Extend T0.12 (or add T0.12a): spawn `claude --session-id <uuid> "hello"`,
  let it write a few transcript lines, kill it, then spawn `claude --resume
  <uuid> "follow up"` and assert (i) appends to the same `<uuid>.jsonl`,
  (ii) does NOT rotate to a new uuid, (iii) the SessionStart payload (if any)
  reports the same id.
- Document the verified-behavior pass criterion in design.md D22.

### [P2] Concurrent capture-call resource ceiling not specified

**Impact.** Clarify C9 and D5 commit to "independent PTYs per concurrent
capture call." Each spawns a `claude` process + a `pi-claude-bridge-shim
--mode mcp` process + holds open a unix socket + writes a transcript file +
opens an fs.watch handle. A pi-coding-agent running ~10 parallel
skills/subagents that each call into capture mode produces ~30 processes
plus sockets plus file handles per parallel batch.

No spec or design states an upper bound or queueing fallback. macOS default
`ulimit -n` is ~256; default process count is ~700. Sustained usage past
~25 concurrent capture calls likely hits the file-descriptor wall.

**Fix direction.**
- Add a design-level "concurrent-capture concurrency limit" with a
  documented default (e.g. 8) and an env override
  (`CLAUDE_BRIDGE_MAX_CONCURRENT_CAPTURES`).
- If a capture call arrives when the limit is reached, the bridge queues it
  (FIFO) with a documented timeout, OR rejects with a clear error per
  constitution VII.
- Tasks gets a corresponding test (`tests/int-pty-capture-concurrency.mjs`).

### [P3] D9 rationale text references "four hooks" but only two remain

**Impact.** D9's "Rationale" line still reads "four hooks cover (a)
injection, (b) finalization, (c) tool-name enforcement, (d) teardown." After
Round 2 dropped `PreToolUse` and Round 3 dropped `SessionEnd`, this is stale
copy. Trivial to miss; not a defect, but next reader will pause to figure
out which "four" hooks the author meant.

**Fix direction.** Replace with: "Two hooks cover (a) confirmation the model
run started, (b) finalization. Tool-name enforcement lives in the MCP shim;
teardown is handled by PTY exit + D17 settle window."

### [P3] Unix socket path-length limit on macOS not addressed

**Impact.** macOS limits `sockaddr_un.sun_path` to 104 bytes. D12 generates
sockets at `$TMPDIR/pi-claude-bridge-<random>.sock`. macOS `$TMPDIR` is
typically `/var/folders/xx/<24-char-base>/T/` (~ 50 bytes), plus
`pi-claude-bridge-` (17 bytes), plus suffix `.sock` (5 bytes) = ~72 bytes
of overhead, leaving ~32 bytes for `<random>`. Unspecified `randomBytes`
size could exceed (e.g. `randomBytes(32).toString('hex')` = 64 chars =
overflow). Bind silently fails on overflow on some Node versions.

**Fix direction.**
- Pin random length: `randomBytes(8).toString('hex')` = 16 chars; total
  path ~88 bytes; safe.
- Add an assertion in `src/mcp/ipc.ts` that the constructed socket path
  is < 100 bytes; if not, error fast.

### [P3] Hook-response-shape unknown gates spec correctness

**Impact.** T0.13 is supposed to determine the JSON response shape `claude`
expects from hook subprocesses. Until that result is in, several spec ACs
assume "empty JSON object `{}` is acceptable for SessionStart and Stop"
(design D12). If that assumption is wrong, the bridge's hook subprocesses
return shapes that confuse `claude` (block tool emission, log warnings,
etc.) and the SessionStart/Stop hook contract effectively breaks.

This is already flagged as a deferred Phase 0 spike. The risk: if T0.13
finds a non-trivial response schema is required, the IPC protocol (D20)
needs a richer round-trip than `{ "kind": "hook_response", "stdout": "..." }`
implies (the bridge router needs to KNOW the schema to fill it in).

**Fix direction.**
- Make T0.13 a Phase 0 hard gate before any Phase 1 hook-IPC code.
- If T0.13 finds a non-trivial schema, D20's `hook_response` shape extends
  to carry whatever the bridge needs the hook subprocess to write back.

## Challenged Assumptions

- **`claude` interactive mode accepts a positional `[prompt]` and stays
  running.** Help text says interactive is the default; doesn't define
  positional-prompt-without-`-p` behavior. T0.8 implicitly assumes, doesn't
  explicitly verify. Promoted to P1.
- **`--system-prompt` replaces (not extends) CC's default including
  CLAUDE.md auto-discovery.** Help text strongly implies (the
  `--exclude-dynamic-system-prompt-sections` "ignored with --system-prompt"
  note is suggestive). T0.8 verifies. If wrong, the only fallback (`--bare`)
  breaks hooks. P2.
- **`--setting-sources ""` (empty) is honored as "load nothing".** Help
  text says "Comma-separated list of setting sources (user, project,
  local)" — empty-string semantics are not in the help. T0.7 verifies;
  HOME-override is the fallback. Already mitigated.
- **`require.resolve('pi-claude-bridge/dist/mcp/shim.js')` returns an
  absolute path the spawned `claude` can execute.** Requires the package to
  be installed via `npm install pi-claude-bridge` (vs. linked, vs. ad-hoc
  worktree development). T4.4a tarball test covers the tarball path; the
  in-repo development path (top-level `index.ts` imports from
  `./src/mcp/shim.ts` via tsx, but `require.resolve` against the package
  name fails in an unbuilt repo) is unaddressed.
- **macOS `fs.watch` reliably observes new files in
  `~/.claude/projects/<encoded-cwd>/` once.** Deferred via T0.4.
- **`node-pty` boots `claude` without an ANSI-query responder.** Deferred
  via T0.6. smithersai/claude-p explicitly built a responder; the design
  assumes this isn't needed.

## Stronger Alternatives

- **`--system-prompt-file <path>` for argv-overflow.** Move cold-start
  history into a per-PTY tempfile referenced via `--system-prompt-file`;
  positional carries only the new user message. Sidesteps ARG_MAX entirely.
  Already required by `--bare`'s own help text to exist; verify in T0.11.
- **HOME-override sandbox as the primary isolation mechanism, not the
  fallback.** Rather than relying on `--setting-sources ""` + `--strict-mcp-config`
  (two flags whose empty/strict semantics are partially undocumented),
  unconditionally spawn each PTY with `HOME=<per-PTY scratch>` populated
  with an empty `.claude/`. Closes both `setting-sources` and CLAUDE.md
  auto-discovery in one mechanism. Cost: scratch-dir lifecycle. Benefit:
  bulletproof against flag-syntax drift.
- **Drop `--resume` warm path entirely for v1; always cold-start.** Cold
  starts pay 1–3s of TUI boot but eliminate (a) `--resume` semantic
  unknowns (D22), (b) the cached-session-id invalidation matrix, (c) a
  whole class of "stale cache → wrong transcript" bugs. After Phase 0
  measures cold-start latency, consider whether the cache complexity is
  worth its UX gain.
- **Pre-allocate a shim binary path at install time, not spawn time.**
  `require.resolve` at spawn time pays a cost per turn (negligible) but
  also fails predictably if the install layout is unusual. Resolving once
  at bridge load and caching the absolute path is cleaner. Document the
  resolution failure mode (constitution VII).
- **Use TCP loopback as the shim IPC fallback if the socket path exceeds
  104 bytes on macOS.** Simple, well-tested, port allocation is the trade
  D3 ruled out — but as a NARROW fallback only when the unix path is
  unworkable, the trade-off changes.

## Open Questions

- **OQ-A:** Does interactive `claude` with a positional `<prompt>` (no
  `-p`) stay running long enough for hooks to fire and the transcript JSONL
  to be written? Owned by an enhanced T0.6a / T0.8.
- **OQ-B:** Does `--system-prompt-file <path>` exist and work in interactive
  mode? (The `--bare` help text suggests it does.) Owned by an enhanced
  T0.11.
- **OQ-C:** What is `claude`'s behavior when `--resume <id>` resumes a
  session whose transcript file the bridge tailed previously? Append vs
  rotate vs fork? Owned by extended T0.12.
- **OQ-D:** What hook RESPONSE JSON shape does `claude` expect on
  SessionStart / Stop stdout? Owned by T0.13 (already deferred).
- **OQ-E:** What is the concurrent-capture upper bound, and at what bound
  does the bridge queue vs reject? Currently unspecified.
- **OQ-F:** In a non-published, in-repo development worktree, how does
  `require.resolve('pi-claude-bridge/dist/mcp/shim.js')` behave? The
  tarball-verify test covers the installed-package path; the development
  loop is not addressed.

## Minimal Revision Checklist

- [ ] Add Phase 0 spike T0.6a: interactive `claude` + positional prompt
  liveness gate (SessionStart, transcript-line, alive-on-SIGINT, Stop).
- [ ] Extend T0.11 candidate list to include `--system-prompt-file` and
  `--append-system-prompt-file`; revise R15 mitigation if either viable.
- [ ] Update D19: hook command string is shell-safe quoted; add a unit test
  exercising a spaced path.
- [ ] Add D7-final contingency: pre-specify the `--bare` fallback (or
  HOME-override) cascade including how D9/D12 reduce.
- [ ] Reconcile D8 module-structure inconsistency: rename `src/index.ts` or
  document the dual-file relationship explicitly.
- [ ] Extend T0.12: add the `--resume <id>` transcript-append verification
  scenario.
- [ ] Add concurrent-capture concurrency limit + env override + queue/reject
  semantics; add a test.
- [ ] Fix D9 stale "four hooks" rationale text.
- [ ] Pin the `randomBytes` length for socket paths; add path-length
  assertion in `src/mcp/ipc.ts`.
- [ ] Promote T0.13 to Phase 0 hard gate; extend D20 `hook_response` shape
  if T0.13 finds a richer schema is needed.
