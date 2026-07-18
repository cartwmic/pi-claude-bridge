#!/usr/bin/env node
// Unit tests for src/mcp/router.ts (T1.7) — held-open promise-park + D32 keying.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/mcp/router.js";
import { connectIpcClient } from "../src/mcp/ipc.js";

// Deterministic id minting so tests can predict the pi-facing key.
function seqMinter() {
	let n = 0;
	return () => `pi-${++n}`;
}

async function withRouter(fn, mintPiId = seqMinter()) {
	const router = createRouter({ mintPiId });
	await router.start();
	const client = await connectIpcClient(router.socketPath);
	try {
		await fn(router, client);
	} finally {
		client.close();
		await router.stop();
	}
}

describe("router — park and resolve", () => {
	it("parks a tools/call and resolves it only on deliver()", async () => {
		await withRouter(async (router, client) => {
			let resolved = false;
			const callP = client
				.request({ kind: "tools/call", id: "shim-1", name: "mcp__custom-tools__read", arguments: { path: "/tmp/x" } })
				.then((r) => {
					resolved = true;
					return r;
				});

			// Wait for the call to be parked.
			await new Promise((r) => setTimeout(r, 20));
			assert.equal(resolved, false, "must not resolve before deliver()");
			const parked = router.listParkedCalls();
			assert.equal(parked.length, 1);
			assert.equal(parked[0].name, "read", "qualified shim name normalizes to router bare name");
			const piId = parked[0].piId;
			assert.equal(piId, "pi-1");
			assert.ok(router.pendingResolvers.has(piId));

			router.deliver(piId, { content: [{ type: "text", text: "file-contents" }] });

			const res = await callP;
			assert.equal(resolved, true);
			assert.equal(res.kind, "tools/call:response");
			assert.equal(res.id, "shim-1");
			assert.deepEqual(res.content, [{ type: "text", text: "file-contents" }]);
			assert.equal(router.listParkedCalls().length, 0);
			assert.equal(router.pendingResolvers.has(piId), false);
		});
	});

	it("propagates isError on the resolved payload", async () => {
		await withRouter(async (router, client) => {
			const callP = client.request({ kind: "tools/call", id: "s", name: "mcp__custom-tools__x", arguments: {} });
			await new Promise((r) => setTimeout(r, 10));
			router.deliver("pi-1", { content: [{ type: "text", text: "boom" }], isError: true });
			const res = await callP;
			assert.equal(res.isError, true);
		});
	});

	it("handles deliver-before-park (early result race) via pendingResults", async () => {
		// deliver() for an id that hasn't been parked stashes into pendingResults;
		// the next call that mints that id picks it up immediately.
		const router = createRouter({ mintPiId: () => "pi-fixed" });
		await router.start();
		const client = await connectIpcClient(router.socketPath);
		try {
			router.deliver("pi-fixed", { content: [{ type: "text", text: "early" }] });
			assert.ok(router.pendingResults.has("pi-fixed"));
			const res = await client.request({ kind: "tools/call", id: "s", name: "n", arguments: {} });
			assert.deepEqual(res.content, [{ type: "text", text: "early" }]);
			assert.equal(router.pendingResults.has("pi-fixed"), false);
		} finally {
			client.close();
			await router.stop();
		}
	});
});

