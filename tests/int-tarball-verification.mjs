#!/usr/bin/env node
// T4.4a — tarball verification.
//
// Runs `npm pack`, extracts tarball into fresh scratch dir, installs only
// production deps, and verifies:
//
//   (a) standalone shim launcher is present + executable
//   (b) launcher's source target (`src/mcp/shim.ts`) is present in tarball
//   (c) production install can execute launcher in hook mode without dist/
//
// This is the gate that catches "works locally / breaks after npm publish"
// failures (Round-1 B.P1#4).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

function sh(cmd, opts = {}) {
	return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}

describe("Tarball verification — npm pack produces a runnable package", () => {
	it("npm pack succeeds and produces a tarball", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "bridge-tarball-"));

		// Pack into scratch dir.
		const out = sh(`cd "${PROJECT_ROOT}" && npm pack --pack-destination "${scratch}" --silent 2>&1`).trim();
		const tarballName = out.split("\n").pop().trim();
		const tarballPath = join(scratch, tarballName);
		assert.ok(existsSync(tarballPath), `tarball not found: ${tarballPath} (npm pack output: ${out})`);

		// Extract.
		const extractDir = join(scratch, "pkg");
		sh(`mkdir -p "${extractDir}" && tar -xzf "${tarballPath}" -C "${extractDir}"`);
		const pkgDir = join(extractDir, "package");
		assert.ok(existsSync(pkgDir), "tarball did not contain a package/ root");

		// Install runtime deps exactly how pi packages need them.
		sh(`cd "${pkgDir}" && npm install --omit=dev`);

		// (a) bin entry
		const pkgJson = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
		assert.ok(pkgJson.bin && pkgJson.bin["pi-claude-bridge-shim"], "package.json missing bin entry");
		const binPath = join(pkgDir, pkgJson.bin["pi-claude-bridge-shim"]);
		assert.ok(existsSync(binPath), `bin entry not in tarball: ${binPath}`);
		const binStat = statSync(binPath);
		assert.ok((binStat.mode & 0o111) !== 0, `bin entry not executable: ${binPath}`);

		// (b) Launcher target must ship as source; git-installed packages rely
		//     on this path, not on dist/ being prebuilt.
		const sourceShim = join(pkgDir, "src/mcp/shim.ts");
		assert.ok(existsSync(sourceShim), `tarball missing launcher target: ${sourceShim}`);

		// (c) Production install can execute launcher without dist/. Hook mode
		//     falls back to stdout={} when router socket is absent.
		const smoke = sh(`cd "${pkgDir}" && node "${binPath}" --mode hook --event SessionStart --socket /tmp/pi-bridge-missing.sock </dev/null 2>&1 || true`);
		assert.match(smoke, /\{\}/, `shim launcher smoke did not emit fallback JSON: ${smoke}`);
	});
});
