# claude-p `PromptNotAccepted` root-cause spike

Date: 2026-06-16  
Data dir: `/Users/cartwmic/.pi/agent/git/github.com/cartwmic/pi-claude-bridge/.spike-notes/claude-p-gate/promptnotaccepted-rootcause-2026-06-16T02-29-11-767Z`

## Harness used

Production code was not changed. I added/copied only spike artifacts:

- `matrix-promptnotaccepted.mjs` — launches real `claude-p` with bridge-like flags: `--model`, `--system-prompt`, bridge disallow list, `--strict-mcp-config`, `--setting-sources ""`, `--permission-mode bypassPermissions`, fresh `--session-id`, `--output-format stream-json`, `--verbose`, `--timeout 45`, `--debug`, and child `--debug-file`.
- `raw-ink-echo-probe.py` — launches real interactive `claude` in a PTY, types a prompt without pressing Enter, and captures raw Ink output. This does not submit a paid turn; it observes the input-box echo only.

Main run:

```sh
node .spike-notes/claude-p-gate/matrix-promptnotaccepted.mjs \
  --trials 5 --c-batches 5 --timeout 45 --include-threshold
```

Extra threshold narrowing:

```sh
node .spike-notes/claude-p-gate/matrix-promptnotaccepted.mjs \
  --out <data-dir>/extra-threshold-801-804 --trials 5 --timeout 45 \
  --only-threshold --lengths 801,802,803,804

node .spike-notes/claude-p-gate/matrix-promptnotaccepted.mjs \
  --out <data-dir>/extra-threshold-805-850 --trials 5 --timeout 45 \
  --only-threshold --lengths 805,810,815,820,825,830,840,850
```

Claude auth/quota did **not** block the real boots.

## Matrix results

| Cell | Model | Len | Conc | Trials | Pass | PNA | Other | Median wall |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| A-long-opus-c1 | claude-opus-4-8 | 850 | 1 | 5 | 0 | 5 | 0 | 3.27s |
| B-short-opus-c1 | claude-opus-4-8 | 13 | 1 | 5 | 5 | 0 | 0 | 2.60s |
| C-long-opus-c4 | claude-opus-4-8 | 850 | 4 | 20 | 0 | 20 | 0 | 3.48s |
| D-long-haiku-c1 | claude-haiku-4-5 | 850 | 1 | 5 | 0 | 5 | 0 | 3.26s |
| E-len50-opus-c1 | claude-opus-4-8 | 50 | 1 | 5 | 5 | 0 | 0 | 2.60s |
| E-len200-opus-c1 | claude-opus-4-8 | 200 | 1 | 5 | 5 | 0 | 0 | 2.72s |
| E-len400-opus-c1 | claude-opus-4-8 | 400 | 1 | 5 | 5 | 0 | 0 | 2.55s |
| E-len800-opus-c1 | claude-opus-4-8 | 800 | 1 | 5 | 5 | 0 | 0 | 2.48s |
| E-len801-opus-c1 | claude-opus-4-8 | 801 | 1 | 5 | 0 | 5 | 0 | 3.28s |
| E-len802-opus-c1 | claude-opus-4-8 | 802 | 1 | 5 | 0 | 5 | 0 | 3.27s |
| E-len803-opus-c1 | claude-opus-4-8 | 803 | 1 | 5 | 0 | 5 | 0 | 3.29s |
| E-len804-opus-c1 | claude-opus-4-8 | 804 | 1 | 5 | 0 | 5 | 0 | 3.28s |
| E-len805-opus-c1 | claude-opus-4-8 | 805 | 1 | 5 | 0 | 5 | 0 | 3.27s |
| E-len810-opus-c1 | claude-opus-4-8 | 810 | 1 | 5 | 0 | 5 | 0 | 3.26s |
| E-len815-opus-c1 | claude-opus-4-8 | 815 | 1 | 5 | 0 | 5 | 0 | 3.26s |
| E-len820-opus-c1 | claude-opus-4-8 | 820 | 1 | 5 | 0 | 5 | 0 | 3.29s |
| E-len825-opus-c1 | claude-opus-4-8 | 825 | 1 | 5 | 0 | 5 | 0 | 3.28s |
| E-len830-opus-c1 | claude-opus-4-8 | 830 | 1 | 5 | 0 | 5 | 0 | 3.26s |
| E-len840-opus-c1 | claude-opus-4-8 | 840 | 1 | 5 | 0 | 5 | 0 | 3.27s |
| E-len850-opus-c1 | claude-opus-4-8 | 850 | 1 | 5 | 0 | 5 | 0 | 3.29s |

Typical failing stderr tail:

```text
[claude-p +777ms] typing prompt (850 bytes), attempt 1
[claude-p +1580ms] typing prompt (850 bytes), attempt 2
[claude-p +2393ms] typing prompt (850 bytes), attempt 3
[claude-p +3166ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
claude-p: PromptNotAccepted
```

## Definitive root cause

`PromptNotAccepted` is caused by Claude Code/Ink's long-prompt paste-collapse display path, not by concurrent boot contention.

In this environment the boundary is exact for the generated single-line probe: **800 bytes passes; 801 bytes fails**. At 801+ bytes, Ink does not echo the literal prompt text into the input box. It renders a collapsed paste placeholder instead.

The raw PTY probe proves that. For an 850-byte failing prompt, the visible UI contains:

```text
[Pastedtext#1]
paste again to expand
```

The raw bytes around the placeholder are:

```text
5b 50 61 73 74 65 64 1b 5b 31 31 47 74 65 78 74 1b 5b 31 36 47 23 31 5d
[  P  a  s  t  e  d  ESC [  1  1  G  t  e  x  t  ESC [  1  6  G  #  1  ]
```

So Ink writes `Pasted`, moves the cursor with CSI (`ESC[11G`), writes `text`, moves again, then writes `#1]`. After `claude-p`'s CSI stripping, this becomes `Pastedtext#1` — **not** the literal marker string `Pasted text`.

That explains the current code path exactly:

1. Literal echo needle cannot match because the long prompt is not displayed literally.
2. The paste-collapse fallback also misses because it searches stripped text for `"Pasted text"` with a space.
3. `claude-p` retries three times and exits code 2 with `PromptNotAccepted`.

The child `--debug-file` and `claude-p --debug` logs were captured for each failing trial. Grepping those files for paste/bracket markers does not show the placeholder because Claude's debug file does not record the raw Ink screen buffer and claude-p debug logs only pane-output byte counts. The separate raw PTY probe captures the missing evidence.

## What is disproven

- **Concurrency is not required.** Long opus concurrency-1 failed 5/5. Long opus concurrency-4 failed 20/20 with the same error and similar ~3.5s wall time.
- **Model is not the cause.** Long haiku concurrency-1 failed 5/5 with the same error and ~3.3s wall time.
- **Auth/quota is not the cause.** Short opus trials completed normally 5/5 and produced `OK` results.

## Recommended fix direction (do not implement in this spike)

Target the echo-confirmation logic in `claude-p`, not bridge boot scheduling:

- Treat the paste-collapse placeholder as confirmation after terminal-control normalization. Concretely, match the normalized/alnum projection (`Pastedtext`) or match both `Pasted` and `paste again to expand` in the recent PTY buffer, rather than requiring stripped text to contain literal `Pasted text` with a space.
- Add a unit test using the captured raw sequence: `[Pasted\x1b[11Gtext\x1b[16G#1]` should confirm echo.
- Keep the literal-needle path for short prompts.

A scheduling/concurrency fix would not address the proven failure mode: a single isolated 801+ byte prompt can reproduce it deterministically.