// AC: mcp-stdio-shim.tool-call-correlation-across-the-split-channels-d32
// Observation channel never executes. Router keeps pi id as resolver key while
// model ids become order-independent aliases inside a sealed assistant batch.
describe("router — D32 observation join", () => {
	it("joins observation-first qualified name to delayed bare shim call", async () => {
		await withRouter(async (router, client) => {
			router.observeToolUse({ batchId: "msg-1", modelId: "toolu_obs", name: "mcp__custom-tools__read", arguments: { z: 1, a: 2 } });
			router.sealToolUseBatch("msg-1");

			const callP = client.request({ kind: "tools/call", id: "shim-obs", name: "read", arguments: { a: 2, z: 1 } });
			await new Promise((r) => setTimeout(r, 20));
			const [parked] = router.listParkedCalls();
			assert.equal(parked.piId, "pi-1");
			assert.equal(parked.modelId, "toolu_obs");
			assert.equal(router.resolvePiIdForModelId("toolu_obs"), "pi-1");
			assert.equal(router.getCorrelationFailure(), undefined);

			router.deliver("pi-1", { content: [{ type: "text", text: "ok" }] });
			assert.equal((await callP).content[0].text, "ok");
			assert.equal(router.resolvePiIdForModelId("toolu_obs"), undefined, "alias removed with resolver");
		});
	});

	it("keeps completed shim metadata until a later observation joins", async () => {
		await withRouter(async (router, client) => {
			const callP = client.request({ kind: "tools/call", id: "shim-fast", name: "read", arguments: { path: "/fast" } });
			await new Promise((r) => setTimeout(r, 20));
			router.deliver("pi-1", { content: [{ type: "text", text: "fast" }] });
			await callP;
			assert.equal(router.listParkedCalls().length, 0, "resolver already settled");
			router.observeToolUse({ batchId: "msg-fast", modelId: "toolu_fast", name: "mcp__custom-tools__read", arguments: { path: "/fast" } });
			router.sealToolUseBatch("msg-fast");
			assert.equal(router.finalizeToolUseCorrelation(), undefined);
			assert.equal(router.resolvePiIdForModelId("toolu_fast"), undefined, "settled resolver alias is not retained");
		});
	});

	it("joins shim-first and keeps resolver keyed by stable pi id", async () => {
		await withRouter(async (router, client) => {
			const callP = client.request({ kind: "tools/call", id: "shim-first", name: "read", arguments: { path: "/x" } });
			await new Promise((r) => setTimeout(r, 20));
			assert.ok(router.pendingResolvers.has("pi-1"));

			router.observeToolUse({ batchId: "msg-1", modelId: "toolu_late", name: "mcp__custom-tools__read", arguments: { path: "/x" } });
			router.sealToolUseBatch("msg-1");
			assert.equal(router.resolvePiIdForModelId("toolu_late"), "pi-1");
			assert.ok(router.pendingResolvers.has("pi-1"));
			assert.equal(router.pendingResolvers.has("toolu_late"), false);

			router.deliver("pi-1", { content: [{ type: "text", text: "done" }] });
			assert.equal((await callP).id, "shim-first");
		});
	});

	it("pairs identical calls positionally inside one sealed batch", async () => {
		await withRouter(async (router, client) => {
			router.observeToolUse({ batchId: "msg-p", modelId: "toolu_1", name: "mcp__custom-tools__ls", arguments: { dir: "/" } });
			router.observeToolUse({ batchId: "msg-p", modelId: "toolu_2", name: "mcp__custom-tools__ls", arguments: { dir: "/" } });
			router.sealToolUseBatch("msg-p");
			const p1 = client.request({ kind: "tools/call", id: "shim-1", name: "ls", arguments: { dir: "/" } });
			const p2 = client.request({ kind: "tools/call", id: "shim-2", name: "ls", arguments: { dir: "/" } });
			await new Promise((r) => setTimeout(r, 20));
			assert.equal(router.resolvePiIdForModelId("toolu_1"), "pi-1");
			assert.equal(router.resolvePiIdForModelId("toolu_2"), "pi-2");
			router.deliver("pi-2", { content: [{ type: "text", text: "second" }] });
			router.deliver("pi-1", { content: [{ type: "text", text: "first" }] });
			assert.equal((await p1).content[0].text, "first");
			assert.equal((await p2).content[0].text, "second");
		});
	});

	it("ignores native, housekeeping, and foreign observations without count failure", async () => {
		const router = createRouter({ mintPiId: seqMinter() });
		assert.equal(router.observeToolUse({ batchId: "ignored", modelId: "native", name: "Read", arguments: {} }), "ignored");
		assert.equal(router.observeToolUse({ batchId: "ignored", modelId: "wait", name: "WaitForMcpServers", arguments: {} }), "ignored");
		assert.equal(router.observeToolUse({ batchId: "ignored", modelId: "foreign", name: "mcp__foreign__read", arguments: {} }), "ignored");
		router.sealToolUseBatch("ignored");
		assert.equal(router.finalizeToolUseCorrelation(), undefined);
		await router.stop();
	});

	it("fails, drains, and signals invalidation on sealed canonical mismatch", async () => {
		const failures = [];
		const router = createRouter({ mintPiId: seqMinter(), onCorrelationFailure: (failure) => failures.push(failure) });
		await router.start();
		const client = await connectIpcClient(router.socketPath);
		try {
			const callP = client.request({ kind: "tools/call", id: "shim-bad", name: "write", arguments: { path: "/x" } });
			await new Promise((r) => setTimeout(r, 20));
			router.observeToolUse({ batchId: "msg-bad", modelId: "toolu_bad", name: "mcp__custom-tools__read", arguments: { path: "/x" } });
			router.sealToolUseBatch("msg-bad");
			const failure = router.getCorrelationFailure();
			assert.equal(failure?.code, "tool-call-correlation-mismatch");
			assert.equal(failure?.invalidateResumeHint, true);
			assert.equal(failures.length, 1);
			const drained = await callP;
			assert.equal(drained.isError, true);
			assert.match(drained.content[0].text, /correlation/i);
			assert.equal(router.pendingResolvers.size, 0);
		} finally {
			client.close();
			await router.stop();
			await router.stop();
		}
	});

	it("fails terminal under-count but permits delayed shim after batch seal", async () => {
		const router = createRouter({ mintPiId: seqMinter() });
		await router.start();
		const client = await connectIpcClient(router.socketPath);
		try {
			router.observeToolUse({ batchId: "msg-delay", modelId: "toolu_delay", name: "mcp__custom-tools__read", arguments: {} });
			router.sealToolUseBatch("msg-delay");
			assert.equal(router.getCorrelationFailure(), undefined, "seal waits for delayed shim");
			const callP = client.request({ kind: "tools/call", id: "shim-delay", name: "read", arguments: {} });
			await new Promise((r) => setTimeout(r, 20));
			assert.equal(router.getCorrelationFailure(), undefined);
			router.deliver("pi-1", { content: [{ type: "text", text: "ok" }] });
			await callP;
			assert.equal(router.finalizeToolUseCorrelation(), undefined);
		} finally {
			client.close();
			await router.stop();
		}

		const under = createRouter();
		under.observeToolUse({ batchId: "msg-under", modelId: "toolu_missing", name: "mcp__custom-tools__read", arguments: {} });
		under.sealToolUseBatch("msg-under");
		assert.equal(under.finalizeToolUseCorrelation()?.code, "tool-call-correlation-mismatch");
		await under.stop();
	});

	it("deduplicates repeated shim request ids without minting or routing twice", async () => {
		let parks = 0;
		const router = createRouter({ mintPiId: seqMinter(), onPark: () => parks++ });
		await router.start();
		const client = await connectIpcClient(router.socketPath);
		try {
			const req = { kind: "tools/call", id: "same-id", name: "read", arguments: {} };
			const p1 = client.request(req);
			const p2 = client.request(req);
			await new Promise((r) => setTimeout(r, 20));
			assert.equal(parks, 1);
			assert.equal(router.listParkedCalls().length, 1);
			router.observeToolUse({ batchId: "msg", modelId: "toolu", name: "mcp__custom-tools__read", arguments: {} });
			router.sealToolUseBatch("msg");
			router.deliver("pi-1", { content: [{ type: "text", text: "once" }] });
			assert.deepEqual(await p1, await p2);
		} finally {
			client.close();
			await router.stop();
		}
	});
});

