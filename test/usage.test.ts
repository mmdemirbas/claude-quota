import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { clamp, parseDate, parseExtraUsage, rehydrateDate, recoverCacheState, acquireFetchLock, jitteredBackoff, parseRetryAfter } from '../src/usage.js';
import { writeFileSecure } from '../src/secure-fs.js';
import type { CacheFile, UsageData } from '../src/types.js';

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

// Regression: hydrateDates used to call `new Date(...)` directly; an
// old-schema or corrupted cache value (e.g. "bogus") produced Invalid Date,
// which leaked NaN/undefined into the renderer's resetIn/windowGlyph output.
describe('rehydrateDate', () => {
  test('returns null for null/undefined', () => {
    assert.equal(rehydrateDate(null), null);
    assert.equal(rehydrateDate(undefined), null);
  });

  test('parses an ISO string from a serialized cache', () => {
    const d = rehydrateDate('2026-04-04T12:00:00Z');
    assert.ok(d instanceof Date);
    assert.equal(d?.getUTCFullYear(), 2026);
  });

  test('passes through an already-Date value', () => {
    const orig = new Date('2026-04-04T12:00:00Z');
    assert.ok(rehydrateDate(orig)?.getTime() === orig.getTime());
  });

  test('returns null for a malformed date string', () => {
    assert.equal(rehydrateDate('not-a-date'), null);
    assert.equal(rehydrateDate(''), null);
  });

  test('returns null for an Invalid Date instance', () => {
    assert.equal(rehydrateDate(new Date('bogus')), null);
  });

  test('returns null for unexpected types (objects, arrays, booleans)', () => {
    assert.equal(rehydrateDate({} as unknown), null);
    assert.equal(rehydrateDate([] as unknown), null);
    assert.equal(rehydrateDate(true as unknown), null);
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
    assert.deepEqual(result, { enabled: false });
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
    assert.ok(result?.enabled);
    assert.equal(result.usedCredits, 0);
    assert.equal(result.monthlyLimit, 5);
    assert.equal(result.creditGrant, null);
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
    assert.ok(result?.enabled);
    assert.equal(result.usedCredits, 0);
    assert.equal(result.monthlyLimit, 5);
  });

  test('falls back to 0 used_credits for negative values', () => {
    const result = parseExtraUsage({
      is_enabled: true,
      monthly_limit: 500,
      used_credits: -100,
    });
    assert.ok(result?.enabled);
    assert.equal(result.usedCredits, 0);
  });

  // C2: the disabled state is now narrowly typed — no monthlyLimit/
  // usedCredits/creditGrant fields. A caller that forgot the
  // `enabled === true` narrowing used to silently divide 0/0.
  test('disabled state has no numeric fields', () => {
    const result = parseExtraUsage({ is_enabled: false });
    assert.deepEqual(result, { enabled: false });
  });
});

