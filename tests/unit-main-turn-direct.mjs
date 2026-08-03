#!/usr/bin/env node
// Canonical ACs:
// claude-print-driver.one-direct-process-spans-held-tool-rounds
// claude-print-driver.direct-abort-preserves-partial-and-reaps-process-group
// claude-print-driver.direct-concurrent-invocations-are-isolated
// claude-print-driver.direct-image-behavior-matches-bridge-contract
// claude-print-driver.direct-steering-uses-abort-and-fresh-dispatch
// bridge-driver-selection.driver-failures-never-trigger-cross-driver-fallback

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import activateBridge, {
	__pinExtensionDriverForTests,
	__resetCachedSessionForTests,
	__resetExtensionActivationForTests,
	__setClaudePrintPreflightForTests,
	__setPiApiRefForTests,
	__setSpawnClaudePForTests,
	__setSpawnClaudePrintForTests,
	buildColdStartPrompt,
	streamClaudeAgentSdk,
} from "../index.js";
import { connectIpcClient } from "../src/mcp/ipc.js";

const MODEL = {
	id: "claude-sonnet-4-6",
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};
const QUIET_RESULT = { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 6 };

let restorers = [];
let tempRoots = [];
const priorDriver = process.env.CLAUDE_BRIDGE_DRIVER;

afterEach(() => {
	for (const restore of restorers.reverse()) restore();
	restorers = [];
	for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
	tempRoots = [];
	if (priorDriver === undefined) delete process.env.CLAUDE_BRIDGE_DRIVER;
	else process.env.CLAUDE_BRIDGE_DRIVER = priorDriver;
	__resetCachedSessionForTests();
	__resetExtensionActivationForTests();
});

function cwd() {
	const root = mkdtempSync(join(tmpdir(), "pcb-main-direct-"));
	tempRoots.push(root);
	return root;
}

function context(messages, tools = []) {
	return { systemPrompt: "You are helpful.", tools, messages };
}

async function drain(stream) {
	const events = [];
	for await (const event of stream) events.push(event);
	return events;
}

function emitAcceptedResult(cfg, options, text = "ok") {
	options.onPhase?.("ready");
	options.onPhase?.("promptSubmitted");
	options.onPhase?.("turnAccepted");
	options.onEvent({ kind: "usage", usage: QUIET_RESULT });
	options.onEvent({ kind: "text-delta", text });
	options.onEvent({ kind: "done", reason: "result" });
	options.onPhase?.("terminal");
	return { stopReason: "result", sessionId: cfg.session.sessionId, exitCode: 0, signal: null };
}

function installDirect() {
	process.env.CLAUDE_BRIDGE_DRIVER = "claude-print";
	restorers.push(__setClaudePrintPreflightForTests(() => {}));
	restorers.push(__setPiApiRefForTests({ getActiveTools: () => [] }));
}

describe("process-scoped driver selection", () => {
	it("pins main turns at extension load despite later environment changes", async () => {
		installDirect();
		const project = cwd();
		restorers.push(__pinExtensionDriverForTests(project));
		process.env.CLAUDE_BRIDGE_DRIVER = "claude-p";

		let directSpawns = 0;
		let interactiveSpawns = 0;
		restorers.push(__setSpawnClaudePForTests(() => {
			interactiveSpawns++;
			throw new Error("extension-load pin must prevent driver switch");
		}));
		restorers.push(__setSpawnClaudePrintForTests((cfg, options) => {
			directSpawns++;
			const done = new Promise((resolve) => queueMicrotask(() => resolve(emitAcceptedResult(cfg, options))));
			return { pid: 99, abort() {}, done };
		}));

		await drain(streamClaudeAgentSdk(MODEL, context([
			{ role: "user", content: "stay on pinned driver", timestamp: Date.now() },
		]), { cwd: project }));
		assert.equal(directSpawns, 1);
		assert.equal(interactiveSpawns, 0);
	});

	it("fails extension-load selection when selected-driver preflight fails", () => {
		process.env.CLAUDE_BRIDGE_DRIVER = "claude-print";
		restorers.push(__setClaudePrintPreflightForTests(() => { throw new Error("direct unavailable"); }));
		assert.throws(() => __pinExtensionDriverForTests(cwd()), /direct unavailable/);
	});

	it("duplicate activation cannot repin owner or re-register commands/providers", async () => {
		installDirect();
		const registrations = { commands: 0, providers: 0 };
		const api = {
			on() {},
			registerCommand() { registrations.commands++; },
			registerProvider() { registrations.providers++; },
		};
		activateBridge(api);
		process.env.CLAUDE_BRIDGE_DRIVER = "claude-p";
		activateBridge(api);
		assert.deepEqual(registrations, { commands: 1, providers: 1 });

		let directSpawns = 0;
		let interactiveSpawns = 0;
		restorers.push(__setSpawnClaudePForTests(() => {
			interactiveSpawns++;
			throw new Error("duplicate activation replaced pinned owner");
		}));
		restorers.push(__setSpawnClaudePrintForTests((cfg, options) => {
			directSpawns++;
			const done = new Promise((resolve) => queueMicrotask(() => resolve(emitAcceptedResult(cfg, options))));
			return { pid: 98, abort() {}, done };
		}));
		await drain(streamClaudeAgentSdk(MODEL, context([
			{ role: "user", content: "retain activation owner", timestamp: Date.now() },
		]), { cwd: cwd() }));
		assert.equal(directSpawns, 1);
		assert.equal(interactiveSpawns, 0);
	});
});

