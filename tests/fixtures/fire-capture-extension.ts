// Test extension: registers a /fire-capture slash command whose handler calls
// pi-ai.complete() against claude-bridge/claude-haiku-4-5 with a submit_digest
// capture tool. Used by S25 to fire a background capture call while a normal
// user turn is mid-tool-execution (SlowTool), validating that the capture path
// is fully concurrent and does not disturb the in-progress agent turn.
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { complete, type Tool } from "@mariozechner/pi-ai";

// Minimal inline submit_digest schema (mirrors tests/fixtures/submit-digest-schema.ts
// if it exists; inlined here so the extension has no sibling-checkout dependency).
const submitDigestTool: Tool = {
	name: "submit_digest",
	description: "Submit a short digest of the provided content.",
	parameters: Type.Object({
		headline: Type.String({ maxLength: 80 }),
		body: Type.String({ minLength: 50 }),
	}),
};

export default function (pi: ExtensionAPI) {
	pi.registerCommand("fire-capture", {
		description: "Fire a background capture call (for S25 concurrency test)",
		handler: async (_args, ctx) => {
			const model = ctx.modelRegistry.find("claude-bridge", "claude-haiku-4-5");
			if (!model) {
				ctx.ui.notify(
					"[Capture error] model not found: claude-bridge/claude-haiku-4-5",
					"error",
				);
				return;
			}
			try {
				const result = await complete(model, {
					systemPrompt: "Produce a short digest of the provided text.",
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: "Summarize: hello world" }],
							timestamp: Date.now(),
						},
					],
					tools: [submitDigestTool],
				});
				ctx.ui.notify(`[Capture done] stopReason=${result.stopReason}`);
			} catch (err: unknown) {
				const msg =
					err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`[Capture error] ${msg}`, "error");
			}
		},
	});
}
