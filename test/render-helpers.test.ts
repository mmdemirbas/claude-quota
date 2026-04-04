import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resetIn, formatMoney } from '../src/render.js';

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
});

describe('formatMoney', () => {
  test('formats zero', () => {
    assert.equal(formatMoney(0), '$0');
  });

  test('formats sub-dollar amounts with 2 decimal places', () => {
    assert.equal(formatMoney(0.50), '$0.50');
    assert.equal(formatMoney(0.01), '$0.01');
  });

  test('formats whole dollar amounts', () => {
    assert.equal(formatMoney(12), '$12');
    assert.equal(formatMoney(500), '$500');
  });

  test('rounds amounts >= $1 to nearest dollar', () => {
    assert.equal(formatMoney(12.6), '$13');
    assert.equal(formatMoney(12.4), '$12');
  });
});
