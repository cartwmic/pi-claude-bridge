# Spike T0.14 RE-RUN — HARD GATE with TrustDialogScanner

**Result:** **PASS** (2026-05-21).

Ran `.spike-notes/14b-liveness-with-scanner.mjs`. Same flag combination as the first attempt, now with `TrustDialogScanner` from `src/driver/pty.ts` attached to the `node-pty` data stream.

## Verdict

| Criterion | Result | Detail |
|---|---|---|
| (i)   Scanner detected dialog + sent `\r` ≤ 5s | ✓ | **+279ms** after spawn |
| (ii)  `SessionStart` hook fired | ✓ | payload captured (see below) |
| (iii) ≥1 assistant JSONL line | ✓ | 10 transcript lines including one `assistant` entry |
| (iv)  PTY alive at 20s | ✓ | only exited on SIGINT |
| (v)   `Stop` hook fired | ✓ | payload captured, includes `last_assistant_message` |

Transcript appeared at exactly `~/.claude/projects/<realpath-encoded-cwd>/<uuid>.jsonl` — D18 path formula confirmed (with realpath of `/var/folders/...` → `/private/var/folders/...`).

## Bonus spikes resolved by this one run

- **T0.12 (deterministic transcript path):** `--session-id <uuid>` honored. Path matches `~/.claude/projects/<realpath(cwd) with '/' → '-'>/<uuid>.jsonl`.
- **T0.13 (hook payload shapes):** see "Hook payloads" below.
- **T0.3 (transcript usage shape):** see "Transcript schema" below. **Important:** there is NO `result` entry in the transcript. D17's `bounded settle window... terminal 'result' JSONL entry` needs updating — the terminal entry is `system / stop_hook_summary`. Usage data lives on the `assistant` entry itself (not in a separate `result` entry).
- **T0.6 (terminal-query handling):** `node-pty` alone is sufficient. `claude` emitted `ESC [ > 0 q` (XTVERSION query), `ESC [ c` (DA), `ESC ] 9 ; 4 ; 0 ; BEL` (iTerm2 progress), `ESC [ ? 1004 h` (focus-tracking), etc. — none required a synthetic response from us for the boot to proceed. The bridge does NOT need to emulate `smithersai/claude-p`'s terminal-query responder.

## Hook payloads (T0.13)

**SessionStart stdin** (sent by `claude` to the hook subprocess, who reads `stdin` and writes `{}` to stdout):

```json
{
  "session_id": "fb983619-4b5f-4e2a-8a89-6ca8bed405e9",
  "transcript_path": "/Users/cartwmic/.claude/projects/-private-var-folders-46-d9l6mmtx1ddb1d58xm5v9kgh0000gn-T-spike-t14b-CzQnKR/fb983619-4b5f-4e2a-8a89-6ca8bed405e9.jsonl",
  "cwd": "/private/var/folders/46/d9l6mmtx1ddb1d58xm5v9kgh0000gn/T/spike-t14b-CzQnKR",
  "hook_event_name": "SessionStart",
  "source": "startup",
  "model": "claude-opus-4-7[1m]"
}
```

- `transcript_path` IS present in interactive mode (D18's cross-check has a real signal).
- `model` field's `[1m]` suffix is a 1M-context variant marker.
- `source` = `"startup"` for first-fire (may differ on `--resume`).

**Stop stdin:**

```json
{
  "session_id": "...",
  "transcript_path": "...",
  "cwd": "/private/var/folders/...",
  "permission_mode": "bypassPermissions",
  "hook_event_name": "Stop",
  "stop_hook_active": false,
  "last_assistant_message": "OK. Hello! How can I help you today?"
}
```

- **`last_assistant_message`** is plaintext of the final assistant turn. This is a SECOND delivery channel for the final response — useful as a sanity check against the transcript tail, but transcript tail remains authoritative because it carries the structured `content` blocks (including future tool_use / thinking).
- `stop_hook_active` distinguishes whether the Stop hook itself is what's being invoked recursively (we will never set this true; always check it's false).

**Hook response:** `claude` accepts `{}` on stdout. Any non-empty JSON object is treated as the hook decision payload. Empty stdout is also accepted (treated as `{}`).

## Transcript schema (T0.3 update)

Observed line types (in order):

1. `permission-mode` — initial fixture line (`{type:"permission-mode", permissionMode:"bypassPermissions", sessionId:"..."}`).
2. `file-history-snapshot` × 2 — workspace state for diff/undo tracking.
3. `attachment` with `attachment.type ∈ {"hook_success", "deferred_tools_delta", "skill_listing"}` — sidecars.
4. `user` — the user message we passed as positional arg.
5. `attachment` × 2 — pre-assistant attachments.
6. `assistant` — the model reply (see schema below).
7. `attachment` `hook_success` — Stop hook execution log.
8. `system` with `subtype:"stop_hook_summary"` — TERMINAL ENTRY.

**Assistant entry shape (authoritative for D4 streaming):**

```json
{
  "type": "assistant",
  "message": {
    "model": "claude-opus-4-7",
    "id": "msg_...",
    "type": "message",
    "role": "assistant",
    "content": [
      { "type": "text", "text": "OK. Hello! How can I help you today?" }
    ],
    "stop_reason": "end_turn",
    "usage": {
      "input_tokens": 6,
      "cache_creation_input_tokens": 13793,
      "cache_read_input_tokens": 0,
      "output_tokens": 18,
      "server_tool_use": { "web_search_requests": 0, "web_fetch_requests": 0 },
      "service_tier": "standard",
      "cache_creation": { "ephemeral_1h_input_tokens": 13793, "ephemeral_5m_input_tokens": 0 },
      "speed": "standard"
    }
  },
  "requestId": "req_...",
  "uuid": "...",
  "timestamp": "2026-05-21T...",
  "userType": "external",
  "entrypoint": "cli",
  "cwd": "...",
  "sessionId": "...",
  "version": "2.1.114",
  "gitBranch": "HEAD"
}
```

- `message.content` is the standard Anthropic Messages content-block array. Future tool_use / thinking blocks will appear here.
- `usage` is per-turn token counts including cache fields. Bridge's existing `usageDelta` accounting can read directly from here.
- `requestId` is the Anthropic API request id — useful for correlating with rate-limit responses.

## D17 update required

D17 currently says the settle window closes when "a terminal `result` JSONL entry" is observed. Reality: there's no `result` entry in interactive mode. Replace with: settle window closes when `system / stop_hook_summary` is observed, OR Stop hook fires, OR 250ms elapses — whichever comes first. (Hook fires BEFORE `stop_hook_summary` is written; the latter actually records that the Stop hook ran.)

## Carry into T0.9 design promotion

1. **D17:** retire "terminal result entry" wording; the terminal entry is `system/stop_hook_summary`.
2. **D4:** `assistant.message.content` IS the streaming surface. Each new `assistant` line in the transcript = one complete content block (or set of blocks for a single turn).
3. **D6 / T0.6:** drop the "DEC primary/secondary device attributes, XTVERSION, DSR, window-size" worry — node-pty alone works.
4. **D9 / SessionStart:** payload reliably carries `transcript_path` in interactive mode. Cross-check is implementable.
5. **Stop hook:** `last_assistant_message` is a free sanity-check; design.md can mention it as a defense-in-depth signal.

## Next

Phase 0 remaining: T0.1, T0.2, T0.4, T0.5, T0.7, T0.8 (full re-verify), T0.10, T0.11. Then T0.9 promotion.
