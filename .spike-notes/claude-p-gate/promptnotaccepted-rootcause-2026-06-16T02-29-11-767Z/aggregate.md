# PromptNotAccepted matrix aggregate

- claude-p: /Users/cartwmic/.pi/agent/git/github.com/cartwmic/pi-claude-bridge/node_modules/.bin/claude-p
- cwd: /Users/cartwmic/.pi/agent/git/github.com/cartwmic/pi-claude-bridge
- timeout: 45s
- generated: 2026-06-16T02:31:23.323Z

| Cell | Model | Prompt len | Concurrency | Trials | Pass | PromptNotAccepted | Other fail | Median wall |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| A-long-opus-c1 | claude-opus-4-8 | 850 | 1 | 5 | 0 | 5 | 0 | 3.27s |
| B-short-opus-c1 | claude-opus-4-8 | 13 | 1 | 5 | 5 | 0 | 0 | 2.60s |
| C-long-opus-c4 | claude-opus-4-8 | 850 | 4 | 20 | 0 | 20 | 0 | 3.49s |
| D-long-haiku-c1 | claude-haiku-4-5 | 850 | 1 | 5 | 0 | 5 | 0 | 3.26s |
| E-len200-opus-c1 | claude-opus-4-8 | 200 | 1 | 5 | 5 | 0 | 0 | 2.72s |
| E-len400-opus-c1 | claude-opus-4-8 | 400 | 1 | 5 | 5 | 0 | 0 | 2.55s |
| E-len50-opus-c1 | claude-opus-4-8 | 50 | 1 | 5 | 5 | 0 | 0 | 2.60s |
| E-len800-opus-c1 | claude-opus-4-8 | 800 | 1 | 5 | 5 | 0 | 0 | 2.48s |

## Last traces

