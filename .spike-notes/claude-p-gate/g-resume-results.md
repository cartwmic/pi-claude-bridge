# G-resume — `--input-file` AND `--system-prompt-file` forwarding through claude-p

**Date:** 2026-06-01T23:53:07.556Z · claude-p 0.1.0 · claude 2.1.159 · model claude-haiku-4-5
**Method:** ONE claude-p spawn (no tools). User prompt (~64KB, sentinel `INPUTFILE_SENTINEL_D48983781C7C5E7F` buried in filler) via `--input-file`; system prompt ("end every reply with ZX9") via `--system-prompt-file`. Exact production argv from `buildClaudePArgs({prompt:{kind:"file"}, systemPrompt:{kind:"file"}})`.

## Results

- spawn arg-rejected (unknown option / invalid): **no**
- buildClaudePArgs threw: **no**
- clean turn (`result`): **true**
- model echoed the >50KB input-file SENTINEL: **true** (in assistant text: true)
- system-prompt-file token ZX9 present: **true** (in assistant text: true)
- attempts: [{"attempt":1,"exit":0,"sawResult":true,"sentinel":true,"sysToken":true,"argRejected":false,"argError":false}]

## Verdict

**BOTH `--input-file` AND `--system-prompt-file` are FORWARDED and HONORED through claude-p.** The model echoed the sentinel buried in the >50KB `--input-file` prompt (proving the large input reached the model) AND ended its reply with the `--system-prompt-file` token ZX9 (proving the system-prompt-file was applied). The bridge's >50KB overflow path in index.ts is SAFE.

## index.ts >50KB overflow path

SAFE — no change needed. index.ts may continue to switch the prompt/system-prompt to `--input-file`/`--system-prompt-file` above 50KB; both flags are forwarded by claude-p to `claude` and honored through the PTY-driven interactive session.

## Raw run log
```
===== ATTEMPT 1 START 2026-06-01T23:53:01.490Z =====
[a1] argv has --input-file=true --system-prompt-file=true promptBytes=126313
[a1] EXIT code=0 signal=null sawResult=true argRejected=false
===== ATTEMPT 1 END exit=0 sawResult=true sentinel=true sysToken=true =====
```
