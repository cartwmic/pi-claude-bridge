import type { ThinkingLevel } from "@mariozechner/pi-ai";

/** Effort values accepted by the Claude CLI's `--effort` flag. */
export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** Provider metadata consumed by Pi plus runtime translation consumed here. */
export const CLAUDE_THINKING_LEVEL_MAP = {
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
} as const;

/**
 * Translate Pi's provider-neutral reasoning control to Claude CLI effort.
 * Claude has no `minimal` value, so that level clamps to its lowest effort.
 * `max` is accepted for forward compatibility with newer Pi hosts whose
 * ThinkingLevel union includes it even when this package's pi-ai types do not.
 */
export function mapPiReasoningToClaudeEffort(
	reasoning: ThinkingLevel | "max" | undefined,
): ClaudeEffort | undefined {
	if (reasoning === undefined) return undefined;
	return CLAUDE_THINKING_LEVEL_MAP[reasoning];
}