// Regression: a non-429 failure (HTTP 500, network, timeout) used to call
// writeCache without preserving lastGoodData / rateLimitedCount. That:
//   1) reset the exponential-backoff counter so the next 429 started over,
//   2) blanked lastGoodData so the rate-limit display had nothing to show.
// recoverCacheState now reads both fields out of the prior cache and the
// failure path passes them back into writeCache.
describe('recoverCacheState', () => {
  let dir: string;
  let cachePath: string;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-quota-cache-'));
    cachePath = path.join(dir, 'data.js');
  });
  after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
  beforeEach(() => {
    try { fs.rmSync(cachePath, { force: true }); } catch { /* ignore */ }
  });

  function writeCacheFile(c: CacheFile): void {
    writeFileSecure(cachePath, `var DATA=${JSON.stringify(c)};`);
  }

  const goodUsage: UsageData = {
    planName: 'Max',
    fiveHour: 42, fiveHourResetAt: null,
    sevenDay: 17, sevenDayResetAt: null,
    sonnet: null, sonnetResetAt: null,
    opus: null, opusResetAt: null,
    design: null, designResetAt: null,
    routines: null, routinesResetAt: null,
    extraUsage: null,
  };

  test('returns zeros when no cache exists', () => {
    assert.deepEqual(recoverCacheState(cachePath), { prevCount: 0, lastGoodData: undefined });
  });

  test('returns prior count + lastGoodData from a rate-limited cache entry', () => {
    const failure: UsageData = { ...goodUsage, fiveHour: null, sevenDay: null, apiUnavailable: true, apiError: 'rate-limited' };
    writeCacheFile({ data: failure, timestamp: Date.now(), rateLimitedCount: 3, lastGoodData: goodUsage });
    const r = recoverCacheState(cachePath);
    assert.equal(r.prevCount, 3);
    assert.equal(r.lastGoodData?.fiveHour, 42);
  });

  test('falls back to cache.data when lastGoodData is absent and the cache is healthy', () => {
    writeCacheFile({ data: goodUsage, timestamp: Date.now(), rateLimitedCount: 0 });
    const r = recoverCacheState(cachePath);
    assert.equal(r.prevCount, 0);
    assert.equal(r.lastGoodData?.fiveHour, 42);
  });

  test('does not synthesize lastGoodData from a failed cache entry', () => {
    // A pure failure cache (apiUnavailable=true, no lastGoodData) should not
    // be treated as a good baseline.
    const failure: UsageData = { ...goodUsage, fiveHour: null, sevenDay: null, apiUnavailable: true };
    writeCacheFile({ data: failure, timestamp: Date.now() });
    assert.equal(recoverCacheState(cachePath).lastGoodData, undefined);
  });

  test('returns zeros when the cache file is malformed JSON', () => {
    writeFileSecure(cachePath, 'var DATA=garbage;');
    assert.deepEqual(recoverCacheState(cachePath), { prevCount: 0, lastGoodData: undefined });
  });
});

// Multi-instance coordination: the bump-then-fetch flow used to race —
// two parents that read the cache within the same millisecond both
// fetched. The O_EXCL lock makes "is anyone fetching right now" an
// atomic question.
const isPosix = process.platform !== 'win32';
describe('acquireFetchLock', { skip: !isPosix }, () => {
  let dir: string;
  let lockPath: string;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-quota-lock-'));
    lockPath = path.join(dir, '.fetch.lock');
  });
  after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
  beforeEach(() => {
    try { fs.rmSync(lockPath, { force: true }); } catch { /* ignore */ }
  });

  test('first acquisition succeeds, second concurrent attempt is refused', () => {
    const now = Date.now();
    const a = acquireFetchLock(now, lockPath);
    assert.ok(a, 'first acquire should succeed');
    const b = acquireFetchLock(now, lockPath);
    assert.equal(b, null, 'second acquire while held must return null');
    a.release();
  });

  test('after release, the lock is acquirable again', () => {
    const now = Date.now();
    const a = acquireFetchLock(now, lockPath);
    assert.ok(a);
    a.release();
    const b = acquireFetchLock(now, lockPath);
    assert.ok(b, 'lock should be acquirable after release');
    b.release();
  });

  test('stale lock (older than coordination window) is reclaimed', () => {
    // Pre-create a stale lock by hand.
    fs.writeFileSync(lockPath, '99999', { mode: 0o600 });
    const stalePast = (Date.now() - 60_000) / 1000;
    fs.utimesSync(lockPath, stalePast, stalePast);

    const a = acquireFetchLock(Date.now(), lockPath);
    assert.ok(a, 'a stale lock should be reclaimed');
    a.release();
  });

  test('fresh lock (within coordination window) is NOT reclaimed', () => {
    // A lock created right now should NOT be reclaimable by a peer.
    fs.writeFileSync(lockPath, '99999', { mode: 0o600 });

    const peer = acquireFetchLock(Date.now(), lockPath);
    assert.equal(peer, null, 'peer must not steal a fresh lock');
    fs.unlinkSync(lockPath);
  });

  // C1: identity-checked release. Before this fix, release() did
  // unlinkSync(lockPath) without confirming the file on disk was the
  // same one we acquired. A holder delayed past FETCH_COORDINATION_MS
  // could thus delete a peer's freshly-acquired lock.
  test('release() leaves a peer-reclaimed lock alone', () => {
    const now = Date.now();
    const a = acquireFetchLock(now, lockPath);
    assert.ok(a, 'acquire should succeed');

    // Simulate a peer reclaiming after the window elapsed: replace the
    // lock content with the peer's "token" by hand. acquireFetchLock
    // would do this atomically via unlink+create; the contract we care
    // about here is that release() doesn't blow away the new content.
    fs.writeFileSync(lockPath, 'peer-token', { mode: 0o600 });

    a.release();
    assert.ok(fs.existsSync(lockPath), 'release must not unlink a lock owned by a peer');
    assert.equal(fs.readFileSync(lockPath, 'utf8'), 'peer-token',
      'peer\'s lock contents must survive release()');
    fs.unlinkSync(lockPath);
  });

  test('release() unlinks our own lock', () => {
    const a = acquireFetchLock(Date.now(), lockPath);
    assert.ok(a);
    assert.ok(fs.existsSync(lockPath));
    a.release();
    assert.ok(!fs.existsSync(lockPath), 'release on our own lock must unlink');
  });
});

