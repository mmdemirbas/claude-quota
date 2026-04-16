import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { visibleLength, truncate, hyperlink } from '../src/ansi.js';

// ── visibleLength ─────────────────────────────────────────────────────────────

describe('visibleLength', () => {
  test('empty string', () => {
    assert.equal(visibleLength(''), 0);
  });

  test('plain string with no ANSI', () => {
    assert.equal(visibleLength('hello'), 5);
  });

  test('strips surrounding color codes', () => {
    assert.equal(visibleLength('\x1b[31mhello\x1b[0m'), 5);
  });

  test('strips multiple interleaved ANSI codes', () => {
    // dim-space + colored-block + reset + colored-block + reset = 3 visible chars
    assert.equal(visibleLength('\x1b[2m █\x1b[0m\x1b[31m█\x1b[0m'), 3);
  });

  test('only ANSI codes, no visible chars', () => {
    assert.equal(visibleLength('\x1b[31m\x1b[0m'), 0);
  });

  test('counts Unicode bar/arrow chars as 1 each', () => {
    assert.equal(visibleLength('████░░░░░░'), 10);
    assert.equal(visibleLength('↘↗→↺⟳│'), 6);
  });

  test('strips multi-parameter SGR codes like bold+red \\x1b[1;31m', () => {
    assert.equal(visibleLength('\x1b[1;31mhello\x1b[0m'), 5);
  });

  test('strips bare reset \\x1b[m (no parameter variant)', () => {
    assert.equal(visibleLength('\x1b[31mhi\x1b[m'), 2);
  });
});

// ── truncate ──────────────────────────────────────────────────────────────────

describe('truncate', () => {
  test('returns empty string for max 0', () => {
    assert.equal(truncate('hello', 0), '');
  });

  test('returns string unchanged when it fits within max', () => {
    assert.equal(truncate('hello', 10), 'hello');
    assert.equal(truncate('hello', 5), 'hello');
  });

  test('truncates a plain string', () => {
    assert.equal(truncate('hello world', 5), 'hello');
  });

  test('preserves ANSI codes within kept portion and appends reset', () => {
    assert.equal(truncate('\x1b[31mhello\x1b[0m', 3), '\x1b[31mhel\x1b[0m');
  });

  test('does not append reset when color was closed before cut point', () => {
    // Color closes at position 3; cut at position 6 → no extra reset needed
    assert.equal(truncate('\x1b[31mhel\x1b[0mworld', 6), '\x1b[31mhel\x1b[0mwor');
  });

  test('includes a reset that falls exactly at the cut boundary', () => {
    // visibleLength('\x1b[31mhello\x1b[0m') = 5; cutting at 5 returns original
    assert.equal(truncate('\x1b[31mhello\x1b[0m', 5), '\x1b[31mhello\x1b[0m');
  });

  test('works with Unicode bar characters', () => {
    const colored = '\x1b[94m████\x1b[2m░░░░░░\x1b[0m';
    assert.equal(visibleLength(colored), 10);
    const cut = truncate(colored, 4);
    // Visible portion is "████", ANSI reset appended
    assert.equal(visibleLength(cut), 4);
    assert.ok(cut.includes('████'));
    assert.ok(cut.endsWith('\x1b[0m'));
  });

  test('empty string is returned unchanged', () => {
    assert.equal(truncate('', 5), '');
  });

  test('returns empty string for negative max', () => {
    assert.equal(truncate('hello', -1), '');
    assert.equal(truncate('hello', -100), '');
  });

  test('handles multi-parameter SGR code within kept portion', () => {
    // \x1b[1;31m is bold+red (2 visible chars: 'hi'), then reset
    const s = '\x1b[1;31mhello\x1b[0m';
    const cut = truncate(s, 3);
    assert.equal(visibleLength(cut), 3);
    assert.ok(cut.endsWith('\x1b[0m'), 'reset should be appended after cut mid-color');
  });

  test('bare reset \\x1b[m correctly closes color tracking', () => {
    // Color closed by bare reset before cut point → no extra reset needed
    const s = '\x1b[31mhel\x1b[mworld';
    const cut = truncate(s, 6);
    assert.equal(cut, '\x1b[31mhel\x1b[mwor');
    assert.equal(visibleLength(cut), 6);
  });

  // Hostile / unusual inputs that previous versions scanned via repeated
  // s.slice(i) — performance and correctness regressions to guard.

  test('non-SGR escape (\\x1b[H cursor-home) is counted as one visible byte', () => {
    // We only emit SGR; a non-SGR escape hitting truncate means the
    // input was already unusual. Pin current behavior: the ESC byte is
    // treated as a 1-col character, the subsequent bytes render normally.
    const s = '\x1b[Hhello';
    // The ESC byte counts as 1, then the '[', 'H', 'h', 'e', 'l', 'l', 'o'
    // each as 1 → 8 visible chars.
    assert.equal(visibleLength(s), 8);
    assert.equal(truncate(s, 2), s.slice(0, 2));
  });

  test('stray lone \\x1b at end of string does not crash', () => {
    assert.equal(visibleLength('hi\x1b'), 3);
    assert.equal(truncate('hi\x1b', 2), 'hi');
  });

  test('incomplete SGR sequence at cut boundary', () => {
    // '\x1b[3' with no terminating 'm' is not valid SGR. The ESC counts
    // as 1 visible byte; cutting at 2 keeps '\x1b[' and drops '3'.
    const s = '\x1b[3';
    assert.equal(visibleLength(s), 3);
    assert.equal(truncate(s, 2), '\x1b[');
  });

  test('handles a long chain of colored segments without O(n²) blow-up', () => {
    // 2000 consecutive "\x1b[31mx\x1b[0m" segments. If truncate re-slices
    // the string on every step this test would push into seconds; the
    // sticky-regex path runs in milliseconds.
    const seg = '\x1b[31mx\x1b[0m';
    const s = seg.repeat(2000);
    assert.equal(visibleLength(s), 2000);

    const t0 = Date.now();
    const cut = truncate(s, 100);
    const elapsed = Date.now() - t0;

    assert.equal(visibleLength(cut), 100);
    assert.ok(elapsed < 250,
      `truncate on 2000 segments took ${elapsed}ms; sticky-regex scan should finish well under 250ms`);
  });

  test('fits-in-max fast path returns the original string object', () => {
    const s = 'hello';
    assert.equal(truncate(s, 10), s);
  });

  test('visibleLength fast path: string with no \\x1b returns raw length', () => {
    assert.equal(visibleLength('just plain text'), 15);
  });
});

