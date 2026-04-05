import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resetIn, formatMoney, bar } from '../src/render.js';
import { visibleLength } from '../src/ansi.js';

const now = Date.now();

describe('resetIn', () => {
  test('returns empty string for null', () => {
    assert.equal(resetIn(null, now), '');
  });

  test('returns empty string when reset is in the past', () => {
    assert.equal(resetIn(new Date(now - 1000), now), '');
  });

  test('returns minutes when under 60 min', () => {
    assert.equal(resetIn(new Date(now + 23 * 60 * 1000), now), '23m');
    assert.equal(resetIn(new Date(now + 1 * 60 * 1000), now), '1m');
  });

  test('returns hours and minutes', () => {
    assert.equal(resetIn(new Date(now + 2 * 60 * 60 * 1000 + 30 * 60 * 1000), now), '2h30m');
  });

  test('omits minutes when exactly on the hour', () => {
    assert.equal(resetIn(new Date(now + 3 * 60 * 60 * 1000), now), '3h');
  });

  test('returns days and hours', () => {
    assert.equal(resetIn(new Date(now + 3 * 24 * 60 * 60 * 1000 + 2 * 60 * 60 * 1000), now), '3d2h');
  });

  test('omits hours when exactly on a day boundary', () => {
    assert.equal(resetIn(new Date(now + 2 * 24 * 60 * 60 * 1000), now), '2d');
  });

  // Reset slot is `↺${resetIn(...)}`.padEnd(6) — total visible ≤ 6 chars.
  // ↺ occupies 1 char, so resetIn must never return more than 5 chars.
  test('drops minutes when h+m format would exceed 5 chars (double-digit hours + minutes)', () => {
    // 22h49m = 6 chars — overflows slot. Expected: drop minutes → '22h' (3 chars).
    assert.equal(resetIn(new Date(now + 22 * 3_600_000 + 49 * 60_000), now), '22h');
    // 10h10m = 6 chars — overflows. Expected: '10h'.
    assert.equal(resetIn(new Date(now + 10 * 3_600_000 + 10 * 60_000), now), '10h');
  });

  test('keeps minutes when h+m format is exactly 5 chars (single-digit hours + any minutes)', () => {
    // 9h59m = 5 chars — fits. Expected: '9h59m'.
    assert.equal(resetIn(new Date(now + 9 * 3_600_000 + 59 * 60_000), now), '9h59m');
    // 10h5m = 5 chars — fits. Expected: '10h5m'.
    assert.equal(resetIn(new Date(now + 10 * 3_600_000 + 5 * 60_000), now), '10h5m');
  });

  test('drops hours when d+h format would exceed 5 chars', () => {
    // 10d15h = 6 chars — overflows. Expected: '10d'.
    assert.equal(resetIn(new Date(now + 10 * 86_400_000 + 15 * 3_600_000), now), '10d');
  });
});

describe('formatMoney', () => {
  test('formats zero', () => {
    assert.equal(formatMoney(0), '$0');
  });

  // Sub-dollar amounts must fit padStart(4) used in renderExtraUsage — max 4 chars.
  // "$.XX" format is exactly 4 chars and preserves cent-level precision.
  test('formats sub-dollar amounts as $.XX (4 chars, fits padStart(4))', () => {
    assert.equal(formatMoney(0.50), '$.50');
    assert.equal(formatMoney(0.01), '$.01');
    assert.equal(formatMoney(0.99), '$.99');
    // Verify the column-alignment invariant: result ≤ 4 chars
    for (const v of [0.01, 0.10, 0.50, 0.99]) {
      assert.ok(formatMoney(v).length <= 4, `formatMoney(${v}) exceeds 4 chars`);
    }
  });

  test('formats whole dollar amounts', () => {
    assert.equal(formatMoney(12), '$12');
    assert.equal(formatMoney(500), '$500');
    assert.equal(formatMoney(999), '$999');
  });

  test('rounds amounts >= $1 to nearest dollar', () => {
    assert.equal(formatMoney(12.6), '$13');
    assert.equal(formatMoney(12.4), '$12');
  });

  // $1000+ must also stay ≤ 4 chars when used in padStart(4) contexts
  test('formats $1000+ with k suffix to stay within 4 chars', () => {
    assert.equal(formatMoney(1000), '$1k');
    assert.equal(formatMoney(2500), '$3k');    // rounds to nearest $1k
    assert.equal(formatMoney(9999), '$10k');   // 4 chars
    // Alignment invariant
    for (const v of [1000, 1500, 9999]) {
      assert.ok(formatMoney(v).length <= 4, `formatMoney(${v}) exceeds 4 chars`);
    }
  });
});

