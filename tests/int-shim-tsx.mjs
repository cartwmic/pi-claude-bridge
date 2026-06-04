#!/usr/bin/env node
// Regression guard for the 2026-06-04 root cause (real session 019e9011): an
// installed copy with NO built dist runs the MCP shim from src/mcp/shim.ts. The
// bridge MUST spawn it under tsx (shimNodeArgs prepends `--import tsx`); plain
// `node shim.ts` dies with ERR_MODULE_NOT_FOUND on its `./ipc.js` import, leaving
// `claude` with ZERO mcp__custom-tools__* tools — so the model emits tool calls as
// raw text every turn and never reaches a real tool. Every scenario/spike passed
// before because the REPO has a built dist (it spawned `node shim.js`); this test
// covers the no-dist `.ts` path that real installed copies actually use.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { shimNodeArgs } from "../index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIM_TS = join(HERE, "..", "src", "mcp", "shim.ts");
const TOOLS_B64 = Buffer.from(JSON.stringify([{ name: "bash" }])).toString("base64");

describe("shimNodeArgs — TypeScript source must run under tsx", () => {
	it("imports an ABSOLUTE file:// tsx for a .ts shim path (cwd-independent — bare `tsx` fails from the session cwd)", () => {
		const a = shimNodeArgs("/x/src/mcp/shim.ts");
		assert.equal(a[0], "--import");
		assert.match(a[1], /^file:\/\/.*\/tsx\//, `must be an absolute file:// path to tsx, got: ${a[1]}`);
		assert.equal(a[2], "/x/src/mcp/shim.ts");
	});
	it("leaves a built .js shim path bare (dist present → no tsx needed)", () => {
		assert.deepEqual(shimNodeArgs("/x/dist/src/mcp/shim.js"), ["/x/dist/src/mcp/shim.js"]);
	});
});

function spawnShim(nodeArgs) {
	return new Promise((res) => {
		const args = [...nodeArgs, "--socket", `/tmp/pcb-test-noexist-${process.pid}.sock`, "--mode", "main", "--tools", TOOLS_B64];
		// CRITICAL: run from a cwd WITHOUT node_modules/tsx (like the user's pi session
		// cwd, e.g. ~/.local/share/chezmoi). A bare `--import tsx` would fail here; the
		// fix resolves tsx to an absolute file:// path so it works regardless of cwd.
		const child = spawn(process.execPath, args, { stdio: ["ignore", "ignore", "pipe"], cwd: "/tmp" });
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (c) => (stderr += c));
		const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 8000);
		child.on("close", () => { clearTimeout(t); res(stderr); });
		child.on("error", (e) => { clearTimeout(t); res("spawn-error: " + e.message); });
	});
}

describe("MCP shim loads from .ts source (the no-dist path real installs use)", () => {
	it("`node --import tsx shim.ts` LOADS — reaches the socket connect, no module error", async () => {
		const stderr = await spawnShim(shimNodeArgs(SHIM_TS));
		assert.ok(
			!/ERR_MODULE_NOT_FOUND|Cannot find module/.test(stderr),
			`shim under tsx must not fail module resolution (this is exactly the production bug):\n${stderr}`,
		);
		// Having loaded, it reaches connectIpcClient and fails on the bogus socket —
		// which proves all imports (./ipc.js → ipc.ts via tsx) resolved.
		assert.ok(
			/ENOENT|startup-failed|connect/i.test(stderr),
			`shim should reach the IPC-connect stage (proof it fully loaded):\n${stderr}`,
		);
	});
});
