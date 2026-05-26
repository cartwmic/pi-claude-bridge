// src/driver/ansi.ts
//
// ANSI escape sequence stripper for PTY output. Used by D25's trust-dialog
// scanner and any future PTY-output substring scanning. Conforms to the subset
// of ECMA-48 / xterm sequences that Ink TUIs (and therefore the interactive
// `claude` binary) emit:
//
//   - CSI:           ESC '[' params final-byte                  (e.g. "\x1b[31m", "\x1b[?25l")
//   - OSC:           ESC ']' ... (BEL | ESC '\')                (e.g. "\x1b]0;title\x07")
//   - DCS / PM / APC ESC ('P' | '^' | '_') ... ESC '\'
//   - Charset:       ESC ('(' | ')' | '*' | '+') final-byte     (e.g. "\x1b(B")
//   - Short:         ESC <single-byte>                          (e.g. "\x1b7", "\x1bE")
//   - C1 controls:   bytes 0x80-0x9F
//
// NOT a terminal emulator — cursor positioning / line wrap / erasure semantics
// are intentionally NOT simulated. The contract is: after stripAnsi() the
// resulting string contains only printable text plus newlines / tabs / spaces,
// such that substring matching against known dialog strings works regardless
// of how Ink colorized or repositioned them.
//
// Streaming caveat: if the input ends mid-escape (e.g. "...\x1b[31" without
// the final byte), the partial sequence is left in place rather than
// corrupted. Callers using a rolling buffer (TrustDialogScanner) will see the
// remainder on the next feed() and the now-complete sequence will be stripped
// in that pass.

// CSI CUF (cursor-forward): ESC [ Pn C — semantic horizontal movement.
// Ink TUIs (Ink 5+) render word-separators as CSI CUF instead of literal
// spaces; if we strip these blindly, "Accessing workspace:" arrives as
// "Accessingworkspace:" and substring matching against the trust-dialog
// fixture fails. Expand to Pn spaces (default 1) BEFORE the generic CSI
// strip so visible word boundaries survive.
const CSI_CUF_RE = /\x1b\[(\d*)C/g;

// CSI CHA (cursor-horizontal-absolute): ESC [ Pn G — move cursor to absolute
// column. CC v2.1.150's workspace-trust dialog uses CHA between words instead
// of CUF (or literal spaces): "Accessing\x1b[12Gworkspace:" rather than
// "Accessing \x1b[1Cworkspace:". Without expansion, stripAnsi collapses the
// words and the trust-dialog scanner misses the trigger. Replace each CHA
// with a single space; we can't honor the absolute column without a column
// tracker, but one space is enough to keep visible words separated for
// substring matching.
const CSI_CHA_RE = /\x1b\[\d*G/g;

// CSI: ESC [ <params 0x30-0x3F> <intermediates 0x20-0x2F> <final 0x40-0x7E>
const CSI_RE = /\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g;

// OSC: ESC ] <body, no BEL or ESC> (BEL | ESC \)
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

// DCS / PM / APC: ESC (P|^|_) ... ESC \   (non-greedy body)
const DCS_PM_APC_RE = /\x1b[P^_][\s\S]*?\x1b\\/g;

// Charset designation: ESC ( ) * + <ASCII final-byte>
const ESC_CHARSET_RE = /\x1b[()*+][A-Za-z0-9@]/g;

// Common short ESC sequences emitted by Ink / xterm:
//   7  DECSC (save cursor)
//   8  DECRC (restore cursor)
//   =  DECPAM (keypad app mode)
//   >  DECPNM (keypad normal mode)
//   c  RIS (reset)
//   D  IND (index)
//   E  NEL (next line)
//   H  HTS (horizontal tab set)
//   M  RI (reverse index)
const ESC_SHORT_RE = /\x1b[78=>cDEHM]/g;

// C1 control characters (8-bit equivalents of ESC sequences).
const C1_RE = /[\x80-\x9f]/g;

/**
 * Remove ANSI escape sequences and C1 controls from a string.
 *
 * Order of operations matters: multi-byte sequences are stripped before the
 * short-form sweep so that e.g. an unterminated "\x1b[..." in mid-stream isn't
 * misread as "\x1b" + "[" + leftover params.
 */
export function stripAnsi(input: string): string {
	return input
		.replace(DCS_PM_APC_RE, "")
		.replace(OSC_RE, "")
		.replace(CSI_CUF_RE, (_, n) => " ".repeat(Math.max(1, Math.min(parseInt(n, 10) || 1, 256))))
		.replace(CSI_CHA_RE, " ")
		.replace(CSI_RE, "")
		.replace(ESC_CHARSET_RE, "")
		.replace(ESC_SHORT_RE, "")
		.replace(C1_RE, "");
}
