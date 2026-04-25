# Git-State-Change Cache Invalidation Playbook

Manual red/green test for verifying that prompt cache survives project state
changes (git add, git commit, file edits) across turns.

## Background

The Claude Agent SDK's `preset: "claude_code"` injects dynamic content (git
status, current date, OS, cwd, CLAUDE.md) into both the system prompt and user
messages on every CLI spawn. The bridge spawns a new CLI process per turn. When
git state changes between turns, the injected content changes, breaking the
prompt cache prefix for all subsequent content.

**Fix**: Use a static string system prompt instead of `preset: "claude_code"`,
and set `settingSources: []` to prevent the CLI from loading filesystem settings
that inject additional dynamic content.

## Setup

### Prerequisites

```bash
# Pi with claude-bridge extension
pi --version
# A git repo to work in
cd ~/.local/share/chezmoi   # or any git repo
git status
```

### Tmux layout

```bash
# Pane 1: Pi TUI session
# Pane 2: monitoring / analysis
tmux new-session -s cache-test -d
tmux split-window -h -t cache-test
```

## RED test (preset: "claude_code" — dynamic system prompt)

> Run this BEFORE applying the fix to confirm the bug exists.

### Step 1: Start Pi session

In pane 1:
```bash
cd ~/.local/share/chezmoi
pi
```

### Step 2: Drive 3 warm-up turns

Type these prompts one at a time, waiting for each response:

```
Turn 1: "Say exactly: HELLO"
Turn 2: "Say exactly: WORLD"
Turn 3: "Say exactly: READY"
```

### Step 3: Change git state

In pane 2 (while Pi session stays open):
```bash
cd ~/.local/share/chezmoi
echo "cache-test-$(date +%s)" > cache-test-temp.txt
git add cache-test-temp.txt
```

This stages a new file, changing `git status` output.

### Step 4: Drive 2 post-change turns

Back in pane 1:
```
Turn 4: "Say exactly: AFTER_CHANGE"
Turn 5: "Say exactly: VERIFY"
```

### Step 5: Exit Pi and clean up git

```bash
cd ~/.local/share/chezmoi
git reset HEAD cache-test-temp.txt
rm -f cache-test-temp.txt
```

### Step 6: Analyze

Run the analysis script below.

### RED pass criteria

| Turn | Expected behavior |
|------|-------------------|
| 1 | cacheWrite high (cold start), cacheRead ≈ 0 |
| 2 | cacheRead growing, cacheWrite small (warm) |
| 3 | cacheRead growing, cacheWrite small (warm) |
| **4** | **cacheRead DROPS significantly, cacheWrite jumps (CACHE MISS — git status changed)** |
| 5 | cacheRead recovers (warm again with new prefix) |

**RED passes if Turn 4 shows a significant cache read drop after the git state change.**

## GREEN test (static string system prompt + settingSources: [])

> Run this AFTER applying the fix to confirm cache stability.

### Pre-step: Verify the fix is applied

```bash
# In index.ts, the queryOptions should use:
#   systemPrompt: staticSystemPrompt,   // NOT preset: "claude_code"
#   settingSources: [],                  // NOT undefined or ["user", "project"]
grep -n 'staticSystemPrompt\|settingSources: \[\]' ~/git/pi-claude-bridge/index.ts
```

### Run identical steps 1–6

### GREEN pass criteria

| Turn | Expected behavior |
|------|-------------------|
| 1 | cacheWrite high (cold start), cacheRead ≈ 0 |
| 2 | cacheRead growing, cacheWrite small (warm) |
| 3 | cacheRead growing, cacheWrite small (warm) |
| **4** | **cacheRead stable or growing, cacheWrite small (CACHE HIT PRESERVED)** |
| 5 | cacheRead stable or growing, cacheWrite small (warm) |

**GREEN passes if Turn 4 does NOT show a cache read drop — the system prompt stayed stable because no dynamic content is injected.**

## Analysis script

Run after each test to extract per-turn cache metrics from the session JSONL:

```bash
SESSION=$(ls -t ~/.pi/agent/sessions/--Users-cartwmic-.local-share-chezmoi--/*.jsonl | head -1)
echo "=== Session: $(basename $SESSION) ==="
python3 -c "
import json, sys

idx = 0
prev_cr = 0
with open('$SESSION') as f:
    for line in f:
        line = line.strip()
        if not line: continue
        try:
            obj = json.loads(line)
            if obj.get('type') == 'message' and 'message' in obj:
                msg = obj['message']
                usage = msg.get('usage', {})
                if msg.get('role') == 'assistant' and usage and usage.get('totalTokens', 0) > 0:
                    idx += 1
                    cr = usage.get('cacheRead', 0)
                    cw = usage.get('cacheWrite', 0)
                    inp = usage.get('input', 0)
                    total = cr + cw + inp
                    hit_pct = (cr / total * 100) if total > 0 else 0
                    flag = ''
                    if idx > 1 and cr < prev_cr * 0.8:
                        flag = '  <-- CACHE MISS (read dropped >20%)'
                    elif idx == 1:
                        flag = '  <-- cold start'
                    print(f'Turn {idx}: cacheRead={cr:>8,}  cacheWrite={cw:>8,}  hit%={hit_pct:.1f}%{flag}')
                    prev_cr = max(cr, prev_cr)
        except:
            pass
"
```