describe("router — D32 parallel held calls", () => {
	it("two parallel parked calls resolve independently with no cross-wiring", async () => {
		await withRouter(async (router, client) => {
			const p1 = client.request({ kind: "tools/call", id: "shim-a", name: "read", arguments: { path: "/a" } });
			const p2 = client.request({ kind: "tools/call", id: "shim-b", name: "read", arguments: { path: "/b" } });

			await new Promise((r) => setTimeout(r, 20));
			const parked = router.listParkedCalls();
			assert.equal(parked.length, 2, "both calls parked concurrently");
			// minted ids are distinct -> keyed independently
			const ids = parked.map((p) => p.piId).sort();
			assert.deepEqual(ids, ["pi-1", "pi-2"]);

			// Resolve out of order: deliver pi-2 first.
			router.deliver("pi-2", { content: [{ type: "text", text: "B" }] });
			router.deliver("pi-1", { content: [{ type: "text", text: "A" }] });

			const [r1, r2] = await Promise.all([p1, p2]);
			assert.equal(r1.id, "shim-a");
			assert.equal(r1.content[0].text, "A");
			assert.equal(r2.id, "shim-b");
			assert.equal(r2.content[0].text, "B");
		});
	});

	it("identical name+args parallel calls still key independently", async () => {
		await withRouter(async (router, client) => {
			const p1 = client.request({ kind: "tools/call", id: "shim-a", name: "ls", arguments: { dir: "/" } });
			const p2 = client.request({ kind: "tools/call", id: "shim-b", name: "ls", arguments: { dir: "/" } });

			await new Promise((r) => setTimeout(r, 20));
			assert.equal(router.listParkedCalls().length, 2);

			router.deliver("pi-1", { content: [{ type: "text", text: "first" }] });
			router.deliver("pi-2", { content: [{ type: "text", text: "second" }] });

			const [r1, r2] = await Promise.all([p1, p2]);
			// shim-a parked first -> pi-1 -> "first"; shim-b -> pi-2 -> "second"
			assert.equal(r1.id, "shim-a");
			assert.equal(r1.content[0].text, "first");
			assert.equal(r2.id, "shim-b");
			assert.equal(r2.content[0].text, "second");
		});
	});
});

