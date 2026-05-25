#!/usr/bin/env node

import { createJiti } from "jiti";
import process from "node:process";

const jiti = createJiti(import.meta.url);
const mod = await jiti("./src/mcp/shim.ts");

if (typeof mod?.main !== "function") {
	process.stderr.write("shim fatal: src/mcp/shim.ts did not export main()\n");
	process.exit(1);
}

try {
	await mod.main();
} catch (err) {
	process.stderr.write(`shim fatal: ${err instanceof Error ? err.stack || err.message : String(err)}\n`);
	process.exit(1);
}
