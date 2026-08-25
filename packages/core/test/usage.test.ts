import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { clamp, parseDate, parseExtraUsage, rehydrateDate, hydrateDates, acquireFetchLock, jitteredBackoff, parseRetryAfter, isFetchLockHeld } from '../src/index.js';
import { readEntry, updateEntry, toReading } from '../src/cache.js';
import { usageCachePath } from '../src/paths.js';
import { writeFileSecure } from '../src/secure-fs.js';
import type { UsageData } from '../src/types.js';

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

// Regression: hydrateDates rehydrates *ResetAt fields after JSON deserialization
// from disk. When new quota buckets (design/routines/code) were added the helper
// silently dropped them, so cached values came back as ISO strings while the
// TypeScript type still claimed Date | null — a contract violation that would
// surface as a .getTime() call on a string in any future code path that reads them.
describe('hydrateDates', () => {
  test('rehydrates every *ResetAt field declared in UsageData', () => {
    const ts = '2026-04-26T10:00:00Z';
    const cached = JSON.parse(JSON.stringify({
      planName: 'Max 20x',
      fiveHour: 41, fiveHourResetAt: new Date(ts),
      sevenDay: 51, sevenDayResetAt: new Date(ts),
      sonnet: 6, sonnetResetAt: new Date(ts),
      opus: 12, opusResetAt: new Date(ts),
      design: 0, designResetAt: new Date(ts),
      routines: 0, routinesResetAt: new Date(ts),
      code: 0, codeResetAt: new Date(ts),
      extraUsage: null,
    })) as UsageData;

    // Sanity: round-trip stringified the Dates to strings.
    assert.equal(typeof (cached as unknown as Record<string, unknown>).fiveHourResetAt, 'string');
    assert.equal(typeof (cached as unknown as Record<string, unknown>).designResetAt, 'string');

    const out = hydrateDates(cached);

    assert.ok(out.fiveHourResetAt instanceof Date, 'fiveHourResetAt');
    assert.ok(out.sevenDayResetAt instanceof Date, 'sevenDayResetAt');
    assert.ok(out.sonnetResetAt instanceof Date, 'sonnetResetAt');
    assert.ok(out.opusResetAt instanceof Date, 'opusResetAt');
    assert.ok(out.designResetAt instanceof Date, 'designResetAt');
    assert.ok(out.routinesResetAt instanceof Date, 'routinesResetAt');
    assert.ok(out.codeResetAt instanceof Date, 'codeResetAt');
  });

  test('preserves null *ResetAt fields as null (not Invalid Date)', () => {
    const cached = {
      planName: 'Max 20x',
      fiveHour: null, fiveHourResetAt: null,
      sevenDay: null, sevenDayResetAt: null,
      sonnet: null, sonnetResetAt: null,
      opus: null, opusResetAt: null,
      design: null, designResetAt: null,
      routines: null, routinesResetAt: null,
      code: null, codeResetAt: null,
      extraUsage: null,
    } as UsageData;

    const out = hydrateDates(cached);
    assert.equal(out.designResetAt, null);
    assert.equal(out.routinesResetAt, null);
    assert.equal(out.codeResetAt, null);
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

// Regression: a non-429 failure (HTTP 500, network, timeout) must preserve
// lastGood and rateLimitedCount. Without that:
//   1) the exponential-backoff counter reset, so the next 429 started over,
//   2) lastGood was blanked, so the rate-limit display had nothing to show.
// The entry is now read-modify-written, and the failure path touches neither
// field unless it is a 429.
describe('cache entry read-modify-write', () => {
  let dir: string;
  let priorConfigDir: string | undefined;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-usage-cache-'));
    priorConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = dir;
  });
  after(() => {
    if (priorConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = priorConfigDir;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
  beforeEach(() => {
    try { fs.rmSync(usageCachePath(), { force: true }); } catch { /* ignore */ }
  });

  const goodUsage: UsageData = {
    planName: 'Max',
    fiveHour: 42, fiveHourResetAt: null,
    sevenDay: 17, sevenDayResetAt: null,
    sonnet: null, sonnetResetAt: null,
    opus: null, opusResetAt: null,
    design: null, designResetAt: null,
    routines: null, routinesResetAt: null,
    code: null, codeResetAt: null,
    extraUsage: null,
  };

  const failure: UsageData = {
    ...goodUsage, fiveHour: null, sevenDay: null,
    apiUnavailable: true, apiError: 'http-500',
  };

  function seedGood(now: number, count = 0): void {
    updateEntry(now, (e) => {
      const r = toReading(goodUsage, now);
      e.timestamp = now;
      e.reading = r;
      e.lastGood = r;
      e.backoff = { rateLimitedCount: count, retryAfterUntil: null };
    });
  }

  test('returns null when no entry exists', () => {
    assert.equal(readEntry(), null);
  });

  test('a non-429 failure leaves lastGood and the backoff counter intact', () => {
    const now = Date.now();
    seedGood(now, 3);
    updateEntry(now + 1, (e) => {
      e.timestamp = now + 1;
      e.reading = toReading(failure, now + 1);
    });
    const entry = readEntry();
    assert.equal(entry?.lastGood?.buckets.fiveHour?.utilization, 42);
    assert.equal(entry?.backoff.rateLimitedCount, 3);
    assert.equal(entry?.reading?.error, 'http-500');
  });

  test('a successful write replaces lastGood and clears the backoff', () => {
    const now = Date.now();
    seedGood(now, 5);
    seedGood(now + 1);
    const entry = readEntry();
    assert.equal(entry?.backoff.rateLimitedCount, 0);
    assert.equal(entry?.reading?.error, null);
  });

  test('unknown top-level keys survive a write by a build that does not know them', () => {
    const now = Date.now();
    seedGood(now);
    updateEntry(now, (e) => { (e as Record<string, unknown>).futureField = { keep: 1 }; });
    seedGood(now + 1);
    const entry = readEntry() as Record<string, unknown> | null;
    assert.deepEqual(entry?.futureField, { keep: 1 });
  });

  test('an unknown bucket key is carried forward rather than dropped', () => {
    const now = Date.now();
    seedGood(now);
    updateEntry(now, (e) => {
      if (e.reading) e.reading.buckets.sevenDayFutureThing = { utilization: 7, resetsAt: null };
    });
    const carried = toReading(goodUsage, now + 1, readEntry()?.reading?.buckets);
    assert.equal(carried.buckets.sevenDayFutureThing?.utilization, 7);
    assert.equal(carried.buckets.fiveHour?.utilization, 42);
  });

  test('a malformed entry file reads as absent', () => {
    writeFileSecure(usageCachePath(), 'not json at all');
    assert.equal(readEntry(), null);
  });

  test('an entry from a newer schema is ignored rather than downgraded', () => {
    writeFileSecure(usageCachePath(), JSON.stringify({
      schemaVersion: 99, timestamp: Date.now(), reading: null, lastGood: null,
      backoff: { rateLimitedCount: 0, retryAfterUntil: null },
    }));
    assert.equal(readEntry(), null);
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

  // Regression: parent-side spawn skip. The statusline parent reads
  // this before spawning a background refresh, so it can avoid forking
  // a child that would just race to fail at acquireFetchLock.
  test('isFetchLockHeld() returns true while a fresh lock exists', () => {
    const now = Date.now();
    const a = acquireFetchLock(now, lockPath);
    assert.ok(a);
    assert.equal(isFetchLockHeld(now, lockPath), true,
      'lock-held check must observe a fresh lock');
    a.release();
    assert.equal(isFetchLockHeld(now, lockPath), false,
      'lock-held check must observe absence after release');
  });

  test('isFetchLockHeld() ignores a stale lock past the coordination window', () => {
    fs.writeFileSync(lockPath, 'orphan', { mode: 0o600 });
    const stalePast = (Date.now() - 60_000) / 1000;
    fs.utimesSync(lockPath, stalePast, stalePast);
    assert.equal(isFetchLockHeld(Date.now(), lockPath), false,
      'a stale lock must not block fresh spawns');
    fs.unlinkSync(lockPath);
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