- A-long-opus-c1 #1: exit=2 ok=false pna=true wall=3849ms — [claude-p +3396ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
- A-long-opus-c1 #2: exit=2 ok=false pna=true wall=3267ms — [claude-p +2840ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
- A-long-opus-c1 #3: exit=2 ok=false pna=true wall=3249ms — [claude-p +2807ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
- A-long-opus-c1 #4: exit=2 ok=false pna=true wall=3278ms — [claude-p +2829ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
- A-long-opus-c1 #5: exit=2 ok=false pna=true wall=3271ms — [claude-p +2819ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
- B-short-opus-c1 #1: exit=0 ok=true pna=false wall=7743ms — [claude-p +7695ms] run() returning (total_lines_streamed=5, duration=7695ms)
- B-short-opus-c1 #2: exit=0 ok=true pna=false wall=2602ms — [claude-p +2565ms] run() returning (total_lines_streamed=4, duration=2565ms)
- B-short-opus-c1 #3: exit=0 ok=true pna=false wall=2997ms — [claude-p +2962ms] run() returning (total_lines_streamed=5, duration=2962ms)
- B-short-opus-c1 #4: exit=0 ok=true pna=false wall=2526ms — [claude-p +2495ms] run() returning (total_lines_streamed=5, duration=2495ms)
- B-short-opus-c1 #5: exit=0 ok=true pna=false wall=2597ms — [claude-p +2561ms] run() returning (total_lines_streamed=5, duration=2561ms)
- C-long-opus-c4 #1: exit=2 ok=false pna=true wall=3491ms — [claude-p +3042ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
- C-long-opus-c4 #2: exit=2 ok=false pna=true wall=3549ms — [claude-p +3098ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
- C-long-opus-c4 #3: exit=2 ok=false pna=true wall=3570ms — [claude-p +3118ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
- C-long-opus-c4 #4: exit=2 ok=false pna=true wall=3571ms — [claude-p +3136ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
- C-long-opus-c4 #5: exit=2 ok=false pna=true wall=3501ms — [claude-p +3044ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
- C-long-opus-c4 #6: exit=2 ok=false pna=true wall=3460ms — [claude-p +2999ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
- C-long-opus-c4 #7: exit=2 ok=false pna=true wall=3460ms — [claude-p +3010ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
- C-long-opus-c4 #8: exit=2 ok=false pna=true wall=3471ms — [claude-p +3010ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
- C-long-opus-c4 #9: exit=2 ok=false pna=true wall=3447ms — [claude-p +3009ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
- C-long-opus-c4 #10: exit=2 ok=false pna=true wall=3692ms — [claude-p +3282ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
- C-long-opus-c4 #11: exit=2 ok=false pna=true wall=3427ms — [claude-p +2988ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
- C-long-opus-c4 #12: exit=2 ok=false pna=true wall=3472ms — [claude-p +3041ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
- C-long-opus-c4 #13: exit=2 ok=false pna=true wall=3433ms — [claude-p +2977ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
- C-long-opus-c4 #14: exit=2 ok=false pna=true wall=3447ms — [claude-p +3004ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
- C-long-opus-c4 #15: exit=2 ok=false pna=true wall=3430ms — [claude-p +3004ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
- C-long-opus-c4 #16: exit=2 ok=false pna=true wall=3400ms — [claude-p +2948ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
- C-long-opus-c4 #17: exit=2 ok=false pna=true wall=3493ms — [claude-p +3038ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
- C-long-opus-c4 #18: exit=2 ok=false pna=true wall=3499ms — [claude-p +3048ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
- C-long-opus-c4 #19: exit=2 ok=false pna=true wall=3496ms — [claude-p +3060ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
- C-long-opus-c4 #20: exit=2 ok=false pna=true wall=3495ms — [claude-p +3060ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
- D-long-haiku-c1 #1: exit=2 ok=false pna=true wall=3268ms — [claude-p +2800ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
- D-long-haiku-c1 #2: exit=2 ok=false pna=true wall=3257ms — [claude-p +2795ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
- D-long-haiku-c1 #3: exit=2 ok=false pna=true wall=3264ms — [claude-p +2820ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
- D-long-haiku-c1 #4: exit=2 ok=false pna=true wall=3318ms — [claude-p +2844ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
- D-long-haiku-c1 #5: exit=2 ok=false pna=true wall=3262ms — [claude-p +2801ms] prompt echo never confirmed after 3 attempt(s) — failing fast (PromptNotAccepted)
- E-len50-opus-c1 #1: exit=0 ok=true pna=false wall=8390ms — [claude-p +8354ms] run() returning (total_lines_streamed=5, duration=8354ms)
- E-len50-opus-c1 #2: exit=0 ok=true pna=false wall=2595ms — [claude-p +2552ms] run() returning (total_lines_streamed=5, duration=2552ms)
- E-len50-opus-c1 #3: exit=0 ok=true pna=false wall=2819ms — [claude-p +2789ms] run() returning (total_lines_streamed=5, duration=2788ms)
- E-len50-opus-c1 #4: exit=0 ok=true pna=false wall=2401ms — [claude-p +2363ms] run() returning (total_lines_streamed=4, duration=2363ms)
- E-len50-opus-c1 #5: exit=0 ok=true pna=false wall=2424ms — [claude-p +2383ms] run() returning (total_lines_streamed=5, duration=2383ms)
- E-len200-opus-c1 #1: exit=0 ok=true pna=false wall=2472ms — [claude-p +2436ms] run() returning (total_lines_streamed=5, duration=2436ms)
- E-len200-opus-c1 #2: exit=0 ok=true pna=false wall=2718ms — [claude-p +2684ms] run() returning (total_lines_streamed=5, duration=2684ms)
- E-len200-opus-c1 #3: exit=0 ok=true pna=false wall=2318ms — [claude-p +2271ms] run() returning (total_lines_streamed=4, duration=2271ms)
- E-len200-opus-c1 #4: exit=0 ok=true pna=false wall=5963ms — [claude-p +5927ms] run() returning (total_lines_streamed=5, duration=5927ms)
- E-len200-opus-c1 #5: exit=0 ok=true pna=false wall=3683ms — [claude-p +3644ms] run() returning (total_lines_streamed=5, duration=3644ms)
- E-len400-opus-c1 #1: exit=0 ok=true pna=false wall=3104ms — [claude-p +3066ms] run() returning (total_lines_streamed=5, duration=3066ms)
- E-len400-opus-c1 #2: exit=0 ok=true pna=false wall=2550ms — [claude-p +2513ms] run() returning (total_lines_streamed=5, duration=2513ms)
- E-len400-opus-c1 #3: exit=0 ok=true pna=false wall=2607ms — [claude-p +2567ms] run() returning (total_lines_streamed=5, duration=2567ms)
- E-len400-opus-c1 #4: exit=0 ok=true pna=false wall=2517ms — [claude-p +2482ms] run() returning (total_lines_streamed=4, duration=2482ms)
- E-len400-opus-c1 #5: exit=0 ok=true pna=false wall=2378ms — [claude-p +2341ms] run() returning (total_lines_streamed=5, duration=2341ms)
- E-len800-opus-c1 #1: exit=0 ok=true pna=false wall=3440ms — [claude-p +3399ms] run() returning (total_lines_streamed=5, duration=3399ms)
- E-len800-opus-c1 #2: exit=0 ok=true pna=false wall=2294ms — [claude-p +2256ms] run() returning (total_lines_streamed=5, duration=2256ms)
- E-len800-opus-c1 #3: exit=0 ok=true pna=false wall=2475ms — [claude-p +2438ms] run() returning (total_lines_streamed=5, duration=2438ms)
- E-len800-opus-c1 #4: exit=0 ok=true pna=false wall=2565ms — [claude-p +2525ms] run() returning (total_lines_streamed=4, duration=2525ms)
- E-len800-opus-c1 #5: exit=0 ok=true pna=false wall=2312ms — [claude-p +2273ms] run() returning (total_lines_streamed=4, duration=2273ms)
