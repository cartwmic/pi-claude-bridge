# PromptNotAccepted matrix aggregate

- claude-p: /Users/cartwmic/.pi/agent/git/github.com/cartwmic/pi-claude-bridge/node_modules/.bin/claude-p
- cwd: /Users/cartwmic/.pi/agent/git/github.com/cartwmic/pi-claude-bridge
- timeout: 45s
- generated: 2026-06-16T02:35:57.477Z

| Cell | Model | Prompt len | Concurrency | Trials | Pass | PromptNotAccepted | Other fail | Median wall |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| E-len801-opus-c1 | claude-opus-4-8 | 801 | 1 | 5 | 0 | 5 | 0 | 3.28s |
| E-len802-opus-c1 | claude-opus-4-8 | 802 | 1 | 5 | 0 | 5 | 0 | 3.27s |
| E-len803-opus-c1 | claude-opus-4-8 | 803 | 1 | 5 | 0 | 5 | 0 | 3.29s |
| E-len804-opus-c1 | claude-opus-4-8 | 804 | 1 | 5 | 0 | 5 | 0 | 3.28s |

## Last traces

- E-len801-opus-c1 #1: exit=2 ok=false pna=true wall=3277ms — [claude-p +2853ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
- E-len801-opus-c1 #2: exit=2 ok=false pna=true wall=3266ms — [claude-p +2817ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
- E-len801-opus-c1 #3: exit=2 ok=false pna=true wall=3293ms — [claude-p +2848ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
- E-len801-opus-c1 #4: exit=2 ok=false pna=true wall=3291ms — [claude-p +2824ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
- E-len801-opus-c1 #5: exit=2 ok=false pna=true wall=3258ms — [claude-p +2808ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
- E-len802-opus-c1 #1: exit=2 ok=false pna=true wall=3261ms — [claude-p +2792ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
- E-len802-opus-c1 #2: exit=2 ok=false pna=true wall=3267ms — [claude-p +2809ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
- E-len802-opus-c1 #3: exit=2 ok=false pna=true wall=3315ms — [claude-p +2854ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
- E-len802-opus-c1 #4: exit=2 ok=false pna=true wall=3266ms — [claude-p +2813ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
- E-len802-opus-c1 #5: exit=2 ok=false pna=true wall=3274ms — [claude-p +2823ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
- E-len803-opus-c1 #1: exit=2 ok=false pna=true wall=3296ms — [claude-p +2828ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
- E-len803-opus-c1 #2: exit=2 ok=false pna=true wall=3274ms — [claude-p +2813ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
- E-len803-opus-c1 #3: exit=2 ok=false pna=true wall=3224ms — [claude-p +2777ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
- E-len803-opus-c1 #4: exit=2 ok=false pna=true wall=3288ms — [claude-p +2825ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
- E-len803-opus-c1 #5: exit=2 ok=false pna=true wall=3291ms — [claude-p +2835ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
- E-len804-opus-c1 #1: exit=2 ok=false pna=true wall=3299ms — [claude-p +2851ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
- E-len804-opus-c1 #2: exit=2 ok=false pna=true wall=3276ms — [claude-p +2831ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
- E-len804-opus-c1 #3: exit=2 ok=false pna=true wall=3274ms — [claude-p +2808ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
- E-len804-opus-c1 #4: exit=2 ok=false pna=true wall=3241ms — [claude-p +2795ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
- E-len804-opus-c1 #5: exit=2 ok=false pna=true wall=3305ms — [claude-p +2856ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
