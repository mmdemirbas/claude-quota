import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { visibleLength, truncate } from '../src/ansi.js';

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
});
