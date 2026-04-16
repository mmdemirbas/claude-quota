/**
 * Regex matching any ANSI SGR escape sequence (colors, bold, reset, etc.).
 * Anchored `y` (sticky) so `exec` only matches at `lastIndex` — lets the
 * scanner walk the string without allocating substrings.
 */
const ANSI_SGR = /\x1b\[[0-9;]*m/y;
const ANSI_SGR_GLOBAL = /\x1b\[[0-9;]*m/g;

/**
 * OSC 8 hyperlink framing. Shape: `ESC ] 8 ; <params> ; <URL> ST` where
 * ST is either BEL (0x07) or `ESC \`. An empty-URL pair closes the link.
 * Recognised so visibleLength/truncate can treat the escape as zero-width
 * and still add a closing frame when truncate cuts across a live link.
 */
const ANSI_OSC8 = /\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/y;
const ANSI_OSC8_GLOBAL = /\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g;

const ANSI_RESET = /^\x1b\[0?m$/;
const OSC8_CLOSE_SEQUENCE = '\x1b]8;;\x1b\\';
const ESC_CHAR = 0x1b;

/** Count visible (non-ANSI) characters in a string. */
export function visibleLength(s: string): number {
  // Fast path: no escape char at all → length is all visible.
  if (s.indexOf('\x1b') === -1) return s.length;
  // Subtract total bytes consumed by SGR + OSC 8 escapes.
  let consumed = 0;
  ANSI_SGR_GLOBAL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ANSI_SGR_GLOBAL.exec(s)) !== null) {
    consumed += m[0].length;
  }
  ANSI_OSC8_GLOBAL.lastIndex = 0;
  while ((m = ANSI_OSC8_GLOBAL.exec(s)) !== null) {
    consumed += m[0].length;
  }
  return s.length - consumed;
}

/**
 * Truncate a string to at most `max` visible characters.
 * ANSI escape codes within the kept portion are preserved.
 * A reset is appended when the cut happens mid-color; an OSC 8 close
 * frame is appended when the cut happens inside a live hyperlink.
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
  let openLink = false;

  while (i < s.length) {
    if (s.charCodeAt(i) === ESC_CHAR) {
      ANSI_SGR.lastIndex = i;
      const sgr = ANSI_SGR.exec(s);
      if (sgr !== null) {
        openColor = !ANSI_RESET.test(sgr[0]);
        i += sgr[0].length;
        continue;
      }
      ANSI_OSC8.lastIndex = i;
      const osc = ANSI_OSC8.exec(s);
      if (osc !== null) {
        // `ESC ] 8 ; ; ST` closes the active link; anything else opens one.
        openLink = !/^\x1b\]8;[^;]*;\x07?$|^\x1b\]8;[^;]*;\x1b\\$/.test(osc[0]);
        i += osc[0].length;
        continue;
      }
      // Non-SGR, non-OSC-8 escape: treat the ESC byte as an opaque 1-col
      // character and fall through. Legacy behavior preserved so renders
      // that never emit these escapes stay unchanged.
    }
    if (visible === max) break;
    visible++;
    i++;
  }

  let out = s.slice(0, i);
  if (openLink) out += OSC8_CLOSE_SEQUENCE;
  if (openColor) out += '\x1b[0m';
  return out;
}

/**
 * Wrap `text` in an OSC 8 hyperlink pointing at `url`. In OSC 8-capable
 * terminals (iTerm2, kitty, Ghostty, VS Code, WezTerm, recent GNOME
 * Terminal, recent Windows Terminal) the text is rendered clickable.
 * Terminals that do not parse OSC 8 strip the escape bytes and show
 * just `text` — no URL leak into the visible output.
 *
 * `text` must not contain the OSC terminator characters (BEL or ESC).
 * `url` must likewise avoid BEL and ESC; it is otherwise passed verbatim
 * (callers are responsible for percent-encoding if needed).
 */
export function hyperlink(text: string, url: string): string {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}
