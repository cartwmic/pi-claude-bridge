import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = join(REPO, "scripts", "run-all-scenarios.sh");
const FIXTURES = join(REPO, "tests", "fixtures");

function runFixture(name, extraEnv = {}) {
	const results = mkdtempSync(join(tmpdir(), "bridge-scenario-runner-"));
	const names = Array.isArray(name) ? name : [name];
	const inventory = names.map((entry) => join(FIXTURES, `scenario-runner-${entry}.sh`)).join(":");
	const out = spawnSync("bash", [RUNNER], {
		cwd: REPO,
		encoding: "utf8",
		timeout: 10_000,
		env: {
			...process.env,
			SCENARIO_RUNNER_TEST_MODE: "1",
			SCENARIO_TEST_INVENTORY: inventory,
			SCENARIO_RESULTS_DIR: results,
			SCENARIO_DRIVERS: "claude-print",
			...extraEnv,
		},
	});
	const summary = readFileSync(join(results, "SUMMARY.md"), "utf8");
	return { ...out, summary };
}

describe("scenario runner propagation", () => {
	it("records a successful fixture as PASS", () => {
		const out = runFixture("pass");
		assert.equal(out.status, 0, out.stderr);
		assert.match(out.summary, /claude-print\.scenario-runner-pass — PASS/);
	});

	it("propagates forced scenario failure", () => {
		const out = runFixture("fail");
		assert.notEqual(out.status, 0);
		assert.match(out.summary, /claude-print\.scenario-runner-fail — FAIL/);
		assert.match(out.summary, /fixture forced failure/);
	});

	it("reports required skip and exits nonzero", () => {
		const out = runFixture("skip");
		assert.notEqual(out.status, 0);
		assert.match(out.summary, /claude-print\.scenario-runner-skip — SKIP/);
		assert.match(out.summary, /fixture prerequisite absent/);
	});

	it("allows explicitly exploratory skips without calling them passes", () => {
		const out = runFixture("skip", { SCENARIO_ALLOW_SKIPS: "1" });
		assert.equal(out.status, 0, out.stderr);
		assert.match(out.summary, /— SKIP/);
		assert.doesNotMatch(out.summary, /— PASS/);
	});

	it("reports explicit targeted S33 skip for claude-p", () => {
		const results = mkdtempSync(join(tmpdir(), "bridge-scenario-runner-s33-"));
		const s33 = join(REPO, "scripts", "run-scenario-s33-thinking-effort.sh");
		const out = spawnSync("bash", [RUNNER], {
			cwd: REPO,
			encoding: "utf8",
			timeout: 10_000,
			env: {
				...process.env,
				SCENARIO_RUNNER_TEST_MODE: "1",
				SCENARIO_TEST_INVENTORY: s33,
				SCENARIO_RESULTS_DIR: results,
				SCENARIO_DRIVERS: "claude-p",
				SCENARIO_FILTER: "^s33-thinking-effort$",
			},
		});
		const summary = readFileSync(join(results, "SUMMARY.md"), "utf8");
		assert.notEqual(out.status, 0, "required targeted skip must keep suite nonzero");
		assert.match(summary, /claude-p\.s33-thinking-effort — SKIP/);
	});

	it("propagates distinct results in parallel mode", () => {
		const out = runFixture(["pass", "skip"], {
			SCENARIO_ALLOW_SKIPS: "1",
			SCENARIO_PARALLEL: "2",
		});
		assert.equal(out.status, 0, out.stderr);
		assert.match(out.summary, /claude-print\.scenario-runner-pass — PASS/);
		assert.match(out.summary, /claude-print\.scenario-runner-skip — SKIP/);
	});
});
