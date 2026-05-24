#!/usr/bin/env node
// Unit tests for shim's argv parser + light validator (T1.7).
// Full e2e shim spawning is exercised by Phase 4 integration tests.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { __parseArgs, __lightValidate, __loadToolsFile } from "../src/mcp/shim.js";
import { mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("shim argv parser", () => {
	it("parses --mode mcp + required args", () => {
		const r = __parseArgs(["--mode", "mcp", "--socket", "/tmp/x.sock", "--tools-file", "/tmp/t.json"]);
		assert.equal(r.mode, "mcp");
		assert.equal(r.socket, "/tmp/x.sock");
		assert.equal(r.toolsFile, "/tmp/t.json");
	});

	it("parses --mode hook + --event", () => {
		const r = __parseArgs(["--mode", "hook", "--event", "SessionStart", "--socket", "/tmp/x.sock"]);
		assert.equal(r.mode, "hook");
		assert.equal(r.event, "SessionStart");
	});

	it("parses --capture-tool for capture mode", () => {
		const r = __parseArgs(["--mode", "mcp", "--socket", "/x.sock", "--tools-file", "/t.json", "--capture-tool", "extractor"]);
		assert.equal(r.captureTool, "extractor");
	});

	it("throws if --mode missing", () => {
		assert.throws(() => __parseArgs(["--socket", "/x.sock"]), /--mode/);
	});

	it("throws if --mode value invalid", () => {
		assert.throws(() => __parseArgs(["--mode", "bogus", "--socket", "/x.sock"]), /--mode/);
	});

	it("throws if --socket missing", () => {
		assert.throws(() => __parseArgs(["--mode", "mcp"]), /--socket/);
	});

	it("throws if --mode hook without --event", () => {
		assert.throws(() => __parseArgs(["--mode", "hook", "--socket", "/x.sock"]), /--event/);
	});
});

describe("shim light validator (capture-mode pre-check)", () => {
	it("accepts undefined schema", () => {
		const r = __lightValidate({ x: 1 }, undefined);
		assert.equal(r.ok, true);
	});

	it("accepts valid object against object-root schema", () => {
		const r = __lightValidate({ a: 1 }, { type: "object", required: ["a"] });
		assert.equal(r.ok, true);
	});

	it("rejects missing required field", () => {
		const r = __lightValidate({ a: 1 }, { type: "object", required: ["a", "b"] });
		assert.equal(r.ok, false);
		if (r.ok === false) assert.match(r.reason, /b/);
	});

	it("rejects non-object args", () => {
		const r = __lightValidate([1, 2, 3], { type: "object" });
		assert.equal(r.ok, false);
	});

	it("rejects non-object root schema (v1 limitation)", () => {
		const r = __lightValidate("string", { type: "string" });
		assert.equal(r.ok, false);
	});

	it("accepts null required (no required)", () => {
		const r = __lightValidate({ x: 1 }, { type: "object" });
		assert.equal(r.ok, true);
	});
});

describe("shim tools-file loader", () => {
	it("loads a valid tools.json", () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "shim-tools-")));
		const path = join(dir, "tools.json");
		writeFileSync(path, JSON.stringify({
			tools: [
				{ name: "mcp__custom-tools__read", description: "read", inputSchema: { type: "object" } },
			],
		}));
		const t = __loadToolsFile(path);
		assert.equal(t.tools.length, 1);
		assert.equal(t.tools[0].name, "mcp__custom-tools__read");
	});

	it("throws on missing file", () => {
		assert.throws(() => __loadToolsFile("/nonexistent.json"), /failed to load/);
	});

	it("throws on malformed JSON", () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "shim-tools-")));
		const path = join(dir, "bad.json");
		writeFileSync(path, "{not valid");
		assert.throws(() => __loadToolsFile(path), /failed to load/);
	});
});
