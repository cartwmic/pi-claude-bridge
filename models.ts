// Canonical selection + display order for the model picker.
// `resolveModelId` returns the first partial match, so `opus` resolves to the first-listed opus entry.
// Extracted from index.ts so tests can import without activating the extension.

export const MODEL_IDS_IN_ORDER = ["claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6", "claude-sonnet-5", "claude-haiku-4-5", "claude-fable-5"];

// Stopgap metadata for models pi's bundled pi-ai catalog doesn't know yet.
// buildModels falls back to these instead of silently dropping the id, so a
// brand-new model is usable before the next pi release / pi.dev catalog sync.
// Remove an entry once the id appears in pi-ai's builtin anthropic catalog.
export const FALLBACK_MODELS: Record<string, { id: string; name: string; reasoning: boolean; input: string[]; cost: { input: number; output: number; cacheRead: number; cacheWrite: number }; contextWindow: number; maxTokens: number }> = {
	// Released 2026-07-24; cost cloned from claude-opus-4-8 — update when official pricing lands in the catalog.
	"claude-opus-5": {
		id: "claude-opus-5", name: "Claude Opus 5", reasoning: true, input: ["text", "image"],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 1000000, maxTokens: 128000,
	},
};

// Project pi-ai's model entries down to the fields pi's registerProvider expects,
// and keep MODEL_IDS_IN_ORDER ordering. IDs missing from pi-ai use FALLBACK_MODELS
// when available and are otherwise silently dropped.
export function buildModels<T extends { id: string; [key: string]: any }>(piAiModels: T[]) {
	return MODEL_IDS_IN_ORDER
		.map((id) => piAiModels.find((m) => m.id === id) ?? FALLBACK_MODELS[id])
		.filter((m) => m != null)
		.map(({ id, name, reasoning, input, cost, contextWindow, maxTokens }) => ({
			id, name, reasoning, input, cost, contextWindow, maxTokens,
		}));
}

export function resolveModelId(models: Array<{ id: string }>, input: string): string {
	const lower = input.toLowerCase();
	const match = models.find((m) => m.id === lower || m.id.includes(lower));
	return match ? match.id : input;
}
