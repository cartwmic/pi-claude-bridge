# replace-sdk-with-claude-p

Replace @anthropic-ai/claude-agent-sdk with the `smithersai/claude-p` interactive-TUI driver (never the nominal `claude -p`); keep the forced MCP held-open tool round-trip (pi executes tools); drop AskClaude; reimplement capture mode as a forced MCP tool-call. Completion bar: the full S0–S26 pi-TUI scenario suite passes or carries a documented architectural exemption.

History: this change was originally scoped as `replace-sdk-with-pty-tui` (an in-house `node-pty` driver). It was replanned to claude-p on 2026-05-31 — see design.md "Replan Amendment". The Rounds 1–5 adversarial-review archaeology lives under `.opsx-review/replace-sdk-with-pty-tui/` and the historical decisions remain in design.md below the amendment.
