// src/peek/screen.ts — headless terminal screen model for the peek overlay.
//
// Maintains a fixed 120×40 grid (matching the claude-p session geometry —
// claude-peek-overlay.fixed-session-geometry-rendering) fed with raw PTY
// bytes, and snapshots the visible rows as plain strings for the overlay
// component. The underlying session is NEVER resized by this module.

import xterm from "@xterm/headless";

/** Fixed claude-p session geometry (claude-p driver.zig cols=120 rows=40). */
export const PEEK_COLS = 120;
export const PEEK_ROWS = 40;

/** Crop or pad one grid row to the overlay's inner width, honoring an h-scroll offset. */
export function cropRow(row: string, width: number, offset = 0): string {
	if (width <= 0) return "";
	return row.slice(offset, offset + width);
}

export class PeekScreen {
	private term: InstanceType<typeof xterm.Terminal>;

	constructor() {
		this.term = new xterm.Terminal({
			cols: PEEK_COLS,
			rows: PEEK_ROWS,
			allowProposedApi: true,
			scrollback: 0,
		});
	}

	/** Feed raw PTY bytes; resolves after the emulator has parsed them. */
	feed(data: string | Uint8Array): Promise<void> {
		return new Promise((resolve) => this.term.write(data, resolve));
	}

	/** Visible rows (PEEK_ROWS strings, trailing whitespace trimmed per row). */
	snapshotRows(): string[] {
		const buf = this.term.buffer.active;
		const rows: string[] = [];
		for (let y = 0; y < PEEK_ROWS; y++) {
			const line = buf.getLine(buf.viewportY + y);
			rows.push(line ? line.translateToString(true) : "");
		}
		return rows;
	}

	/** Hard reset (used on retarget to a new spawn's mirror). */
	reset(): void {
		this.term.reset();
	}

	dispose(): void {
		this.term.dispose();
	}
}
