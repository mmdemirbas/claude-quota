import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { clamp, parseDate, parseExtraUsage } from '../src/usage.js';

describe('clamp', () => {
  test('passes through values in range', () => {
    assert.equal(clamp(0), 0);
    assert.equal(clamp(50), 50);
    assert.equal(clamp(100), 100);
  });

  test('rounds fractional values', () => {
    assert.equal(clamp(36.7), 37);
    assert.equal(clamp(36.2), 36);
  });

  test('clamps values above 100', () => {
    assert.equal(clamp(101), 100);
    assert.equal(clamp(999), 100);
  });

  test('clamps negative values to 0', () => {
    assert.equal(clamp(-1), 0);
    assert.equal(clamp(-999), 0);
  });

  test('returns null for null/undefined/NaN', () => {
    assert.equal(clamp(null), null);
    assert.equal(clamp(undefined), null);
    assert.equal(clamp(NaN), null);
  });

  test('returns null for Infinity', () => {
    assert.equal(clamp(Infinity), null);
    assert.equal(clamp(-Infinity), null);
  });
});

describe('parseDate', () => {
  test('parses ISO 8601 strings', () => {
    const d = parseDate('2025-04-04T12:00:00Z');
    assert.ok(d instanceof Date);
    assert.equal(d?.getUTCFullYear(), 2025);
  });

  test('returns null for undefined', () => {
    assert.equal(parseDate(undefined), null);
  });

  test('returns null for invalid strings', () => {
    assert.equal(parseDate('not-a-date'), null);
    assert.equal(parseDate(''), null);
  });
});

describe('parseExtraUsage', () => {
  test('returns null when extra_usage is absent', () => {
    assert.equal(parseExtraUsage(undefined), null);
  });

  test('returns disabled state when is_enabled is false', () => {
    const result = parseExtraUsage({ is_enabled: false, monthly_limit: 500, used_credits: 10 });
    assert.deepEqual(result, { enabled: false, monthlyLimit: 0, usedCredits: 0, creditGrant: null });
  });

  test('returns null when monthly_limit is 0 (avoids $0/$0 display)', () => {
    assert.equal(
      parseExtraUsage({ is_enabled: true, monthly_limit: 0, used_credits: 0 }),
      null,
    );
  });

  test('returns null when monthly_limit is absent', () => {
    assert.equal(parseExtraUsage({ is_enabled: true }), null);
  });

  test('parses enabled extra usage correctly, converting cents to dollars', () => {
    const result = parseExtraUsage({
      is_enabled: true,
      monthly_limit: 500,
      used_credits: 1250,
    });
    assert.deepEqual(result, { enabled: true, monthlyLimit: 5, usedCredits: 12.5, creditGrant: null });
  });

  test('defaults used_credits to 0 when absent', () => {
    const result = parseExtraUsage({ is_enabled: true, monthly_limit: 500 });
    assert.equal(result?.usedCredits, 0);
    assert.equal(result?.monthlyLimit, 5);
    assert.equal(result?.creditGrant, null);
  });

  // Hardening: non-numeric or negative monetary fields must not leak
  // NaN/negative values into the renderer. They'd produce "NaN%" bars or
  // a negative spend.
  test('returns null when monthly_limit is non-numeric', () => {
    const result = parseExtraUsage({
      is_enabled: true,
      monthly_limit: 'lots' as unknown as number,
    });
    assert.equal(result, null);
  });

  test('returns null when monthly_limit is negative', () => {
    const result = parseExtraUsage({
      is_enabled: true,
      monthly_limit: -500,
    });
    assert.equal(result, null);
  });

  test('returns null when monthly_limit is Infinity or NaN', () => {
    assert.equal(parseExtraUsage({ is_enabled: true, monthly_limit: Infinity }), null);
    assert.equal(parseExtraUsage({ is_enabled: true, monthly_limit: NaN }), null);
  });

  test('falls back to 0 used_credits for non-numeric values rather than returning null', () => {
    const result = parseExtraUsage({
      is_enabled: true,
      monthly_limit: 500,
      used_credits: 'bad' as unknown as number,
    });
    assert.ok(result);
    assert.equal(result.usedCredits, 0);
    assert.equal(result.monthlyLimit, 5);
  });

  test('falls back to 0 used_credits for negative values', () => {
    const result = parseExtraUsage({
      is_enabled: true,
      monthly_limit: 500,
      used_credits: -100,
    });
    assert.ok(result);
    assert.equal(result.usedCredits, 0);
  });
});
