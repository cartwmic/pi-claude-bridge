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
			assert.equal(parked[0].name, "mcp__custom-tools__read");
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