// ── bar ───────────────────────────────────────────────────────────────────────

const BLUE = '\x1b[94m';
const RED = '\x1b[31m';
const plainColor = (_p: number) => BLUE;

describe('bar (no projected)', () => {
  test('produces correct visible length', () => {
    assert.equal(visibleLength(bar(50, 10, plainColor)), 10);
    assert.equal(visibleLength(bar(0, 10, plainColor)), 10);
    assert.equal(visibleLength(bar(100, 10, plainColor)), 10);
  });

  test('0% is all empty chars', () => {
    const b = bar(0, 10, plainColor).replace(/\x1b\[[0-9;]*m/g, '');
    assert.equal(b, '░'.repeat(10));
  });

  test('100% is all filled chars', () => {
    const b = bar(100, 10, plainColor).replace(/\x1b\[[0-9;]*m/g, '');
    assert.equal(b, '█'.repeat(10));
  });

  test('50% has 5 filled and 5 empty chars', () => {
    const b = bar(50, 10, plainColor).replace(/\x1b\[[0-9;]*m/g, '');
    assert.equal(b, '█'.repeat(5) + '░'.repeat(5));
  });
});

describe('bar (with projected)', () => {
  // projected >= 100: remaining capacity is in red (will overflow)
  test('projected=100 — empty portion is red', () => {
    const b = bar(50, 10, plainColor, 100);
    // 5 filled + 5 red empty
    assert.ok(b.includes(RED + '░'.repeat(5)), 'expected red empty chars when projected=100');
    assert.equal(visibleLength(b), 10);
  });

  test('projected=150 — empty portion is red', () => {
    const b = bar(30, 10, plainColor, 150);
    assert.ok(b.includes(RED), 'expected red when projected > 100');
    assert.equal(visibleLength(b), 10);
  });

  // projected < 100: empty portion splits at projected boundary
  // wasted chars (beyond projected) are gray ░ — same glyph, different color
  test('projected=60, current=30 — wasted chars are gray ░ beyond projected position', () => {
    // 30% filled = 3 █; projected 60% = 6 chars; wasted = chars 7-10 = 4 ░ (gray)
    const b = bar(30, 10, plainColor, 60);
    const plain = b.replace(/\x1b\[[0-9;]*m/g, '');
    assert.equal(plain.slice(0, 3), '█'.repeat(3), 'filled portion');
    assert.equal(plain.slice(3, 6), '░'.repeat(3), 'projected-path portion (dim)');
    assert.equal(plain.slice(6),    '░'.repeat(4), 'wasted portion (gray ░, same glyph)');
    assert.equal(visibleLength(b), 10);
    // No red coloring in under-pace scenario
    assert.ok(!b.includes(RED), 'no red when projected < 100');
  });

  test('projected=100 exactly fills bar — all empty chars are dim ░, no gray section', () => {
    const b = bar(50, 10, plainColor, 100);
    assert.equal(visibleLength(b), 10);
    // When projected=100 the bar tips into the ≥100 branch (red), not the wasted branch
    assert.ok(b.includes(RED), 'projected=100 triggers red empty (quota will run out)');
  });

  test('projected=0 (all quota wasted) — all empty chars are gray ░', () => {
    const b = bar(0, 10, plainColor, 0);
    const plain = b.replace(/\x1b\[[0-9;]*m/g, '');
    assert.equal(plain, '░'.repeat(10), 'all wasted when projected=0 and pct=0');
    assert.equal(visibleLength(b), 10);
  });

  test('projected=undefined — original behavior (uniform dim ░)', () => {
    const b = bar(50, 10, plainColor, undefined);
    assert.ok(!b.includes(RED));
    assert.equal(visibleLength(b), 10);
    const plain = b.replace(/\x1b\[[0-9;]*m/g, '');
    assert.equal(plain, '█'.repeat(5) + '░'.repeat(5));
  });
});