describe('jitteredBackoff', () => {
  // Bounds: with ±20% jitter and base = min(60s * 2^(n-1), 10min):
  //   count=1 → base 60s, range [48s, 72s]
  //   count=2 → base 120s, range [96s, 144s]
  //   count=10 (saturated) → base 600s, range [480s, 720s]

  test('count=1 lands within ±20% of 60s', () => {
    for (const r of [0, 0.25, 0.5, 0.75, 1]) {
      const ms = jitteredBackoff(1, () => r);
      assert.ok(ms >= 48_000 && ms <= 72_000, `count=1 r=${r} → ${ms}ms outside [48s, 72s]`);
    }
  });

  test('count=2 lands within ±20% of 120s', () => {
    for (const r of [0, 0.5, 1]) {
      const ms = jitteredBackoff(2, () => r);
      assert.ok(ms >= 96_000 && ms <= 144_000, `count=2 r=${r} → ${ms}ms outside [96s, 144s]`);
    }
  });

  test('count=10 caps at 10 min ±20% (does not blow past the saturation cap)', () => {
    const ms = jitteredBackoff(10, () => 1);
    assert.ok(ms <= 720_000, `saturated upper bound exceeded: ${ms}`);
  });

  test('produces different values across calls — avoids retry lockstep', () => {
    // Pin the rng to two distinct values; result must differ.
    assert.notEqual(jitteredBackoff(1, () => 0), jitteredBackoff(1, () => 1));
  });

  test('count=1 with mid-jitter returns the deterministic base', () => {
    // r=0.5 → factor = 1 → result == base, no jitter applied.
    assert.equal(jitteredBackoff(1, () => 0.5), 60_000);
  });
});

// C3: Retry-After header parsing — RFC 7231 §7.1.3 allows either
// delta-seconds or HTTP-date. The previous code only handled integers
// and silently dropped the date form, falling back to count-derived
// jittered backoff. Now both forms produce a usable seconds value.
describe('parseRetryAfter', () => {
  // 2026-04-25T12:00:00Z — fixed reference for date-form tests.
  const NOW = Date.parse('2026-04-25T12:00:00Z');

  test('returns undefined for missing/empty values', () => {
    assert.equal(parseRetryAfter(undefined, NOW), undefined);
    assert.equal(parseRetryAfter('', NOW), undefined);
    assert.equal(parseRetryAfter('   ', NOW), undefined);
  });

  test('parses delta-seconds form', () => {
    assert.equal(parseRetryAfter('120', NOW), 120);
    assert.equal(parseRetryAfter('0', NOW), 0);
    assert.equal(parseRetryAfter(' 60 ', NOW), 60);
  });

  test('parses RFC 1123 HTTP-date form', () => {
    // 2026-04-25T12:02:00Z = 120 seconds past NOW.
    assert.equal(parseRetryAfter('Sat, 25 Apr 2026 12:02:00 GMT', NOW), 120);
  });

  test('clamps a past HTTP-date to 0', () => {
    // 2026-04-25T11:55:00Z = 5 minutes ago.
    assert.equal(parseRetryAfter('Sat, 25 Apr 2026 11:55:00 GMT', NOW), 0);
  });

  test('returns undefined for unparseable values (does not silently parse "21" out of "21 Oct...")', () => {
    // The bug we want to avoid: parseInt('21 Oct 2026...') === 21,
    // which would have meant "retry in 21 seconds" — wrong by months.
    assert.equal(parseRetryAfter('not a date or number', NOW), undefined);
    assert.equal(parseRetryAfter('21 banana', NOW), undefined);
  });
});
