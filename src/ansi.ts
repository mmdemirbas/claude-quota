/** Regex matching any ANSI SGR escape sequence (colors, bold, reset, etc.) */
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Count visible (non-ANSI) characters in a string. */
export function visibleLength(s: string): number {
  return s.replace(ANSI_RE, '').length;
}

/**
 * Truncate a string to at most `max` visible characters.
 * ANSI escape codes within the kept portion are preserved.
 * A reset code is appended when the string is cut mid-color.
 */
export function truncate(s: string, max: number): string {
  if (max <= 0) return '';
  if (visibleLength(s) <= max) return s;

  let visible = 0;
  let i = 0;
  let openColor = false;

  while (i < s.length) {
    // Consume any ANSI escape at this position without counting visible chars
    if (s[i] === '\x1b') {
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
      if (m) {
        i += m[0].length;
        // A bare reset (\x1b[0m or \x1b[m) closes all active colors
        openColor = !/^\x1b\[0?m$/.test(m[0]);
        continue;
      }
    }
    if (visible === max) break;
    visible++;
    i++;
  }

  const result = s.slice(0, i);
  return openColor ? result + '\x1b[0m' : result;
}
