/**
 * Regex matching any ANSI SGR escape sequence (colors, bold, reset, etc.).
 * Anchored `y` (sticky) so `exec` only matches at `lastIndex` — lets the
 * scanner walk the string without allocating substrings.
 */
const ANSI_SGR = /\x1b\[[0-9;]*m/y;

/**
 * OSC 8 hyperlink framing. Shape: `ESC ] 8 ; <params> ; <URL> ST` where
 * ST is either BEL (0x07) or `ESC \`. An empty-URL pair closes the link.
 * Recognised so visibleLength/truncate can treat the escape as zero-width
 * and still add a closing frame when truncate cuts across a live link.
 */
const ANSI_OSC8 = /\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/y;

/** Anything that is not printable ASCII — an escape, a wide char, a combining mark. */
const NON_SIMPLE = /[^\x20-\x7e]/;

/**
 * Detects an SGR sequence that fully closes any open colour state.
 *
 * - `\x1b[m` and `\x1b[0m` — bare full reset (the only forms render.ts emits today).
 * - `\x1b[0;0m` etc. — multi-zero reset variants from external producers.
 * - `\x1b[39m` / `\x1b[49m` — default foreground / background, both close the
 *   per-channel colour state.
 *
 * If a sequence we don't classify as a reset turns out to actually be one in
 * a future producer's output, the worst case is a redundant trailing
 * `\x1b[0m` from `truncate` — visually harmless. Better to over-reset than
 * leave colour leaking into whatever follows the truncated string.
 */
const ANSI_RESET = /^\x1b\[(?:0(?:;0)*|39|49)?m$/;
const OSC8_CLOSE_SEQUENCE = '\x1b]8;;\x1b\\';
const ESC_CHAR = 0x1b;

/**
 * Code points a terminal draws in two columns: East Asian Width W and F.
 *
 * Deliberately not the full Unicode table. Every range here is one the
 * standard classifies unambiguously as Wide or Fullwidth, and anything
 * omitted counts as one column — which is what the old code did for
 * everything, so an omission is never a regression. The ones present are the
 * ones that actually reach a statusline: a project directory named in CJK or
 * Korean, and emoji in a directory or model name.
 *
 * Ambiguous (EAW=A) is *not* here, and that is the load-bearing decision. It
 * covers the box-drawing, block-element, arrow and geometric-shape characters
 * this plugin draws its own bars and glyphs with — █ ░ │ → ◑ ⚠. Terminals
 * render those in one column outside a CJK locale, and counting them as two
 * would double the measured width of every bar on screen.
 */
const WIDE_RANGES: readonly [number, number][] = [
  [0x1100, 0x115f],   // Hangul Jamo initial consonants
  [0x2e80, 0x303e],   // CJK radicals, Kangxi, CJK symbols and punctuation
  [0x3041, 0x33ff],   // Hiragana, Katakana, Bopomofo, Hangul Compatibility Jamo, CJK compatibility
  [0x3400, 0x4dbf],   // CJK unified ideographs extension A
  [0x4e00, 0x9fff],   // CJK unified ideographs
  [0xa000, 0xa4cf],   // Yi
  [0xa960, 0xa97f],   // Hangul Jamo extended-A
  [0xac00, 0xd7a3],   // Hangul syllables
  [0xf900, 0xfaff],   // CJK compatibility ideographs
  [0xfe10, 0xfe19],   // Vertical forms
  [0xfe30, 0xfe6f],   // CJK compatibility forms, small form variants
  [0xff00, 0xff60],   // Fullwidth ASCII variants
  [0xffe0, 0xffe6],   // Fullwidth symbol variants
  [0x1f300, 0x1f64f], // Miscellaneous symbols and pictographs, emoticons
  [0x1f680, 0x1f6ff], // Transport and map symbols
  [0x1f900, 0x1f9ff], // Supplemental symbols and pictographs
  [0x20000, 0x3fffd], // CJK extensions B onward
];

/**
 * Code points that occupy no column of their own: they compose with, or
 * modify, the character before them. Counting a combining acute as a column
 * makes `é` written in NFD two columns wide and every following field
 * misaligned by one.
 */
const ZERO_WIDTH_RANGES: readonly [number, number][] = [
  [0x0300, 0x036f],   // Combining diacritical marks
  [0x0483, 0x0489],   // Combining Cyrillic
  [0x0591, 0x05bd],   // Hebrew points
  [0x0610, 0x061a],   // Arabic marks
  [0x064b, 0x065f],   // Arabic marks
  [0x0e31, 0x0e31], [0x0e34, 0x0e3a], [0x0e47, 0x0e4e], // Thai
  [0x1ab0, 0x1aff],   // Combining diacritical marks extended
  [0x1dc0, 0x1dff],   // Combining diacritical marks supplement
  [0x200b, 0x200f],   // Zero-width space/joiner/non-joiner, bidi marks
  [0x2028, 0x202e],   // Line/paragraph separators, bidi overrides
  [0x20d0, 0x20f0],   // Combining marks for symbols
  [0xfe00, 0xfe0f],   // Variation selectors
  [0xfe20, 0xfe2f],   // Combining half marks
  [0xfeff, 0xfeff],   // Zero-width no-break space (BOM)
  [0xe0100, 0xe01ef], // Variation selectors supplement
];

function inRanges(cp: number, ranges: readonly [number, number][]): boolean {
  for (const [lo, hi] of ranges) {
    if (cp < lo) return false; // ranges are ascending — nothing further can match
    if (cp <= hi) return true;
  }
  return false;
}

/**
 * How many terminal columns one code point occupies.
 *
 * Control characters count zero: they move the cursor or do nothing, they do
 * not draw. Anything a terminal would draw as a replacement glyph still counts
 * one, which is what it will occupy on screen.
 */
export function charWidth(cp: number): number {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0; // C0 / C1 controls
  if (cp < 0x300) return 1;                             // Latin, Greek, Cyrillic start
  if (inRanges(cp, ZERO_WIDTH_RANGES)) return 0;
  if (inRanges(cp, WIDE_RANGES)) return 2;
  return 1;
}

/**
 * Count the terminal columns a string occupies, ignoring ANSI escapes.
 *
 * Not the same as `s.length`, and the difference is the point: JavaScript
 * counts UTF-16 code units, terminals draw columns. `日本語` is three code
 * units and six columns; `é` in NFD is two code units and one column. Padding
 * or truncating on the wrong one of those puts the rest of the line in the
 * wrong place.
 */
export function visibleLength(s: string): number {
  // Fast path: printable ASCII only, where one code unit is one column and
  // there is nothing to strip. This covers essentially every render.
  if (!NON_SIMPLE.test(s)) return s.length;

  let width = 0;
  let i = 0;
  while (i < s.length) {
    if (s.charCodeAt(i) === ESC_CHAR) {
      const skipped = escapeLengthAt(s, i);
      if (skipped > 0) {
        i += skipped;
        continue;
      }
    }
    const cp = s.codePointAt(i);
    if (cp === undefined) break;
    width += charWidth(cp);
    i += cp > 0xffff ? 2 : 1;
  }
  return width;
}

/**
 * Length of the ANSI escape starting at `i`, or 0 if none starts there.
 *
 * Shared by visibleLength and truncate so the two cannot disagree about where
 * an escape ends — which is how a width calculation and the cut it feeds end
 * up measuring different strings.
 */
function escapeLengthAt(s: string, i: number): number {
  ANSI_SGR.lastIndex = i;
  const sgr = ANSI_SGR.exec(s);
  if (sgr !== null) return sgr[0].length;
  ANSI_OSC8.lastIndex = i;
  const osc = ANSI_OSC8.exec(s);
  if (osc !== null) return osc[0].length;
  return 0;
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
    /*
     * Advance by code point and by column, not by code unit.
     *
     * A lone surrogate is not a character: cutting between the halves of an
     * astral pair leaves half of one, which terminals render as U+FFFD.
     * `truncate('a👍b', 2)` used to produce `a\ud83d`.
     *
     * The comparison is `>` on the *next* character's width rather than `>=`
     * on the count so far, which does two things. A two-column character with
     * one column left is dropped instead of being written half outside the
     * budget — the case that makes a line wrap. And a fractional `max` now
     * bounds the result: `visible === max` could never be true for one, so
     * `truncate(s, 3.5)` returned the whole string, unbounded, from a function
     * whose entire contract is a bound.
     */
    const code = s.codePointAt(i);
    if (code === undefined) break;
    const w = charWidth(code);
    if (visible + w > max) break;
    /*
     * Two kinds of thing occupy no column, and the cut treats them
     * differently.
     *
     * A combining mark belongs to the character before it — cutting between
     * `e` and its acute accent changes the letter — so it stays on the kept
     * side even though the budget is already spent. A control byte belongs to
     * nothing. Keeping a trailing lone ESC would make the terminal read
     * whatever is printed next as the rest of an escape sequence, so the scan
     * stops instead.
     */
    const composes = w === 0 && code >= 0x300;
    if (visible >= max && !composes) break;
    visible += w;
    i += code > 0xffff ? 2 : 1;
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
