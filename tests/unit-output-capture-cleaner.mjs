/**
 * Unit tests for cleanSchemaForSdk (task 5.3).
 *
 * Passes the actual submit_digest schema through cleanSchemaForSdk and asserts:
 *  - All nested constraints are preserved (maxLength, maxItems, minLength, required)
 *  - No TypeBox symbol-keyed metadata survives at any depth (Symbol.for("Kind") etc.)
 *  - Cleaned root has type === "object"
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cleanSchemaForSdk } from "../index.js";
import { DigestArgs, submitDigestTool } from "./fixtures/submit-digest-schema.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Recursively assert that an object (and all nested objects/arrays) has zero
 * symbol-keyed own properties. Returns the count of nodes checked.
 */
function assertNoSymbols(node, path = "root") {
	if (typeof node !== "object" || node === null) return;
	const syms = Object.getOwnPropertySymbols(node);
	assert.equal(
		syms.length,
		0,
		`Expected no symbol keys at ${path}, found: ${syms.map(String).join(", ")}`,
	);
	for (const [k, v] of Object.entries(node)) {
		if (typeof v === "object" && v !== null) {
			assertNoSymbols(v, `${path}.${k}`);
		}
	}
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("cleanSchemaForSdk — submit_digest schema", () => {
	const cleaned = cleanSchemaForSdk(DigestArgs);

	it("cleaned root has type === 'object'", () => {
		assert.equal(cleaned.type, "object", "Root schema must be type=object for capture path acceptance");
	});

	it("no TypeBox symbol-keyed metadata at any depth", () => {
		// TypeBox attaches Symbol(Kind), Symbol(Modifier), etc.
		// cleanSchemaForSdk uses JSON.parse(JSON.stringify(...)) which drops all symbols.
		assertNoSymbols(cleaned);
	});

	it("properties.body preserved with minLength constraint", () => {
		const props = cleaned.properties;
		assert.ok(props, "cleaned schema must have properties");
		const body = props.body;
		assert.ok(body, "properties.body must exist");
		assert.equal(body.minLength, 50, "body.minLength must be 50");
		assert.equal(body.type, "string");
	});

	it("properties.headline preserved with maxLength constraint", () => {
		const headline = cleaned.properties?.headline;
		assert.ok(headline, "properties.headline must exist");
		assert.equal(headline.maxLength, 80, "headline.maxLength must be 80");
		assert.equal(headline.minLength, 1, "headline.minLength must be 1");
		assert.equal(headline.type, "string");
	});

	it("properties.topics preserved with maxItems and items.maxLength", () => {
		const topics = cleaned.properties?.topics;
		assert.ok(topics, "properties.topics must exist");
		assert.equal(topics.type, "array");
		assert.equal(topics.maxItems, 5, "topics.maxItems must be 5");
		assert.equal(topics.minItems, 0, "topics.minItems must be 0");
		// Each topic string has maxLength: 32
		assert.ok(topics.items, "topics must have items");
		assert.equal(topics.items.maxLength, 32, "topics.items.maxLength must be 32");
	});

	it("properties.outcome preserved as optional with maxLength", () => {
		const outcome = cleaned.properties?.outcome;
		assert.ok(outcome, "properties.outcome must exist");
		assert.equal(outcome.maxLength, 200, "outcome.maxLength must be 200");
	});

	it("required array correct for Type.Optional fields", () => {
		// In TypeBox, Type.Optional fields are NOT in the 'required' array.
		// DigestArgs: body, headline, topics are required; outcome is Optional.
		const required = cleaned.required;
		assert.ok(Array.isArray(required), "cleaned schema must have required array");
		assert.ok(required.includes("body"), "required must include body");
		assert.ok(required.includes("headline"), "required must include headline");
		assert.ok(required.includes("topics"), "required must include topics");
		// outcome is Type.Optional → should NOT be in required
		assert.ok(
			!required.includes("outcome"),
			"outcome is Type.Optional → must NOT be in required",
		);
	});

	it("cleaned schema is a plain JSON-serialisable object (round-trip stable)", () => {
		// Should survive another JSON round-trip unchanged
		const roundTrip = JSON.parse(JSON.stringify(cleaned));
		assert.deepEqual(roundTrip, cleaned);
	});
});

describe("cleanSchemaForSdk — submitDigestTool.parameters (same schema via Tool)", () => {
	const cleaned = cleanSchemaForSdk(submitDigestTool.parameters);

	it("tool.parameters produces same cleaned output as DigestArgs directly", () => {
		const fromDigestArgs = cleanSchemaForSdk(DigestArgs);
		// Deep equal after cleaning
		assert.deepEqual(JSON.parse(JSON.stringify(cleaned)), JSON.parse(JSON.stringify(fromDigestArgs)));
	});

	it("no symbols in tool.parameters-cleaned schema", () => {
		assertNoSymbols(cleaned);
	});
});

describe("cleanSchemaForSdk — edge cases", () => {
	it("non-object root (array schema) cleans correctly", () => {
		const arraySchema = { type: "array", items: { type: "string", maxLength: 10 }, maxItems: 5 };
		const cleaned = cleanSchemaForSdk(arraySchema);
		assert.equal(cleaned.type, "array");
		assert.equal(cleaned.maxItems, 5);
		assert.equal(cleaned.items.maxLength, 10);
	});

	it("deeply nested constraints are preserved", () => {
		const nested = {
			type: "object",
			properties: {
				a: {
					type: "object",
					properties: {
						b: { type: "string", minLength: 3, maxLength: 100 },
					},
					required: ["b"],
				},
			},
			required: ["a"],
		};
		const cleaned = cleanSchemaForSdk(nested);
		assert.equal(cleaned.properties.a.properties.b.minLength, 3);
		assert.equal(cleaned.properties.a.properties.b.maxLength, 100);
		assert.deepEqual(cleaned.properties.a.required, ["b"]);
	});
});
