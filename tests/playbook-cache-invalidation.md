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

## Related

- `tests/int-cache.sh` — automated cache efficiency test (steady-state, no git changes)
- Commit `eae401b` — the fix: static system prompt + settingSources: []