describe("router — capture stash + tool decls", () => {
	it("stores and reads a capture stash", async () => {
		await withRouter(async (router, client) => {
			assert.equal(router.getCaptureStash(), undefined);
			const ack = await client.request({ kind: "capture-stash", id: "c1", arguments: { summary: "done", ok: true } });
			assert.equal(ack.kind, "capture-stash:ack");
			assert.deepEqual(router.getCaptureStash(), { summary: "done", ok: true });
		});
	});

	it("keeps latest monotonic validation failure until a valid stash suppresses it", async () => {
		await withRouter(async (router, client) => {
			await client.request({ kind: "capture-validation-failed", id: "v2", attempt: 2, field: "$.new", message: "new" });
			await client.request({ kind: "capture-validation-failed", id: "v1", attempt: 1, field: "$.old", message: "old" });
			assert.deepEqual(router.getCaptureValidationFailure(), { attempt: 2, field: "$.new", message: "new" });
			await client.request({ kind: "capture-stash", id: "valid", arguments: { ok: true } });
			assert.equal(router.getCaptureValidationFailure(), undefined);
		});
	});

	it("keeps the first stash if a second arrives", async () => {
		await withRouter(async (router, client) => {
			await client.request({ kind: "capture-stash", id: "c1", arguments: { v: 1 } });
			await client.request({ kind: "capture-stash", id: "c2", arguments: { v: 2 } });
			assert.deepEqual(router.getCaptureStash(), { v: 1 });
		});
	});

	it("declareTools stores the advertised set for the bridge to read", async () => {
		const router = createRouter();
		const defs = [{ name: "mcp__custom-tools__read", description: "read", inputSchema: { type: "object" } }];
		router.declareTools(defs);
		assert.deepEqual(router.toolDefs, defs);
		// declareTools snapshots (mutating the input array does not leak in)
		defs.push({ name: "mcp__custom-tools__write" });
		assert.equal(router.toolDefs.length, 1);
	});
});
