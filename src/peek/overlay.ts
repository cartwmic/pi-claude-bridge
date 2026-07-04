// src/peek/overlay.ts — /claude-peek command + pi-tui overlay component.
//
// Toggles a live, READ-ONLY picture-in-picture view of the underlying
// `claude` Ink TUI inside the pi terminal (claude-peek-overlay.overlay-
// toggle-command). Rendering goes exclusively through the documented
// ExtensionUIContext.custom() API — never pi-tui internals (Constitution II /
// domain "Pi UI rendering" exception).
//
// Spike-proven mechanics baked in (see .spike-notes/claude-peek/CONCLUSION.md):
//   - registerCommand handler signature is (args, ctx) — NOT (ctx).
//   - ctx.ui.custom() resolves only when done() is called: we retain `done`
//     for toggle-off and clear timers/subscriptions in dispose().
//   - nonCapturing: true leaves keyboard focus with the pi editor.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { basename } from "path";
import { MirrorFollower, type PeekState } from "./follower.js";
import type { FollowerLogger } from "./follower.js";
import { getCurrentMirror, hasCurrentMirrorError, onCurrentMirrorChange } from "./mirror.js";
import { cropRow } from "./screen.js";

/** Marker rendered in the overlay header (also asserted by scenario s31). */
export const OVERLAY_MARKER = "claude-peek";

/** Overlay width: full session width + borders when it fits, else 60% of terminal. */
export const OVERLAY_WIDTH_PCT = "60%" as const;

/**
 * PURE overlay-lines builder (unit-testable without a TUI): border + state
 * header + cropped grid rows. `width` is the overlay's rendered width; rows
 * are cropped to the inner width (claude-peek-overlay.fixed-session-geometry-
 * rendering — the session itself is never resized).
 */
export function buildOverlayLines(rows: string[], state: PeekState, target: string | null, width: number): string[] {
	const inner = Math.max(10, width - 2);
	const title =
		state === "live"
			? `● ${OVERLAY_MARKER} — live ${target ? basename(target) : ""}`
			: state === "error"
				? `✖ ${OVERLAY_MARKER} — ERROR (see bridge log)`
				: `○ ${OVERLAY_MARKER} — idle (no active claude session)`;
	const bar = "─".repeat(inner);
	const pad = (s: string) => {
		const c = cropRow(s, inner);
		return `│${c}${" ".repeat(inner - c.length)}│`;
	};
	const lines = [`┌${bar}┐`, pad(title.slice(0, inner))];
	if (state === "live") {
		// Trim trailing blank rows so the overlay hugs the content.
		let last = rows.length - 1;
		while (last >= 0 && rows[last].trim() === "") last--;
		for (let y = 0; y <= last; y++) lines.push(pad(rows[y]));
	}
	lines.push(`└${bar}┘`);
	return lines;
}

/** Register the /claude-peek toggle command. Returns nothing; safe to call once at activate. */
export function registerClaudePeekCommand(pi: ExtensionAPI, log: FollowerLogger): void {
	let openDone: ((r: undefined) => void) | undefined;

	pi.registerCommand("claude-peek", {
		description: "Toggle a live read-only peek of the underlying Claude session",
		handler: async (_args: string, ctx) => {
			if (!ctx.ui) return; // headless mode: no overlay surface
			if (openDone) {
				// Toggle OFF: resolve the retained done(); dispose() handles cleanup.
				const d = openDone;
				openDone = undefined;
				d(undefined);
				return;
			}
			try {
				const shown = ctx.ui.custom<undefined>(
				(tui, _theme, _kb, done) => {
					openDone = done;
					let state: PeekState = "idle";
					const follower = new MirrorFollower({
						log,
						onFrame: () => tui.requestRender(),
						onState: (s) => {
							state = s;
							tui.requestRender();
						},
					});
					const unsubscribe = onCurrentMirrorChange((p, error) => {
						if (error) follower.forceError("mirror preparation failed");
						else follower.retarget(p);
					});
					// Attach to an in-flight turn (or an already-failed mirror) immediately.
					if (hasCurrentMirrorError()) follower.forceError("mirror preparation failed");
					else follower.retarget(getCurrentMirror());
					return {
						render(width: number): string[] {
							return buildOverlayLines(follower.rows(), state, getCurrentMirror(), width);
						},
						invalidate() {},
						dispose() {
							unsubscribe();
							follower.dispose();
							openDone = undefined; // external close (e.g. hide) resets the toggle
						},
					};
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "top-right",
						margin: { top: 1, right: 1 },
						width: OVERLAY_WIDTH_PCT,
						nonCapturing: true,
					},
				},
			);
				// Overlay lifecycle failures are peek failures: log + reset the
				// toggle, never an unhandled rejection (claude-peek-overlay.peek-
				// failures-never-affect-the-inference-turn; code-review r1 finding).
				shown.catch((err) => {
					openDone = undefined;
					log.warn({ err: err instanceof Error ? err.message : String(err) }, "peek: overlay failed (non-fatal)");
				});
			} catch (err) {
				// Synchronous ctx.ui.custom() throw (disposed/incompatible UI context)
				// is equally a peek failure — contain it here so the command handler
				// never rejects (code-review r2 finding).
				openDone = undefined;
				log.warn({ err: err instanceof Error ? err.message : String(err) }, "peek: overlay creation threw (non-fatal)");
			}
		},
	});
}
