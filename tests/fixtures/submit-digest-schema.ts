// Copied verbatim from /Users/cartwmic/git/pi-session-search/src/digest/schema.ts
// so this repo does not depend on a sibling checkout.
// DO NOT add the validateDigest helper here — keep the fixture self-contained.

import { Type, type Static } from "@sinclair/typebox";
import type { Tool } from "@mariozechner/pi-ai";

/**
 * TypeBox schema for the LLM tool call arguments.
 * The builder instructs the LLM to call submit_digest exactly once.
 */
export const DigestArgs = Type.Object({
	body: Type.String({ minLength: 50 }),
	headline: Type.String({ minLength: 1, maxLength: 80 }),
	topics: Type.Array(Type.String({ maxLength: 32 }), { minItems: 0, maxItems: 5 }),
	outcome: Type.Optional(Type.String({ maxLength: 200 })),
});

export type DigestArgsType = Static<typeof DigestArgs>;

/**
 * Tool definition passed to the digest LLM call.
 * Lives here (alongside DigestArgs) so schema and tool stay in sync.
 */
export const submitDigestTool: Tool<typeof DigestArgs> = {
	name: "submit_digest",
	description:
		"Submit a structured digest summarizing the session conversation. " +
		"Call this tool exactly once with the complete digest. " +
		"Do not call any other tools or output any other text.",
	parameters: DigestArgs,
};
