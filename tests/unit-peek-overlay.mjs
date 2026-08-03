// Unit tests: src/peek/overlay.ts — pure overlay-lines builder + command registration.
// ACs under test:
//   claude-peek-overlay.overlay-toggle-command
//   claude-peek-overlay.explicit-idle-and-error-states
//   claude-peek-overlay.fixed-session-geometry-rendering
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildOverlayLines, registerClaudePeekCommand, OVERLAY_MARKER, DEFAULT_MAX_LINES } from "../src/peek/overlay.js";

const rows40 = (fill) => Array.from({ length: 40 }, (_, i) => (i < 3 ? `${fill}${i} ` + "x".repeat(200) : ""));

describe("buildOverlayLines", () => {
	it("live state renders header marker + cropped content rows", () => {
		const lines = buildOverlayLines(rows40("row"), "live", "/p/sess-1.raw", 50);
		assert.ok(lines[1].includes(OVERLAY_MARKER));
		assert.ok(lines[1].includes("sess-1.raw"));
		// every line exactly width 50 chars wide (borders + crop + pad)
		for (const l of lines) assert.equal([...l].length, 50);
		// trailing blank grid rows trimmed: 3 content rows + header + 2 borders
		assert.equal(lines.length, 6);
	});

	it("idle state renders explicit idle text and no grid rows", () => {
		const lines = buildOverlayLines(rows40("x"), "idle", null, 40);
		assert.ok(lines[1].includes("idle"));
		assert.equal(lines.length, 3); // border + header + border
	});

	it("error state is explicit (claude-peek-overlay.explicit-idle-and-error-states)", () => {
		const lines = buildOverlayLines([], "error", "/p/x.raw", 40);
		assert.ok(lines[1].includes("ERROR"));
	});

	it("crops 120-col rows to narrow widths (claude-peek-overlay.fixed-session-geometry-rendering)", () => {
		const lines = buildOverlayLines(["A".repeat(120)], "live", "/p/x.raw", 30);
		for (const l of lines) assert.ok([...l].length <= 30);
	});

	it("clamps total height to maxLines with a tail view + elision indicator (half-screen popup)", () => {
		const rows = Array.from({ length: 40 }, (_, i) => `row-${i}`);
		const maxLines = 12; // e.g. floor(24-row terminal / 2)
		const lines = buildOverlayLines(rows, "live", "/p/x.raw", 50, maxLines);
		assert.ok(lines.length <= maxLines, `rendered ${lines.length} > maxLines ${maxLines}`);
		const text = lines.join("\n");
		assert.ok(text.includes("rows above"), "elision indicator present");
		assert.ok(text.includes("row-39"), "TAIL kept: last session row visible (spinner/input live at the bottom)");
		assert.ok(!text.includes("row-0"), "head rows elided");
	});

	it("no clamp artifacts when content fits the budget", () => {
		const rows = ["only-row", ...Array.from({ length: 39 }, () => "")];
		const lines = buildOverlayLines(rows, "live", "/p/x.raw", 50, 12);
		assert.ok(!lines.join("\n").includes("rows above"));
		assert.equal(lines.length, 4); // border + header + 1 row + border
	});

	it("default budget is half the 40-row session + chrome", () => {
		const rows = Array.from({ length: 40 }, (_, i) => `r${i}`);
		const lines = buildOverlayLines(rows, "live", "/p/x.raw", 50);
		assert.ok(lines.length <= DEFAULT_MAX_LINES);
		assert.ok(lines.join("\n").includes("r39"));
	});
});

describe("registerClaudePeekCommand (claude-peek-overlay.overlay-toggle-command)", () => {
	it("registers the claude-peek command with handler signature (args, ctx)", () => {
		const cmds = {};
		const fakePi = { registerCommand: (name, opts) => (cmds[name] = opts) };
		registerClaudePeekCommand(fakePi, { warn: () => {} });
		assert.ok(cmds["claude-peek"], "command registered");
		assert.equal(typeof cmds["claude-peek"].handler, "function");
		assert.equal(cmds["claude-peek"].handler.length, 2, "handler takes (args, ctx) — spike gotcha");
	});

	it("synchronous ctx.ui.custom() throw is contained (code-review r2; claude-peek-overlay.peek-failures-never-affect-the-inference-turn)", async () => {
		const cmds = {};
		const fakePi = { registerCommand: (name, opts) => (cmds[name] = opts) };
		const warns = [];
		registerClaudePeekCommand(fakePi, { warn: (o, m) => warns.push(m) });
		const ctx = {
			ui: {
				custom: () => {
					throw new Error("disposed UI context");
				},
			},
		};
		await assert.doesNotReject(cmds["claude-peek"].handler("", ctx));
		assert.equal(warns.length, 1);
		// toggle state was reset: a subsequent invoke attempts to OPEN again (calls custom)
		let calls = 0;
		ctx.ui.custom = () => {
			calls++;
			throw new Error("still broken");
		};
		await assert.doesNotReject(cmds["claude-peek"].handler("", ctx));
		assert.equal(calls, 1, "handler tried to open again (openDone was reset)");
	});

	it("headless ctx (no ui) is a safe no-op", async () => {
		const cmds = {};
		const fakePi = { registerCommand: (name, opts) => (cmds[name] = opts) };
		registerClaudePeekCommand(fakePi, { warn: () => {} });
		await assert.doesNotReject(cmds["claude-peek"].handler("", {}));
	});

	it("reports explicit no-tail unavailability under claude-print without opening overlay", async () => {
		const cmds = {};
		const notices = [];
		let customCalls = 0;
		const fakePi = { registerCommand: (name, opts) => (cmds[name] = opts) };
		registerClaudePeekCommand(fakePi, { warn: () => {} }, {
			getDriverKind: (cwd) => {
				assert.equal(cwd, "/project");
				return "claude-print";
			},
		});
		await cmds["claude-peek"].handler("", {
			cwd: "/project",
			ui: {
				notify: (message, type) => notices.push({ message, type }),
				custom: () => { customCalls++; },
			},
		});
		assert.equal(customCalls, 0);
		assert.deepEqual(notices, [{
			message: "/claude-peek unavailable: claude-print has no interactive PTY tail",
			type: "info",
		}]);
	});

	it("toggle lifecycle: open shows component, second invoke resolves done()", async () => {
		const cmds = {};
		const fakePi = { registerCommand: (name, opts) => (cmds[name] = opts) };
		registerClaudePeekCommand(fakePi, { warn: () => {} });

		let resolved = false;
		let component;
		const fakeTui = { requestRender: () => {} };
		const ctx = {
			ui: {
				custom: (factory, _opts) =>
					new Promise((resolve) => {
						component = factory(fakeTui, {}, {}, (r) => {
							resolved = true;
							component.dispose?.();
							resolve(r);
						});
					}),
			},
		};
		await cmds["claude-peek"].handler("", ctx); // open (returns; custom promise pending)
		assert.ok(component, "component created");
		const lines = component.render(44);
		assert.ok(lines.some((l) => l.includes(OVERLAY_MARKER)));
		await cmds["claude-peek"].handler("", ctx); // toggle off → done()
		assert.ok(resolved, "done() resolved on second invoke");
		// third invoke re-opens cleanly (openDone was reset by dispose)
		await cmds["claude-peek"].handler("", ctx);
		assert.ok(component, "re-open works");
		await cmds["claude-peek"].handler("", ctx); // close again for cleanup
	});
});