## Observed results (2026-04-25)

### RED (preset: "claude_code", no fix)

```
Turn 4 after git change: cacheWrite=11,745  cacheRead dropped ~40%
```

System prompt changed due to git status injection → prefix invalidated →
~30k tokens/turn of cache writes.

### GREEN (excludeDynamicSections: true, partial fix)

```
Turn 4 after git change: cacheWrite=6,909  (41% improvement)
```

System prompt stable, but CLI still injected `<system-reminder>` blocks with
dynamic content into user messages → cache still broke at message boundary.

### FINAL (static string prompt + settingSources: [])

```
Turn 4 after git change: cacheWrite=16  (99.9% improvement)
```

No dynamic content injected anywhere. Cache fully stable across git state
changes. Total tokens per turn dropped from ~30k to ~6.8k.

---

# Scenario 2: Abort-Triggered Cache Invalidation

Manual red/green test for verifying that prompt cache survives user aborts
(Escape / Ctrl+C) without a full CC session rebuild.

## Background

When the user aborts a turn, the bridge kills the CC CLI process. The dying
process writes stray records to the session JSONL (`[Request interrupted by
user]` + `last-prompt`). The current bridge defense is to set
`needsRebuild=true`, which forces a full session REBUILD on the next turn —
rewriting all conversation messages to a new CC session file. This causes a
massive cache-write spike (observed: 84k tokens in a mid-session abort).

**Root cause**: The bridge treats every abort as session corruption, even
though the stray records are deterministic, tail-only, and the CC CLI process
has fully exited by the time the user sends their next message.

**Architecture context**: CC CLI is stateless between spawns. Each `query()`
spawns a fresh process that reads the JSONL from scratch on `--resume`. The
Anthropic Messages API is also stateless — no server-side session object.
The JSONL file IS the complete state. If it contains a clean conversation,
CC will resume correctly regardless of what happened in a prior process.

**Fix**: Record the session file's byte offset before each query. On abort,
after the CC process exits (stdout closes → `consumeQuery` promise resolves),
truncate the file back to its pre-query size. This removes everything the
aborted turn wrote — including stray interrupt records — without parsing or
assuming anything about CC's internal cleanup format. Clear `needsRebuild`
and allow REUSE on the next turn. Keep REBUILD as a fallback if `--resume`
fails for any reason.

## Setup

Same tmux layout as Scenario 1.

## RED test (current behavior: needsRebuild=true on abort)

> Run BEFORE applying the abort fix. Requires the static system prompt fix
> from Scenario 1 to be applied (isolates the abort effect from the dynamic
> prompt effect).

### Step 1: Start Pi session

In pane 1:
```bash
cd ~/.local/share/chezmoi
pi
```

### Step 2: Drive 3 warm-up turns

```
Turn 1: "Say exactly: HELLO"
Turn 2: "Say exactly: WORLD"
Turn 3: "Say exactly: READY"
```

Wait for each response to complete. Verify cache is warm (cacheRead growing
across turns).

### Step 3: Start a long turn and abort it

```
Turn 4: "Write a detailed 500-word essay about the history of Unix"
```

Wait 2–3 seconds for streaming to start, then **press Escape** (or Ctrl+C)
to abort the turn.

### Step 4: Drive 2 post-abort turns

```
Turn 5: "Say exactly: AFTER_ABORT"
Turn 6: "Say exactly: VERIFY"
```

### Step 5: Exit Pi and analyze

Run the analysis script (same as Scenario 1, or the per-turn aggregation
script below).

### RED pass criteria

| Turn | Expected behavior |
|------|-------------------|
| 1 | cacheWrite high (cold start), cacheRead ≈ 0 |
| 2 | cacheRead growing, cacheWrite small (warm) |
| 3 | cacheRead growing, cacheWrite small (warm) |
| 4 | Aborted — partial output, may show partial cache metrics |
| **5** | **cacheRead DROPS to tools-only (~26k), cacheWrite jumps to full conversation size (REBUILD)** |
| 6 | cacheRead recovers (warm again after rebuild) |