// ── OSC 8 hyperlinks ─────────────────────────────────────────────────────────

describe('hyperlink', () => {
  test('wraps text in the ST-terminated OSC 8 frame', () => {
    const link = hyperlink('web', 'file:///tmp/x.html');
    assert.equal(link, '\x1b]8;;file:///tmp/x.html\x1b\\web\x1b]8;;\x1b\\');
  });

  test('visibleLength treats the link as equal to the visible text', () => {
    const link = hyperlink('⧉ web', 'file:///tmp/x.html');
    assert.equal(visibleLength(link), 5);
  });

  test('visibleLength works for SGR colours layered inside a hyperlink', () => {
    const link = hyperlink('\x1b[31mred\x1b[0m', 'file:///tmp/x.html');
    assert.equal(visibleLength(link), 3);
  });

  test('truncate preserves a hyperlink fully inside the cut boundary', () => {
    const line = `prefix ${hyperlink('web', 'file:///x.html')} suffix`;
    // visible = 'prefix web suffix' = 17
    assert.equal(visibleLength(line), 17);
    const cut = truncate(line, 10);
    assert.equal(visibleLength(cut), 10);
    // Keeps the full link (ends with the close frame) and leaves the
    // trailing " s" partially cut.
    assert.ok(cut.includes('\x1b]8;;file:///x.html\x1b\\web\x1b]8;;\x1b\\'));
  });

  test('truncate closes a live hyperlink if the cut lands inside it', () => {
    const line = 'AAA' + hyperlink('web-link', 'file:///x.html') + 'BBB';
    // visible = 'AAAweb-linkBBB' = 14
    const cut = truncate(line, 5); // keep 'AAAwe' (3 + 2 inside link)
    assert.equal(visibleLength(cut), 5);
    // Must contain the OSC 8 close frame so the terminal doesn't stay
    // in link mode for whatever content we emit next.
    assert.ok(cut.endsWith('\x1b]8;;\x1b\\'),
      `cut must terminate the open link; got: ${JSON.stringify(cut)}`);
  });

  test('truncate does not add a redundant close when the link closed naturally', () => {
    // Link fully inside cut; cut point is past the close frame → no
    // second close should be appended.
    const line = hyperlink('ab', 'file:///x.html') + 'CDEFG';
    const cut = truncate(line, 3); // 'ab' (linked) + 'C'
    const closeCount = (cut.match(/\x1b\]8;;\x1b\\/g) ?? []).length;
    assert.equal(closeCount, 1, 'exactly one close frame expected');
  });

  test('truncate still closes open colour when cut lands inside both', () => {
    // Colour + link open together; cut must append both close sequences.
    const line = '\x1b[31m' + hyperlink('linked', 'file:///x.html');
    const cut = truncate(line, 3); // 'lin'
    assert.ok(cut.endsWith('\x1b]8;;\x1b\\\x1b[0m') || cut.endsWith('\x1b[0m\x1b]8;;\x1b\\') || cut.includes('\x1b]8;;\x1b\\'));
    assert.ok(cut.includes('\x1b[0m'), 'colour reset must be present');
  });

  test('visibleLength strips OSC 8 terminated with BEL as well as ST', () => {
    // Some terminals emit OSC 8 with a BEL (0x07) terminator instead of ST.
    const withBel = '\x1b]8;;file:///x.html\x07web\x1b]8;;\x07';
    assert.equal(visibleLength(withBel), 3);
  });
});
