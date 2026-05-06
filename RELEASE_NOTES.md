# Release Notes

## 0.4.0 — Coordination

### pi-session-search workaround removal (upcoming)

`pi-session-search/src/digest/builder.ts` contains a `model.provider !== "claude-bridge"` guard that skips `ctx.tools` on the capture call and falls back to text-mode JSON parsing. This workaround was introduced because the bridge previously routed unregistered tools through MCP — causing the SDK frame to leak, session cache to diverge, and `ctx.systemPrompt` to be replaced.

All three root causes are fixed in `pi-claude-bridge` 0.4.0. Once this version is deployed, `pi-session-search` can:

1. Remove the `provider !== "claude-bridge"` branch in `digest/builder.ts`.
2. Pass `ctx.tools = [submitDigestTool]` unconditionally to `complete()` regardless of provider.
3. Remove any fallback text-parsing path that was written to compensate for the missing `toolCall` block.

**Do not remove the workaround before `pi-claude-bridge` 0.4.0 is installed** — the old bridge behaviour (indefinite MCP await, session pollution) is still present on earlier versions.

No code changes to `pi-session-search` are made as part of this bridge release. The removal is a follow-up coordinated change in that repo.
