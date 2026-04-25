# Cache Invalidation Test Playbook

Manual test scenarios for verifying prompt cache behavior across turns.
Each scenario describes a procedure and what to measure. Run the same
scenario before and after a fix to compare (red/green).

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

---

## Scenario 1: Git State Change

Verifies prompt cache survives project state changes (git add, git commit,
file edits) between turns.

### Procedure

1. **Start Pi session** in pane 1:
   ```bash
   cd ~/.local/share/chezmoi
   pi
   ```

2. **Drive 3 warm-up turns** (one at a time, wait for each response):
   ```
   "Say exactly: HELLO"
   "Say exactly: WORLD"
   "Remember the code word FALCON-7. Say exactly: READY"
   ```

3. **Change git state** in pane 2 (while Pi session stays open):
   ```bash
   cd ~/.local/share/chezmoi
   echo "cache-test-$(date +%s)" > cache-test-temp.txt
   git add cache-test-temp.txt
   ```

4. **Drive 2 post-change turns** in pane 1:
   ```
   "Say exactly: AFTER_CHANGE"
   "Say exactly: VERIFY"
   ```

5. **Conversation coherence check** — verify the model still has context
   from before the git state change:
   ```
   "What was the code word I told you to remember?"
   ```
   The model should respond with FALCON-7. If it can't recall, the
   conversation context was broken despite what cache metrics show.

6. **Exit Pi and clean up**:
   ```bash
   cd ~/.local/share/chezmoi
   git reset HEAD cache-test-temp.txt
   rm -f cache-test-temp.txt
   ```

6. **Analyze** — run the analysis script below.

### What to measure

| Turn | Key metric |
|------|------------|
| 1 | Baseline: cacheWrite high (cold start), cacheRead ≈ 0 |
| 2–3 | Steady state: cacheRead growing, cacheWrite small |
| **4** | **First turn after git change — does cacheRead drop? Does cacheWrite spike?** |
| 5 | Recovery: does cache warm back up? |
| **6** | **Coherence: does the model recall FALCON-7?** |

A cache-stable implementation shows no drop at turn 4 and the model
recalls the code word at turn 6. A broken one shows
cacheRead dropping significantly and cacheWrite spiking.

### Bug context

The `preset: "claude_code"` system prompt injects dynamic content (git
status, date, OS, cwd, CLAUDE.md) on every CLI spawn. When git state changes,
the system prompt changes, breaking the cached prefix.

**Fix** (commit `eae401b`): Static string system prompt + `settingSources: []`.

### Observed results (2026-04-25)

| Variant | Turn 4 cacheWrite | Effect |
|---------|-------------------|--------|
| `preset: "claude_code"` (no fix) | 11,745 | cacheRead dropped ~40% |
| `excludeDynamicSections: true` | 6,909 | 41% improvement (partial) |
| Static string + `settingSources: []` | 16 | 99.9% improvement |

---

## Scenario 2: User Abort

Verifies prompt cache survives user aborts (Escape / Ctrl+C) without
a full CC session rebuild.

### Procedure

1. **Start Pi session** in pane 1:
   ```bash
   cd ~/.local/share/chezmoi
   pi
   ```

2. **Drive 3 warm-up turns** (one at a time, wait for each response):
   ```
   "Say exactly: HELLO"
   "Say exactly: WORLD"
   "Remember the code word BLUE-42. Say exactly: READY"
   ```

3. **Start a long turn and abort it**:
   ```
   "Write a detailed 500-word essay about the history of Unix"
   ```
   Wait 2–3 seconds for streaming to start, then **press Escape** to abort.

4. **Drive 2 post-abort turns**:
   ```
   "Say exactly: AFTER_ABORT"
   "Say exactly: VERIFY"
   ```

5. **Conversation coherence check** — verify the model still has context
   from before the abort:
   ```
   "What was the code word I told you to remember?"
   ```
   The model should respond with BLUE-42. If it can't recall, the
   conversation context was broken despite what cache metrics show.
   (This is the check that caught the original race condition — cache
   metrics showed REUSE but immediate truncation raced with CC CLI
   cleanup, corrupting the session file.)

6. **Exit Pi and analyze.**

### What to measure

| Turn | Key metric |
|------|------------|
| 1 | Baseline: cacheWrite high (cold start), cacheRead ≈ 0 |
| 2–3 | Steady state: cacheRead growing, cacheWrite small |
| 4 | Aborted — partial output, may show partial cache metrics |
| **5** | **First turn after abort — does cacheRead drop? Does cacheWrite spike?** |
| 6 | Recovery: does cache warm back up? |
| **7** | **Coherence: does the model recall BLUE-42?** |

A cache-stable implementation shows no drop at turn 5 and the model
recalls the code word at turn 7. A broken one shows
cacheRead dropping to ~26k (tools-only prefix) and cacheWrite spiking to
the full conversation size (session REBUILD).

### Bug context

On abort, the bridge sets `needsRebuild=true`. The next turn's
`syncSharedSession` skips the REUSE path and does a full REBUILD — rewriting
all conversation messages to a new CC session file.

The dying CC CLI process writes stray records to the JSONL
(`[Request interrupted by user]` + `last-prompt`), but these are
deterministic, tail-only, and the process has exited by the time the user
sends their next message. CC CLI is stateless between spawns — the JSONL
file is the complete state.

**Fix**: Record session file byte offset before each query. On abort (after
`consumeQuery` resolves = process stdout closed), defer truncation to the
next turn's `syncSharedSession` (avoids racing with CC CLI's SIGTERM
cleanup writes). Before truncating, verify the file hasn't shrunk below
the truncation target — if it has, fall back to REBUILD. Clear
`needsRebuild` and allow REUSE. Keep REBUILD as a fallback if `--resume`
fails.

### Observed results

| Variant | Turn 5 cacheRead | Turn 5 cacheWrite | Effect |
|---------|------------------|-------------------|--------|
| `needsRebuild=true` (no fix) | 26,689 (tools-only) | 84,346 | Full rebuild, UUID rotated |
| Byte-offset truncation + cursor advance | stable (REUSE) | small | No rebuild, same session UUID |

---

## Analysis Scripts

### Per-turn cache metrics

```bash
SESSION=$(ls -t ~/.pi/agent/sessions/--Users-cartwmic-.local-share-chezmoi--/*.jsonl | head -1)
echo "=== Session: $(basename $SESSION) ==="
python3 -c "
import json

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

### Per-turn aggregation (handles multi-API-call turns)

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
    flag = ''
    if t > 1 and d['cacheRead'] < prev_cr * 0.5:
        flag = ' <-- REBUILD (cache read dropped >50%)'
    elif t == 1:
        flag = ' <-- cold start'
    print(f\"{t:>5} {d['apis']:>5} {d['cacheRead']:>9,} {d['cacheWrite']:>9,} {flag}\")
    prev_cr = max(d['cacheRead'], prev_cr)
"
```

### Bridge debug log

```bash
# Check sync path and abort handling:
grep 'syncResult:\|abort.*needsRebuild\|preQueryFileSize\|truncat' \
  "$CLAUDE_BRIDGE_DEBUG_PATH" 2>/dev/null | tail -20
```

---

## Related

- `tests/int-cache.sh` — automated cache efficiency test (steady-state, no git changes)
- Commit `eae401b` — static system prompt + settingSources: []
- Commit `68db18f` — abort truncation + cursor advance