**RED passes if Turn 5 (first turn after abort) shows cacheRead dropping to
~26k (tools-only prefix) and cacheWrite spiking to the full conversation
size.** This confirms the bridge did a full session REBUILD due to
`needsRebuild=true`.

## GREEN test (byte-offset truncation + REUSE)

> Run AFTER applying the abort fix.

### Pre-step: Verify the fix is applied

```bash
# In index.ts, look for:
#   - preQueryFileSize tracking before query()
#   - truncateSync on abort path
#   - needsRebuild NOT set (or cleared after truncation)
grep -n 'preQueryFileSize\|truncateSync\|needsRebuild' ~/git/pi-claude-bridge/index.ts
```

### Run identical steps 1–5

### GREEN pass criteria

| Turn | Expected behavior |
|------|-------------------|
| 1 | cacheWrite high (cold start), cacheRead ≈ 0 |
| 2 | cacheRead growing, cacheWrite small (warm) |
| 3 | cacheRead growing, cacheWrite small (warm) |
| 4 | Aborted — partial output |
| **5** | **cacheRead stable or growing, cacheWrite small (REUSE — no rebuild)** |
| 6 | cacheRead stable or growing, cacheWrite small (warm) |

**GREEN passes if Turn 5 does NOT show a cache read drop — the session file
was truncated to its pre-abort state and the bridge resumed (REUSE) instead
of rebuilding.**

## Per-turn aggregation analysis script

Use this to aggregate cache metrics by user turn (handles multi-API-call
turns from tool use loops):

```bash
SESSION=$(ls -t ~/.pi/agent/sessions/--Users-cartwmic-.local-share-chezmoi--/*.jsonl | head -1)
echo "=== Session: $(basename $SESSION) ==="
python3 -c "
import json
from collections import defaultdict

turn_num = 0
by_turn = defaultdict(lambda: {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0, 'apis': 0})

with open('$SESSION') as f:
    for line in f:
        line = line.strip()
        if not line: continue
        try:
            obj = json.loads(line)
            if obj.get('type') == 'message' and obj.get('message', {}).get('role') == 'user':
                turn_num += 1
            if obj.get('type') == 'message' and obj.get('message', {}).get('role') == 'assistant':
                u = obj.get('message', {}).get('usage', {})
                if u.get('totalTokens', 0) > 0:
                    d = by_turn[turn_num]
                    d['input'] += u.get('input', 0)
                    d['output'] += u.get('output', 0)
                    d['cacheRead'] += u.get('cacheRead', 0)
                    d['cacheWrite'] += u.get('cacheWrite', 0)
                    d['apis'] += 1
        except: pass

print(f\"{'Turn':>5} {'APIs':>5} {'CacheRd':>9} {'CacheWr':>9} {'Notes'}\")
print('-' * 50)
prev_cr = 0
for t in sorted(by_turn.keys()):
    d = by_turn[t]
    # Use the max cacheRead within the turn (last API call has most context)
    flag = ''
    if t > 1 and d['cacheRead'] < prev_cr * 0.5:
        flag = ' <-- REBUILD (cache read dropped >50%)'
    elif t == 1:
        flag = ' <-- cold start'
    print(f\"{t:>5} {d['apis']:>5} {d['cacheRead']:>9,} {d['cacheWrite']:>9,} {flag}\")
    prev_cr = max(d['cacheRead'], prev_cr)
"
```

## Bridge debug log analysis

The bridge emits `syncResult: path=reuse|rebuild|clean-start` on each sync.
After an abort, check whether the next turn used REUSE or REBUILD:

```bash
# CLAUDE_BRIDGE_DEBUG_PATH is set by the bridge when debug logging is enabled
# Check the sync path for each turn:
grep 'syncResult:\|abort.*needsRebuild\|preQueryFileSize\|truncat' \
  "$CLAUDE_BRIDGE_DEBUG_PATH" 2>/dev/null | tail -20
```

- **RED**: expect `needsRebuild` followed by `path=rebuild`
- **GREEN**: expect `truncat` followed by `path=reuse`

## Observed results

### RED (needsRebuild=true, no truncation)

```
Turn 5 after abort: cacheRead=26,689 (tools-only), cacheWrite=84,346 (full rebuild)
```

Bridge set `needsRebuild=true` → `syncSharedSession` skipped REUSE → full
REBUILD → all conversation messages rewritten → 84k cache write penalty.

### GREEN (byte-offset truncation + REUSE)

```
(not yet tested — implement fix first)
```

---

## Related

- `tests/int-cache.sh` — automated cache efficiency test (steady-state, no git changes)
- Commit `eae401b` — the fix: static system prompt + settingSources: []
- Scenario 1 above — git-state-change cache invalidation (prerequisite fix)
