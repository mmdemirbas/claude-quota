/**
 * Regex matching any ANSI SGR escape sequence (colors, bold, reset, etc.).
 * Anchored `y` (sticky) so `exec` only matches at `lastIndex` — lets the
 * scanner walk the string without allocating substrings.
 */
const ANSI_SGR = /\x1b\[[0-9;]*m/y;
const ANSI_SGR_GLOBAL = /\x1b\[[0-9;]*m/g;
const ANSI_RESET = /^\x1b\[0?m$/;
const ESC_CHAR = 0x1b;

/** Count visible (non-ANSI) characters in a string. */
export function visibleLength(s: string): number {
  // Fast path: no escape char at all → length is all visible.
  if (s.indexOf('\x1b') === -1) return s.length;
  // Accurate path: subtract total bytes consumed by SGR escapes.
  let consumed = 0;
  ANSI_SGR_GLOBAL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ANSI_SGR_GLOBAL.exec(s)) !== null) {
    consumed += m[0].length;
  }
  return s.length - consumed;
}

/**
 * Truncate a string to at most `max` visible characters.
 * ANSI escape codes within the kept portion are preserved.
 * A reset code is appended when the string is cut mid-color.
 *
 * Single-pass O(n) scan: no intermediate substring allocations even on
 * long strings with many embedded escapes.
 */
export function truncate(s: string, max: number): string {
  if (max <= 0) return '';
  if (visibleLength(s) <= max) return s;

  let visible = 0;
  let i = 0;
  let openColor = false;

  while (i < s.length) {
    if (s.charCodeAt(i) === ESC_CHAR) {
      ANSI_SGR.lastIndex = i;
      const m = ANSI_SGR.exec(s);
      if (m !== null) {
        // A bare reset (\x1b[0m or \x1b[m) closes all active colors.
        openColor = !ANSI_RESET.test(m[0]);
        i += m[0].length;
        continue;
      }
      // Non-SGR escape (e.g. \x1b[H cursor move): treat the ESC byte as
      // an opaque 1-col character and fall through. Legacy behavior
      // preserved so renders that never emit non-SGR stay unchanged.
    }
    if (visible === max) break;
    visible++;
    i++;
  }

  return openColor ? s.slice(0, i) + '\x1b[0m' : s.slice(0, i);
}
