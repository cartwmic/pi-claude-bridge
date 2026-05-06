// Test extension: registers a tool that blocks until release() is called.
// Mirror of slow-tool-extension.ts — but instead of a fixed delay, the handler
// awaits a process-level Promise that the test resolves via release().
// The test harness imports this file and calls release() to unblock the handler.

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

let _release: ((value?: unknown) => void) | null = null;

/** Resolve the pending wait_until_released handler. Safe to call even if no handler is waiting. */
export function release(): void {
	if (_release) {
		_release();
		_release = null;
	}
}

/** True if a wait_until_released handler is currently blocking. */
export function isBlocked(): boolean {
	return _release !== null;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "wait_until_released",
		label: "Wait until released",
		description:
			"Blocks indefinitely until the test harness calls release(). " +
			"Use when asked to call wait_until_released.",
		parameters: Type.Object({}),
		async execute(_id, _params, signal) {
			await new Promise<void>((resolve, reject) => {
				_release = resolve;
				signal?.addEventListener(
					"abort",
					() => {
						_release = null;
						reject(new Error("aborted"));
					},
					{ once: true },
				);
			});
			return {
				content: [{ type: "text" as const, text: "wait_until_released: released" }],
				details: {},
			};
		},
	});
}
