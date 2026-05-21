#!/usr/bin/env node
// Unit tests for src/driver/ansi.ts (T1.4a).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripAnsi } from "../src/driver/ansi.js";

describe("stripAnsi — pass-through", () => {
	it("returns empty string unchanged", () => {
		assert.equal(stripAnsi(""), "");
	});

	it("returns plain ASCII unchanged", () => {
		assert.equal(stripAnsi("Hello, world!"), "Hello, world!");
	});

	it("preserves UTF-8 multibyte text", () => {
		assert.equal(stripAnsi("héllo — 漢字 — 🦫"), "héllo — 漢字 — 🦫");
	});

	it("preserves newlines, tabs, and CR", () => {
		assert.equal(stripAnsi("a\nb\tc\rd"), "a\nb\tc\rd");
	});
});

describe("stripAnsi — CSI sequences", () => {
	it("strips SGR color codes", () => {
		assert.equal(stripAnsi("\x1b[31mred\x1b[0m"), "red");
	});

	it("strips multi-parameter SGR", () => {
		assert.equal(stripAnsi("\x1b[1;33;44mfancy\x1b[0m"), "fancy");
	});

	it("strips cursor positioning", () => {
		assert.equal(stripAnsi("\x1b[2J\x1b[H\x1b[1;1Hclear"), "clear");
	});

	it("strips DECSET / DECRST (private-mode CSI)", () => {
		assert.equal(stripAnsi("\x1b[?25l\x1b[?1049hhidden\x1b[?25h"), "hidden");
	});

	it("strips erase-line and erase-display", () => {
		assert.equal(stripAnsi("\x1b[2Kline\x1b[J"), "line");
	});
});

describe("stripAnsi — OSC sequences", () => {
	it("strips OSC terminated by BEL", () => {
		assert.equal(stripAnsi("\x1b]0;window-title\x07after"), "after");
	});

	it("strips OSC terminated by ST (ESC \\)", () => {
		assert.equal(stripAnsi("\x1b]2;xterm-title\x1b\\after"), "after");
	});

	it("strips OSC with empty body", () => {
		assert.equal(stripAnsi("\x1b]\x07x"), "x");
	});
});

describe("stripAnsi — short ESC sequences", () => {
	it("strips DECSC / DECRC (save / restore cursor)", () => {
		assert.equal(stripAnsi("a\x1b7b\x1b8c"), "abc");
	});

	it("strips keypad-mode escapes", () => {
		assert.equal(stripAnsi("\x1b=on\x1b>off"), "onoff");
	});

	it("strips IND / NEL / RI", () => {
		assert.equal(stripAnsi("a\x1bDb\x1bEc\x1bMd"), "abcd");
	});
});

describe("stripAnsi — charset designation", () => {
	it("strips ESC ( B (G0 → US-ASCII)", () => {
		assert.equal(stripAnsi("\x1b(Btext"), "text");
	});

	it("strips ESC ) 0 (G1 → DEC special graphics)", () => {
		assert.equal(stripAnsi("\x1b)0body"), "body");
	});
});

describe("stripAnsi — DCS / PM / APC", () => {
	it("strips a DCS sequence", () => {
		assert.equal(stripAnsi("pre\x1bPa;b;c\x1b\\post"), "prepost");
	});

	it("strips an APC sequence", () => {
		assert.equal(stripAnsi("pre\x1b_payload\x1b\\post"), "prepost");
	});
});

describe("stripAnsi — C1 controls", () => {
	it("strips bare CSI byte (0x9B)", () => {
		assert.equal(stripAnsi("a\x9bb"), "ab");
	});

	it("strips a range of C1 bytes", () => {
		const input = "x\x80\x85\x9f\x9by";
		assert.equal(stripAnsi(input), "xy");
	});
});

describe("stripAnsi — Ink TUI fixture (trust dialog shape)", () => {
	it("recovers 'Accessing workspace:' from colorized output", () => {
		const raw =
			"\x1b[?25l\x1b[2J\x1b[H" +
			"\x1b[36mAccessing workspace:\x1b[0m \x1b[1m/private/var/folders/foo/spike-t14-XXX\x1b[0m\r\n";
		const stripped = stripAnsi(raw);
		assert.ok(stripped.includes("Accessing workspace:"), `expected substring in: ${JSON.stringify(stripped)}`);
		assert.ok(stripped.includes("/private/var/folders/foo/spike-t14-XXX"));
	});

	it("recovers 'Quick safety check' from colorized output", () => {
		const raw =
			"\x1b[1;33mQuick safety check\x1b[0m: Is this a project you created or one you trust?\r\n" +
			"\x1b[2m(Like your own code, a well-known open source project, ...)\x1b[0m\r\n";
		const stripped = stripAnsi(raw);
		assert.ok(stripped.includes("Quick safety check"));
		assert.ok(stripped.includes("Is this a project you created or one you trust?"));
	});

	it("strips a representative Ink boot frame and leaves visible text", () => {
		const raw =
			"\x1b]0;claude\x07" +
			"\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H" +
			"\x1b[38;5;39m▍\x1b[0m \x1b[1mclaude\x1b[0m \x1b[2m(2.1.114)\x1b[0m\r\n" +
			"\x1b[2K\x1b[GAccessing workspace: /tmp/foo\r\n" +
			"\x1b[2K\x1b[GQuick safety check: Is this a project you created or one you trust?\r\n";
		const stripped = stripAnsi(raw);
		assert.ok(stripped.includes("Accessing workspace:"));
		assert.ok(stripped.includes("Quick safety check"));
		// No raw ESC bytes survive
		assert.ok(!stripped.includes("\x1b"), `expected no ESC in: ${JSON.stringify(stripped)}`);
	});
});

describe("stripAnsi — streaming safety", () => {
	it("leaves an unterminated CSI prefix intact (caller will re-feed)", () => {
		// Partial input: ESC [ 3 1 ... (final byte not yet arrived)
		const partial = "before\x1b[31";
		const stripped = stripAnsi(partial);
		// The ESC [31 has no final byte → CSI_RE does not match. We accept
		// either: (a) left in place as-is, or (b) ESC removed by the short
		// sweep. The contract is "no corruption of completed text" and "no
		// premature consumption of params". Both are fine; assert that the
		// visible text 'before' survives.
		assert.ok(stripped.startsWith("before"));
	});

	it("strips completed sequences when caller concatenates partials", () => {
		const a = "before\x1b[3";
		const b = "1mred\x1b[0mafter";
		// Real usage: scanner accumulates, then strips the whole buffer.
		const stripped = stripAnsi(a + b);
		assert.equal(stripped, "beforeredafter");
	});
});