describe("shared main-turn orchestration — canonical cold/warm/image frames", () => {
	it("sends exact full cold history, then warm delta, while dropping image bytes", async () => {
		// claude-print-driver.direct-image-behavior-matches-bridge-contract
		installDirect();
		const configs = [];
		restorers.push(__setSpawnClaudePrintForTests((cfg, options) => {
			configs.push(cfg);
			const done = new Promise((resolve) => queueMicrotask(() => resolve(emitAcceptedResult(cfg, options, `answer-${configs.length}`))));
			return { pid: 100 + configs.length, abort() {}, done };
		}));

		const project = cwd();
		const firstMessages = [{
			role: "user",
			content: [
				{ type: "text", text: "describe without image transport" },
				{ type: "image", mimeType: "image/png", data: "BASE64-MUST-NOT-REPLAY" },
			],
			timestamp: Date.now(),
		}];
		await drain(streamClaudeAgentSdk(MODEL, context(firstMessages), { cwd: project }));
		assert.equal(configs[0].session.kind, "fresh");
		assert.equal(configs[0].prompt.text, buildColdStartPrompt(firstMessages));
		assert.ok(!configs[0].prompt.text.includes("BASE64-MUST-NOT-REPLAY"));

		const secondMessages = [
			...firstMessages,
			{ role: "assistant", content: [{ type: "text", text: "answer-1" }], timestamp: Date.now() },
			{ role: "user", content: "warm delta only", timestamp: Date.now() },
		];
		await drain(streamClaudeAgentSdk(MODEL, context(secondMessages), { cwd: project }));
		assert.equal(configs[1].session.kind, "resume");
		assert.equal(configs[1].session.sessionId, configs[0].session.sessionId);
		assert.equal(configs[1].prompt.text, "warm delta only");
		assert.ok(!configs[1].prompt.text.includes("conversation_history"));
	});
});

describe("shared main-turn orchestration — same-driver retry frames", () => {
	it("abandons submitted warm session, cold-repacks, then resumes accepted retry", async () => {
		// claude-print-driver.direct-failure-and-retry-preserve-side-effect-safety
		// bridge-driver-selection.driver-failures-never-trigger-cross-driver-fallback
		installDirect();
		let interactiveSpawns = 0;
		const configs = [];
		restorers.push(__setSpawnClaudePForTests(() => {
			interactiveSpawns++;
			throw new Error("cross-driver fallback");
		}));
		restorers.push(__setSpawnClaudePrintForTests((cfg, options) => {
			configs.push(cfg);
			const attempt = configs.length;
			if (attempt === 2) {
				queueMicrotask(() => {
					options.onPhase?.("ready");
					options.onPhase?.("promptSubmitted");
					options.onEvent({ kind: "error", errorMessage: "submitted warm process failed" });
				});
				return {
					pid: 402,
					abort() {},
					done: Promise.resolve({ stopReason: "error", sessionId: cfg.session.sessionId, exitCode: 2, signal: null }),
				};
			}
			const done = new Promise((resolve) => queueMicrotask(() => resolve(emitAcceptedResult(cfg, options, `answer-${attempt}`))));
			return { pid: 400 + attempt, abort() {}, done };
		}));

		const project = cwd();
		const first = [{ role: "user", content: "first", timestamp: Date.now() }];
		await drain(streamClaudeAgentSdk(MODEL, context(first), { cwd: project }));
		const second = [
			...first,
			{ role: "assistant", content: [{ type: "text", text: "answer-1" }], timestamp: Date.now() },
			{ role: "user", content: "second warm delta", timestamp: Date.now() },
		];
		await drain(streamClaudeAgentSdk(MODEL, context(second), { cwd: project }));
		assert.equal(configs[1].session.kind, "resume");
		assert.equal(configs[1].prompt.text, "second warm delta");
		assert.equal(configs[2].session.kind, "fresh");
		assert.notEqual(configs[2].session.sessionId, configs[1].session.sessionId);
		assert.equal(configs[2].prompt.text, buildColdStartPrompt(second));
		assert.equal(interactiveSpawns, 0);

		const third = [
			...second,
			{ role: "assistant", content: [{ type: "text", text: "answer-3" }], timestamp: Date.now() },
			{ role: "user", content: "third delta", timestamp: Date.now() },
		];
		await drain(streamClaudeAgentSdk(MODEL, context(third), { cwd: project }));
		assert.equal(configs[3].session.kind, "resume");
		assert.equal(configs[3].session.sessionId, configs[2].session.sessionId);
		assert.equal(configs[3].prompt.text, "third delta");
	});
});

