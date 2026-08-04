#!/usr/bin/env node
// Covers driver selection:
// - selection uses the layered bridge configuration
// - the direct driver enforces its own independent version floor

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	chmodSync,
	closeSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
	CLAUDE_PRINT_MIN_VERSION,
	__resetClaudePrintVersionProbeForTests,
	loadBridgeDriverConfig,
	preflightBridgeDriver,
} from "../index.js";

const roots = [];

afterEach(() => {
	__resetClaudePrintVersionProbeForTests();
	while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pcb-driver-config-"));
	roots.push(root);
	return {
		root,
		projectCwd: join(root, "project"),
		homeDir: join(root, "home"),
	};
}

function paths(f) {
	return {
		project: join(f.projectCwd, ".pi", "claude-bridge.json"),
		global: join(f.homeDir, ".pi", "agent", "claude-bridge.json"),
	};
}

function writeJson(path, value) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value));
}

function load(f, overrides = {}) {
	return loadBridgeDriverConfig({
		projectCwd: f.projectCwd,
		homeDir: f.homeDir,
		env: {},
		...overrides,
	});
}

describe("layered driver configuration", () => {
	it("defaults to claude-print and allows explicit claude-p rollback", () => {
		const f = fixture();
		assert.equal(load(f), "claude-print");
		assert.equal(load(f, { env: { CLAUDE_BRIDGE_DRIVER: "claude-p" } }), "claude-p");
	});

	it("uses global, then project, then non-empty environment precedence", () => {
		const f = fixture();
		const p = paths(f);
		writeJson(p.global, { driver: "claude-print" });
		assert.equal(load(f), "claude-print");

		writeJson(p.project, { driver: "claude-p" });
		assert.equal(load(f), "claude-p");
		assert.equal(load(f, { env: { CLAUDE_BRIDGE_DRIVER: "claude-print" } }), "claude-print");
		assert.equal(load(f, { env: { CLAUDE_BRIDGE_DRIVER: "  " } }), "claude-p");
	});

	it("falls through an absent project driver key", () => {
		const f = fixture();
		const p = paths(f);
		writeJson(p.global, { driver: "claude-print" });
		writeJson(p.project, { unrelated: true });
		assert.equal(load(f), "claude-print");
	});

	it("parses every present file even when environment wins", () => {
		const f = fixture();
		const p = paths(f);
		mkdirSync(dirname(p.global), { recursive: true });
		writeFileSync(p.global, "{not-json");
		writeJson(p.project, { driver: "claude-p" });

		assert.throws(
			() => load(f, { env: { CLAUDE_BRIDGE_DRIVER: "claude-print" } }),
			(error) => {
				assert.match(error.message, /global/i);
				assert.match(error.message, new RegExp(p.global.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
				assert.match(error.message, /JSON/i);
				return true;
			},
		);
	});

	for (const [label, value] of [
		["non-object root", []],
		["null root", null],
		["non-string driver", { driver: 7 }],
		["unsupported driver", { driver: "sdk" }],
	]) {
		it(`rejects ${label} explicitly`, () => {
			const f = fixture();
			const p = paths(f);
			writeJson(p.project, value);
			assert.throws(() => load(f), (error) => {
				assert.match(error.message, /project/i);
				assert.match(error.message, /claude-bridge\.json/i);
				assert.match(error.message, /(object|driver|supported|one of)/i);
				return true;
			});
		});
	}

	it("rejects an unsupported non-empty environment override", () => {
		const f = fixture();
		assert.throws(
			() => load(f, { env: { CLAUDE_BRIDGE_DRIVER: "sdk" } }),
			/CLAUDE_BRIDGE_DRIVER.*sdk.*claude-p.*claude-print/is,
		);
	});

	it("rejects final-component symlinks and directories without reading them", () => {
		const f = fixture();
		const p = paths(f);
		const target = join(f.root, "target.json");
		writeJson(target, { driver: "claude-print" });
		mkdirSync(dirname(p.project), { recursive: true });
		try {
			symlinkSync(target, p.project);
			assert.throws(() => load(f), /project.*symlink.*claude-bridge\.json/is);
		} finally {
			rmSync(p.project, { force: true });
		}
		mkdirSync(p.project);
		assert.throws(() => load(f), /project.*regular file.*claude-bridge\.json/is);
	});

	it("fails loudly when a present regular file cannot be opened", () => {
		const f = fixture();
		const p = paths(f);
		writeJson(p.project, { driver: "claude-print" });
		const fsOps = {
			lstatSync,
			openSync(path, flags) {
				if (path === p.project) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
				return openSync(path, flags);
			},
			fstatSync,
			readFileSync,
			closeSync,
		};
		assert.throws(() => load(f, { fsOps }), /project.*open.*claude-bridge\.json/is);
	});

	it("detects replacement between lstat and open using same-object verification", () => {
		const f = fixture();
		const p = paths(f);
		writeJson(p.project, { driver: "claude-p" });
		const moved = `${p.project}.old`;
		let replaced = false;
		const fsOps = {
			lstatSync(path) {
				const stat = lstatSync(path);
				if (path === p.project && !replaced) {
					replaced = true;
					renameSync(path, moved);
					writeJson(path, { driver: "claude-print" });
				}
				return stat;
			},
			openSync,
			fstatSync,
			readFileSync,
			closeSync,
		};
		assert.throws(() => load(f, { fsOps }), /project.*changed.*claude-bridge\.json/is);
	});
});

describe("direct-driver runtime preflight", () => {
	it("keeps claude-p independent and does not probe Claude version", () => {
		let probes = 0;
		assert.doesNotThrow(() => preflightBridgeDriver("claude-p", () => {
			probes++;
			return "0.0.1";
		}));
		assert.equal(probes, 0);
	});

	for (const [output, normalized] of [
		[CLAUDE_PRINT_MIN_VERSION, "2.1.208"],
		["2.1.209", "2.1.209"],
		["2.2.0", "2.2.0"],
		["3.0.0", "3.0.0"],
		["2.1.208 (Claude Code)", "2.1.208"],
	]) {
		it(`accepts direct Claude ${output}`, () => {
			assert.equal(preflightBridgeDriver("claude-print", () => output), normalized);
		});
	}

	for (const version of ["2.1.207", "2.0.999", "1.99.999"]) {
		it(`rejects direct Claude ${version} before child spawn`, () => {
			let spawned = false;
			assert.throws(() => {
				preflightBridgeDriver("claude-print", () => version);
				spawned = true;
			}, new RegExp(`claude-print.*${version.replaceAll(".", "\\.")}.*${CLAUDE_PRINT_MIN_VERSION.replaceAll(".", "\\.")}`, "is"));
			assert.equal(spawned, false);
		});
	}

	it("fails explicitly when installed Claude version cannot be read", () => {
		assert.throws(() => preflightBridgeDriver("claude-print", () => null), /claude-print.*2\.1\.208.*version/is);
	});

	it("default probe uses the same CLAUDE_BIN executable as direct spawn", () => {
		const f = fixture();
		const bin = join(f.root, "claude-direct");
		writeFileSync(bin, "#!/bin/sh\necho '2.1.220 (Claude Code)'\n");
		chmodSync(bin, 0o755);
		const previous = process.env.CLAUDE_BIN;
		process.env.CLAUDE_BIN = bin;
		try {
			assert.equal(preflightBridgeDriver("claude-print"), "2.1.220");
		} finally {
			if (previous === undefined) delete process.env.CLAUDE_BIN;
			else process.env.CLAUDE_BIN = previous;
		}
	});

	it("memoizes the direct Claude version probe process-wide", () => {
		let probes = 0;
		const probe = () => {
			probes++;
			return "2.1.208";
		};
		preflightBridgeDriver("claude-print", probe);
		preflightBridgeDriver("claude-print", () => {
			throw new Error("must not re-probe");
		});
		assert.equal(probes, 1);
	});
});