describe("shared main-turn orchestration — one process across held rounds", () => {
	it("routes parallel calls together and continues on same direct handle", async () => {
		// claude-print-driver.one-direct-process-spans-held-tool-rounds
		installDirect();
		restorers.push(__setPiApiRefForTests({ getActiveTools: () => ["read"] }));
		let spawnCount = 0;
		restorers.push(__setSpawnClaudePrintForTests((cfg, options) => {
			spawnCount++;
			let resolveDone;
			const done = new Promise((resolve) => { resolveDone = resolve; });
			const mcp = JSON.parse(cfg.mcpConfig);
			const server = mcp.mcpServers["custom-tools"];
			const socketPath = server.args[server.args.indexOf("--socket") + 1];
			queueMicrotask(async () => {
				options.onPhase?.("ready");
				options.onPhase?.("promptSubmitted");
				options.onPhase?.("turnAccepted");
				const client = await connectIpcClient(socketPath);
				const calls = [1, 2].map((round) => ({
					modelId: `parallel_${round}`,
					name: "mcp__custom-tools__read",
					arguments: { path: `/tmp/parallel-${round}` },
				}));
				options.onToolUseBatch?.({ batchId: "parallel-batch", observations: calls });
				await Promise.all(calls.map((call) => client.request({
					kind: "tools/call",
					id: randomUUID(),
					modelToolUseId: call.modelId,
					name: "read",
					arguments: call.arguments,
				})));
				options.onEvent({ kind: "text-delta", text: "parallel complete" });
				options.onEvent({ kind: "done", reason: "result" });
				resolveDone({ stopReason: "result", sessionId: cfg.session.sessionId, exitCode: 0, signal: null });
			});
			return {
				pid: 221,
				abort() { resolveDone({ stopReason: "aborted", sessionId: cfg.session.sessionId, exitCode: null, signal: null }); },
				done,
			};
		}));

		const project = cwd();
		const tool = { name: "read", description: "read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } };
		const messages = [{ role: "user", content: "read both in parallel", timestamp: Date.now() }];
		const firstEvents = await drain(streamClaudeAgentSdk(MODEL, context(messages, [tool]), { cwd: project }));
		const calls = firstEvents.filter((event) => event.type === "toolcall_end").map((event) => event.toolCall);
		assert.equal(calls.length, 2, "parallel batch must surface both calls before pi executes either");
		messages.push(
			{ role: "assistant", content: calls, timestamp: Date.now() },
			...calls.map((call, index) => ({
				role: "toolResult",
				toolCallId: call.id,
				toolName: "read",
				content: `parallel-result-${index + 1}`,
				isError: false,
				timestamp: Date.now(),
			})),
		);
		const finalEvents = await drain(streamClaudeAgentSdk(MODEL, context(messages, [tool]), { cwd: project }));
		assert.equal(finalEvents.at(-1).type, "done");
		assert.equal(spawnCount, 1);
	});

	it("uses one direct handle for three sequential pi-delivered tool results", async () => {
		// claude-print-driver.one-direct-process-spans-held-tool-rounds
		installDirect();
		restorers.push(__setPiApiRefForTests({ getActiveTools: () => ["read"] }));
		let spawnCount = 0;
		restorers.push(__setSpawnClaudePrintForTests((cfg, options) => {
			spawnCount++;
			let resolveDone;
			const done = new Promise((resolve) => { resolveDone = resolve; });
			const mcp = JSON.parse(cfg.mcpConfig);
			const server = mcp.mcpServers["custom-tools"];
			const socketPath = server.args[server.args.indexOf("--socket") + 1];
			queueMicrotask(async () => {
				options.onPhase?.("ready");
				options.onPhase?.("promptSubmitted");
				options.onPhase?.("turnAccepted");
				const client = await connectIpcClient(socketPath);
				for (let round = 1; round <= 3; round++) {
					const modelId = `toolu_${round}`;
					const args = { path: `/tmp/${round}` };
					options.onToolUseBatch?.({
						batchId: `batch-${round}`,
						observations: [{ modelId, name: "mcp__custom-tools__read", arguments: args }],
					});
					await client.request({
						kind: "tools/call",
						id: randomUUID(),
						modelToolUseId: modelId,
						name: "read",
						arguments: args,
					});
				}
				options.onEvent({ kind: "usage", usage: QUIET_RESULT });
				options.onEvent({ kind: "text-delta", text: "all three complete" });
				options.onEvent({ kind: "done", reason: "result" });
				options.onPhase?.("terminal");
				resolveDone({ stopReason: "result", sessionId: cfg.session.sessionId, exitCode: 0, signal: null });
			});
			return { pid: 222, abort() {}, done };
		}));

		const tool = { name: "read", description: "read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } };
		const messages = [{ role: "user", content: "read three", timestamp: Date.now() }];
		for (let round = 1; round <= 3; round++) {
			const events = await drain(streamClaudeAgentSdk(MODEL, context(messages, [tool]), { cwd: cwd() }));
			const call = events.find((event) => event.type === "toolcall_end")?.toolCall;
			assert.ok(call?.id?.startsWith("pi-"), `round ${round} must route one pi call`);
			messages.push(
				{ role: "assistant", content: [call], timestamp: Date.now() },
				{ role: "toolResult", toolCallId: call.id, toolName: "read", content: `result-${round}`, isError: false, timestamp: Date.now() },
			);
		}
		const finalEvents = await drain(streamClaudeAgentSdk(MODEL, context(messages, [tool]), { cwd: cwd() }));
		assert.equal(finalEvents.at(-1).type, "done");
		assert.equal(spawnCount, 1, "held rounds must not respawn Claude");
	});
});

describe("shared main-turn orchestration — steering detach and pinning", () => {
	it("waits for old direct stream abort before fresh same-driver dispatch", async () => {
		// claude-print-driver.direct-steering-uses-abort-and-fresh-dispatch
		// bridge-driver-selection.driver-failures-never-trigger-cross-driver-fallback
		installDirect();
		const timeline = [];
		let directSpawns = 0;
		let interactiveSpawns = 0;
		restorers.push(__setSpawnClaudePForTests(() => {
			interactiveSpawns++;
			throw new Error("cross-driver fallback/steer dispatch");
		}));
		restorers.push(__setSpawnClaudePrintForTests((cfg, options) => {
			directSpawns++;
			const attempt = directSpawns;
			let resolveDone;
			const done = new Promise((resolve) => { resolveDone = resolve; });
			timeline.push(`spawn-${attempt}`);
			if (attempt === 1) {
				queueMicrotask(() => {
					options.onPhase?.("ready");
					options.onPhase?.("promptSubmitted");
					options.onPhase?.("turnAccepted");
					options.onEvent({ kind: "text-delta", text: "abandoned partial" });
				});
			} else {
				queueMicrotask(() => resolveDone(emitAcceptedResult(cfg, options, "redirected answer")));
			}
			return {
				pid: 300 + attempt,
				abort() {
					timeline.push("old-abort");
					setTimeout(() => {
						timeline.push("old-done");
						resolveDone({ stopReason: "aborted", sessionId: cfg.session.sessionId, exitCode: null, signal: "SIGINT" });
					}, 30);
				},
				done,
			};
		}));

		const project = cwd();
		const firstStream = streamClaudeAgentSdk(MODEL, context([
			{ role: "user", content: "long answer", timestamp: Date.now() },
		]), { cwd: project });
		const firstDrain = drain(firstStream);
		while (directSpawns < 1) await new Promise((resolve) => setTimeout(resolve, 1));
		await new Promise((resolve) => setTimeout(resolve, 5));

		process.env.CLAUDE_BRIDGE_DRIVER = "claude-p";
		const steered = streamClaudeAgentSdk(MODEL, context([
			{ role: "user", content: "long answer", timestamp: Date.now() },
			{ role: "assistant", content: [{ type: "text", text: "abandoned partial" }], timestamp: Date.now() },
			{ role: "user", content: "steer: answer briefly", timestamp: Date.now() },
		]), { cwd: project });
		const steeredDrain = drain(steered);

		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(directSpawns, 1, "replacement must wait for old stream detachment");
		assert.equal(interactiveSpawns, 0, "config change cannot switch a steering invocation");
		const [firstEvents, steeredEvents] = await Promise.all([firstDrain, steeredDrain]);
		assert.equal(firstEvents.at(-1).reason, "aborted");
		assert.match(
			firstEvents.at(-1).error.content.filter((block) => block.type === "text").map((block) => block.text).join(""),
			/abandoned partial/,
			"old aborted message preserves partial for steered history",
		);
		assert.equal(steeredEvents.at(-1).type, "done");
		assert.deepEqual(timeline.slice(0, 4), ["spawn-1", "old-abort", "old-done", "spawn-2"]);
		assert.equal(directSpawns, 2);
		assert.equal(interactiveSpawns, 0);
	});
});
