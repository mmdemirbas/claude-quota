import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getUsage, readCachedUsage, readReadings, type FetchApiFn } from '../src/index.js';
import { readingsPath, usageCachePath, usageDir } from '../src/paths.js';
import { bumpTimestamp } from '../src/cache.js';
import { appendReading, lastReadingAt } from '../src/readings.js';
import {
  CACHE_SOFT_TTL_MS,
  CACHE_TTL_MS,
  READINGS_COMPACT_BYTES,
  READINGS_RETENTION_MS,
} from '../src/constants.js';
import type { CacheEntry, Reading, UsageApiResponse } from '../src/types.js';

/**
 * Conformance tests for docs/usage-cache-protocol.md.
 *
 * These assert what the *document* promises, not what this implementation
 * happens to do. A second implementation in another language should be able to
 * read the assertions here and the document, and agree with both.
 *
 * The tests that matter most are the coordination ones. Everything else in the
 * protocol is bookkeeping around a single claim: N participants cost one API
 * call. That claim is the reason the file format exists at all, so it is worth
 * proving under contention rather than assuming it from the presence of a lock.
 */

const isPosix = process.platform !== 'win32';

describe('usage cache protocol v1', { skip: !isPosix }, () => {
  let tmpHome: string;
  let cfgDir: string;
  const saved: Record<string, string | undefined> = {};

  const ENV = ['HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_QUOTA_SILENT', 'ANTHROPIC_BASE_URL'];

  before(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-usage-protocol-'));
    cfgDir = path.join(tmpHome, '.claude');
    fs.mkdirSync(cfgDir, { recursive: true });
    for (const k of ENV) saved[k] = process.env[k];
    process.env.HOME = tmpHome;
    process.env.CLAUDE_CONFIG_DIR = cfgDir;
    process.env.CLAUDE_QUOTA_SILENT = '1';
    delete process.env.ANTHROPIC_BASE_URL;

    const credPath = path.join(cfgDir, '.credentials.json');
    fs.writeFileSync(credPath, JSON.stringify({
      claudeAiOauth: {
        accessToken: 'test-tok',
        subscriptionType: 'claude_max_20',
        rateLimitTier: 'default_claude_max_20x',
        expiresAt: Date.now() + 24 * 3600_000,
      },
    }), { mode: 0o600 });
    fs.chmodSync(credPath, 0o600);
  });

  after(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(() => {
    try { fs.rmSync(usageDir(), { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const response: UsageApiResponse = {
    five_hour: { utilization: 25, resets_at: new Date(Date.now() + 3600_000).toISOString() },
    seven_day: { utilization: 17, resets_at: new Date(Date.now() + 86_400_000).toISOString() },
  };

  /** A fetcher that counts calls and can be made to block until released. */
  function countingFetcher(gate?: Promise<void>): { fn: FetchApiFn; calls: () => number } {
    let calls = 0;
    return {
      calls: () => calls,
      fn: async () => {
        calls++;
        if (gate) await gate;
        return { data: response };
      },
    };
  }

  function entry(): CacheEntry {
    return JSON.parse(fs.readFileSync(usageCachePath(), 'utf8')) as CacheEntry;
  }

  function writeEntry(e: unknown, mode = 0o600): void {
    fs.mkdirSync(usageDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(usageCachePath(), JSON.stringify(e), { mode });
    fs.chmodSync(usageCachePath(), mode);
  }

  // ── §1 Location and permissions ──────────────────────────────────────────

  test('§1 the shared directory is created 0700 and its files 0600', async () => {
    await getUsage({ fetcher: countingFetcher().fn });
    assert.equal(fs.statSync(usageDir()).mode & 0o777, 0o700);
    assert.equal(fs.statSync(usageCachePath()).mode & 0o777, 0o600);
    assert.equal(fs.statSync(readingsPath()).mode & 0o777, 0o600);
  });

  test('§1 a world-readable entry is refused and treated as absent', async () => {
    const f = countingFetcher();
    await getUsage({ fetcher: f.fn });
    assert.equal(f.calls(), 1);

    // Another local user could read this. Refusing it means re-fetching, not
    // serving data we cannot vouch for.
    fs.chmodSync(usageCachePath(), 0o644);
    await getUsage({ fetcher: f.fn });
    assert.equal(f.calls(), 2, 'a permissive entry must not be served');
  });

  test('§1 the entry follows CLAUDE_CONFIG_DIR, so two accounts do not share one cache', async () => {
    await getUsage({ fetcher: countingFetcher().fn });
    assert.ok(fs.existsSync(path.join(cfgDir, 'usage', 'usage.json')));
    assert.ok(!fs.existsSync(path.join(os.homedir(), '.claude', 'usage', 'usage.json')) ||
      path.resolve(os.homedir()) === path.resolve(tmpHome));
  });

  // ── §2 The entry ─────────────────────────────────────────────────────────

  test('§2 the entry has exactly the documented shape', async () => {
    await getUsage({ fetcher: countingFetcher().fn });
    const e = entry();

    assert.equal(e.schemaVersion, 1);
    assert.equal(typeof e.timestamp, 'number');
    assert.deepEqual(
      Object.keys(e.backoff).sort(),
      ['rateLimitedCount', 'retryAfterUntil'],
    );

    const r = e.reading as Reading;
    assert.deepEqual(
      Object.keys(r).sort(),
      ['buckets', 'error', 'extraUsage', 'fetchedAt', 'planName'],
    );
    assert.equal(typeof r.fetchedAt, 'number');
    assert.equal(r.error, null);

    // Buckets are JSON-native: integers and ISO strings, never Date objects.
    const b = r.buckets.fiveHour;
    assert.equal(b?.utilization, 25);
    assert.equal(typeof b?.resetsAt, 'string');
    assert.ok(!Number.isNaN(Date.parse(b?.resetsAt as string)));
    assert.deepEqual(Object.keys(b as object).sort(), ['resetsAt', 'utilization']);

    // Every v1 bucket key is present, null where the API omitted it.
    for (const key of ['fiveHour', 'sevenDay', 'sevenDaySonnet', 'sevenDayOpus',
      'sevenDayDesign', 'sevenDayRoutines', 'sevenDayCode']) {
      assert.ok(key in r.buckets, `bucket key ${key} must be present`);
    }
    assert.equal(r.buckets.sevenDaySonnet, null);
  });

  test('§2 an unknown top-level key survives a write by a build that does not know it', async () => {
    await getUsage({ fetcher: countingFetcher().fn });
    const e = entry() as Record<string, unknown>;
    e.somethingNewer = { a: 1 };
    writeEntry(e);

    await getUsage({ forceRefresh: true, fetcher: countingFetcher().fn });
    assert.deepEqual((entry() as Record<string, unknown>).somethingNewer, { a: 1 });
  });

  test('§7 an entry from a newer schema is neither served nor overwritten', async () => {
    const planted = {
      schemaVersion: 99,
      timestamp: Date.now(),
      reading: { fetchedAt: Date.now(), planName: 'Max', buckets: {}, extraUsage: null, error: null },
      lastGood: null,
      backoff: { rateLimitedCount: 0, retryAfterUntil: null },
      onlyNewerBuildsKnowThis: true,
    };
    writeEntry(planted);

    // A newer file must not be served — this build cannot vouch for its meaning.
    assert.equal(readCachedUsage().data, null);

    // And must not be clobbered: an old tool left running would otherwise
    // downgrade the file for every other participant on the machine.
    const f = countingFetcher();
    await getUsage({ fetcher: f.fn });
    assert.equal(f.calls(), 0, 'a newer entry must stop this build, not restart it');
    assert.deepEqual(JSON.parse(fs.readFileSync(usageCachePath(), 'utf8')), planted);
  });

  // ── §4 The fetch lock: the claim the whole protocol exists for ───────────

  test('§4 two concurrent participants produce one API call', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const f = countingFetcher(gate);

    const both = Promise.all([getUsage({ fetcher: f.fn }), getUsage({ fetcher: f.fn })]);
    release();
    const [a, b] = await both;

    assert.equal(f.calls(), 1, 'exactly one participant may reach the API');
    const sources = [a.source, b.source].sort();
    assert.deepEqual(sources, ['fetch', 'peer']);
  });

  test('§4 five concurrent participants still produce one API call', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const f = countingFetcher(gate);

    const all = Promise.all(Array.from({ length: 5 }, () => getUsage({ fetcher: f.fn })));
    release();
    const results = await all;

    assert.equal(f.calls(), 1, 'contention must not scale the request rate');
    assert.equal(results.filter((r) => r.source === 'fetch').length, 1);
    assert.equal(results.filter((r) => r.source === 'peer').length, 4);
  });

  test('§5 a participant that does not fetch still shows real numbers', async () => {
    // Seed a reading, then expire it so both participants want a refresh.
    await getUsage({ fetcher: countingFetcher().fn });
    const e = entry();
    e.timestamp = Date.now() - CACHE_TTL_MS - 1;
    writeEntry(e);

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const f = countingFetcher(gate);

    const both = Promise.all([getUsage({ fetcher: f.fn }), getUsage({ fetcher: f.fn })]);
    release();
    const results = await both;

    assert.equal(f.calls(), 1, 'exactly one participant may reach the API');

    // The non-fetching one comes back through the *cache*, not the lock: the
    // winner bumped the timestamp before its request, so by the time the peer
    // read the entry it looked fresh. That is the bump working — it stands a
    // peer down one step earlier than the lock would, without ever claiming a
    // reading that has not arrived.
    const other = results.find((r) => r.source !== 'fetch');
    assert.ok(other, 'one participant must not fetch');
    assert.equal(other?.data?.fiveHour, 25, 'and must still show real numbers');
    assert.equal(other?.source, 'cache');
  });

  test('§4 a stale lock is reclaimed so a killed fetcher cannot wedge the cache', async () => {
    fs.mkdirSync(usageDir(), { recursive: true, mode: 0o700 });
    const lock = path.join(usageDir(), '.fetch.lock');
    fs.writeFileSync(lock, '4242.deadbeef', { mode: 0o600 });
    // Older than FETCH_COORDINATION_MS: the holder is presumed dead.
    const ancient = (Date.now() - 60_000) / 1000;
    fs.utimesSync(lock, ancient, ancient);

    const f = countingFetcher();
    const r = await getUsage({ fetcher: f.fn });
    assert.equal(f.calls(), 1, 'a stale lock must not block forever');
    assert.equal(r.source, 'fetch');
  });

  test('§4 a fresh lock blocks the fetch even with no cache to fall back on', async () => {
    fs.mkdirSync(usageDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(usageDir(), '.fetch.lock'), '4242.deadbeef', { mode: 0o600 });

    const f = countingFetcher();
    const r = await getUsage({ fetcher: f.fn });
    assert.equal(f.calls(), 0, 'yielding beats firing a duplicate request');
    assert.equal(r.source, 'peer');
    assert.equal(r.data, null);
  });

  test('§4 the lock is released after a fetch, including a failing one', async () => {
    await getUsage({ fetcher: async () => ({ data: null, error: 'network' as const }) });
    assert.ok(!fs.existsSync(path.join(usageDir(), '.fetch.lock')), 'a failed fetch must not leak the lock');

    const f = countingFetcher();
    await getUsage({ forceRefresh: true, fetcher: f.fn });
    assert.equal(f.calls(), 1);
  });

  test('§4 a fetch that throws is recorded as a failure, and the lock is released', async () => {
    // A synchronous throw out of the transport — https.request does this for a
    // token carrying a control character — used to propagate out of getUsage.
    // The statusline's own catch then wrote to stderr, leaving stdout, which
    // *is* the statusline, entirely blank: no model, no git, no quota, no
    // error. And the entry stayed bumped, standing peers down for two minutes
    // over a fetch that never happened.
    const result = await getUsage({ fetcher: async () => { throw new Error('boom'); } });

    assert.equal(result.source, 'fetch');
    assert.equal(result.data?.apiError, 'network', 'a throw is a failed fetch, not an escape');
    assert.ok(!fs.existsSync(path.join(usageDir(), '.fetch.lock')), 'and the lock is released');

    // A failure entry has the short TTL, so the next attempt is not blocked.
    const f = countingFetcher();
    await getUsage({ forceRefresh: true, fetcher: f.fn });
    assert.equal(f.calls(), 1);
  });

  // ── §5 Freshness ─────────────────────────────────────────────────────────

  test('§5 inside the soft TTL the entry is served and not flagged stale', async () => {
    const f = countingFetcher();
    await getUsage({ fetcher: f.fn });
    const r = await getUsage({ fetcher: f.fn });
    assert.equal(f.calls(), 1);
    assert.equal(r.isStale, false);
    assert.equal(r.source, 'cache');
  });

  test('§5 between soft and hard TTL the entry is served but flagged stale', async () => {
    const f = countingFetcher();
    await getUsage({ fetcher: f.fn });
    const e = entry();
    e.timestamp = Date.now() - (CACHE_SOFT_TTL_MS + CACHE_TTL_MS) / 2;
    writeEntry(e);

    const r = await getUsage({ fetcher: f.fn });
    assert.equal(f.calls(), 1, 'stale is a hint to refresh soon, not a reason to block');
    assert.equal(r.isStale, true);
    assert.equal(r.data?.fiveHour, 25);
  });

  test('§5 past the hard TTL the entry is not served', async () => {
    const f = countingFetcher();
    await getUsage({ fetcher: f.fn });
    const e = entry();
    e.timestamp = Date.now() - CACHE_TTL_MS - 1;
    writeEntry(e);

    await getUsage({ fetcher: f.fn });
    assert.equal(f.calls(), 2);
  });

  test('§5 the pre-fetch bump moves the timestamp without inventing a reading', async () => {
    await getUsage({ fetcher: countingFetcher().fn });
    const first = entry();

    const e = entry();
    e.timestamp = Date.now() - CACHE_TTL_MS - 1;
    writeEntry(e);

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const inFlight = getUsage({ fetcher: countingFetcher(gate).fn });

    // Mid-flight: the entry looks fresh so peers stand down, but the reading
    // is still the previous measurement — nobody is shown a number that has
    // not been taken.
    const during = entry();
    assert.ok(during.timestamp > e.timestamp, 'timestamp bumped');
    assert.equal(during.reading?.fetchedAt, first.reading?.fetchedAt, 'reading untouched');

    release();
    await inFlight;
  });

  test('§5 a 429 escalates the backoff and serves last-good without re-fetching', async () => {
    const good = countingFetcher();
    await getUsage({ fetcher: good.fn });

    const rl = countingFetcher();
    const limited: FetchApiFn = async () => {
      rl.fn('x');
      return { data: null, error: 'rate-limited' as const, retryAfterSec: 60 };
    };
    const first = await getUsage({ forceRefresh: true, fetcher: limited });
    assert.equal(first.data?.apiError, 'rate-limited');
    assert.equal(first.data?.fiveHour, 25, 'a 429 must not blank real numbers');
    assert.equal(entry().backoff.rateLimitedCount, 1);
    assert.ok((entry().backoff.retryAfterUntil ?? 0) > Date.now());

    const during = countingFetcher();
    const held = await getUsage({ fetcher: during.fn });
    assert.equal(during.calls(), 0, 'inside backoff nobody may retry');
    assert.equal(held.source, 'backoff');
    assert.equal(held.data?.fiveHour, 25);
  });

  test('§5 backoff derived from the count is used when the server sends no Retry-After', async () => {
    await getUsage({ fetcher: countingFetcher().fn });
    await getUsage({
      forceRefresh: true,
      fetcher: async () => ({ data: null, error: 'rate-limited' as const }),
    });
    const until = entry().backoff.retryAfterUntil;
    assert.ok(until !== null && until > Date.now(), 'a jittered backoff must still be set');
  });

  test('§5 a non-429 failure has a short TTL and keeps the backoff counter', async () => {
    await getUsage({ fetcher: countingFetcher().fn });
    await getUsage({
      forceRefresh: true,
      fetcher: async () => ({ data: null, error: 'rate-limited' as const }),
    });
    const escalated = entry().backoff.rateLimitedCount;

    await getUsage({
      forceRefresh: true,
      fetcher: async () => ({ data: null, error: 'http-500' as const }),
    });
    assert.equal(entry().backoff.rateLimitedCount, escalated, 'a 500 must not reset the escalation');
    assert.equal(entry().lastGood?.buckets.fiveHour?.utilization, 25, 'nor blank last-good');
  });

  // ── §3 The readings log ──────────────────────────────────────────────────

  test('§3 only successes are logged, and only once each', async () => {
    await getUsage({ fetcher: countingFetcher().fn });
    assert.equal(readReadings().length, 1);

    // A second cache-hit call adds nothing: no new measurement was taken.
    await getUsage({ fetcher: countingFetcher().fn });
    assert.equal(readReadings().length, 1);

    await getUsage({
      forceRefresh: true,
      fetcher: async () => ({ data: null, error: 'timeout' as const }),
    });
    assert.equal(readReadings().length, 1, 'a failure is not a measurement');
  });

  test('§3 readings are ordered and a non-advancing fetchedAt is refused', async () => {
    await getUsage({ fetcher: countingFetcher().fn });
    const [first] = readReadings();
    assert.ok(first);

    assert.equal(appendReading({ ...first, fetchedAt: first.fetchedAt - 1 }), false);
    assert.equal(appendReading({ ...first }), false, 'the same instant is not a new reading');
    assert.equal(appendReading({ ...first, fetchedAt: first.fetchedAt + 1 }), true);

    const all = readReadings();
    assert.equal(all.length, 2);
    assert.ok((all[1]?.fetchedAt ?? 0) > (all[0]?.fetchedAt ?? 0));
  });

  test('§3 a torn final line costs only itself', async () => {
    await getUsage({ fetcher: countingFetcher().fn });
    fs.appendFileSync(readingsPath(), '{"fetchedAt":123,"buck');
    assert.equal(readReadings().length, 1);
  });

  test('§3 sinceMs filters without reordering', async () => {
    await getUsage({ fetcher: countingFetcher().fn });
    const [first] = readReadings();
    assert.ok(first);
    appendReading({ ...first, fetchedAt: first.fetchedAt + 10_000 });

    assert.equal(readReadings(first.fetchedAt + 1).length, 1);
    assert.equal(readReadings(0).length, 2);
  });

  test('§3.1 compaction keeps the retention window and drops what is past it', async () => {
    await getUsage({ fetcher: countingFetcher().fn });
    const [seed] = readReadings();
    assert.ok(seed);

    // Write a log that is both over the size threshold and mostly ancient.
    const now = Date.now();
    const old = { ...seed, fetchedAt: now - READINGS_RETENTION_MS - 60_000 };
    // Derive the count from the real line width rather than guessing it — a
    // guess that falls short makes this test silently assert nothing.
    const perLine = JSON.stringify(old).length + 1;
    const count = Math.ceil((READINGS_COMPACT_BYTES / perLine) * 1.1);
    const lines: string[] = [];
    for (let i = 0; i < count; i++) lines.push(JSON.stringify({ ...old, fetchedAt: old.fetchedAt + i }));
    lines.push(JSON.stringify({ ...seed, fetchedAt: now - 1000 }));
    fs.writeFileSync(readingsPath(), lines.join('\n') + '\n', { mode: 0o600 });
    assert.ok(fs.statSync(readingsPath()).size > READINGS_COMPACT_BYTES, 'test needs an oversized log');

    // Appending is what triggers compaction, under the lock.
    appendReading({ ...seed, fetchedAt: now });

    const kept = readReadings();
    assert.ok(kept.length < count, 'ancient readings must be dropped');
    assert.ok(kept.every((r) => r.fetchedAt >= now - READINGS_RETENTION_MS));
    assert.equal(kept.at(-1)?.fetchedAt, now, 'the newest reading survives compaction');
  });

  test('§3.1 compaction ends under the cap even when the retention window does not fit', () => {
    // The failure this pins. At the highest sustainable fetch rate, thirty days
    // of readings is larger than the size cap. An age-only compaction removes
    // nothing, leaves the file over the threshold, and runs again on the next
    // append — rewriting megabytes every couple of minutes, forever.
    const now = Date.now();
    const seed: Reading = {
      fetchedAt: now,
      planName: 'Max 20x',
      buckets: { fiveHour: { utilization: 5, resetsAt: new Date(now).toISOString() } },
      extraUsage: null,
      error: null,
    };

    // Every reading is *inside* the retention window, so age drops none of them.
    const perLine = JSON.stringify(seed).length + 1;
    const count = Math.ceil((READINGS_COMPACT_BYTES / perLine) * 1.4);
    const lines: string[] = [];
    for (let i = 0; i < count; i++) {
      lines.push(JSON.stringify({ ...seed, fetchedAt: now - (count - i) * 1000 }));
    }
    fs.mkdirSync(usageDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(readingsPath(), lines.join('\n') + '\n', { mode: 0o600 });
    fs.chmodSync(readingsPath(), 0o600);
    assert.ok(fs.statSync(readingsPath()).size > READINGS_COMPACT_BYTES);

    assert.equal(appendReading({ ...seed, fetchedAt: now }), true);

    const after = fs.statSync(readingsPath()).size;
    assert.ok(after <= READINGS_COMPACT_BYTES, `compaction must get under the cap, got ${after}`);
    assert.equal(readReadings().at(-1)?.fetchedAt, now, 'the newest reading survives');

    // And the next append must not re-trigger a rewrite: if it did, the file
    // would be back over the cap and we would be in the same loop.
    const sizeBefore = fs.statSync(readingsPath()).size;
    appendReading({ ...seed, fetchedAt: now + 1000 });
    const sizeAfter = fs.statSync(readingsPath()).size;
    assert.ok(
      sizeAfter > sizeBefore && sizeAfter <= READINGS_COMPACT_BYTES,
      'a following append should just append, not compact again',
    );
  });

  test('lastReadingAt reads the tail and agrees with a full parse', () => {
    const now = Date.now();
    const seed: Reading = {
      fetchedAt: now, planName: 'Max 20x',
      buckets: { fiveHour: { utilization: 5, resetsAt: null } },
      extraUsage: null, error: null,
    };
    fs.mkdirSync(usageDir(), { recursive: true, mode: 0o700 });

    // Empty, one line, and a file far larger than the tail window.
    fs.writeFileSync(readingsPath(), '', { mode: 0o600 });
    fs.chmodSync(readingsPath(), 0o600);
    assert.equal(lastReadingAt(), null, 'an empty log has no last reading');

    fs.writeFileSync(readingsPath(), JSON.stringify(seed) + '\n', { mode: 0o600 });
    assert.equal(lastReadingAt(), now);

    const many: string[] = [];
    for (let i = 0; i < 2000; i++) many.push(JSON.stringify({ ...seed, fetchedAt: now - (2000 - i) }));
    fs.writeFileSync(readingsPath(), many.join('\n') + '\n', { mode: 0o600 });
    assert.ok(fs.statSync(readingsPath()).size > 64 * 1024, 'test needs a log past the tail window');
    assert.equal(lastReadingAt(), readReadings().at(-1)?.fetchedAt);
  });

  test('lastReadingAt walks back past a torn final line', () => {
    const now = Date.now();
    const seed: Reading = {
      fetchedAt: now, planName: 'Max 20x',
      buckets: { fiveHour: { utilization: 5, resetsAt: null } },
      extraUsage: null, error: null,
    };
    fs.mkdirSync(usageDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(readingsPath(), JSON.stringify(seed) + '\n', { mode: 0o600 });
    fs.chmodSync(readingsPath(), 0o600);
    fs.appendFileSync(readingsPath(), '{"fetchedAt":99999999,"buck');

    assert.equal(lastReadingAt(), now, 'a half-written record must not be taken as the newest');
  });

  // ── fetchedAt means "when it was measured" ───────────────────────────────

  test('a served reading carries the instant it was measured, not the instant the cache was touched', async () => {
    const f = countingFetcher();
    await getUsage({ fetcher: f.fn });
    const measuredAt = entry().reading?.fetchedAt;
    assert.ok(measuredAt);

    // A bump marks the entry fresh without a new measurement. Anything served
    // afterwards is still the *old* measurement and must say so.
    const later = Date.now() + 5_000;
    bumpTimestamp(later);
    assert.equal(entry().timestamp, later, 'the bump moved the entry timestamp');

    const served = readCachedUsage();
    assert.equal(
      served.data?.fetchedAt,
      measuredAt,
      'fetchedAt must be the measurement time, not the bump time',
    );
  });

  test('a reading served during a peer\'s in-flight fetch does not collide with the reading that lands', async () => {
    // The bug this pins. The fetcher stamps its reading with the same instant
    // it used to bump the entry beforehand. A reader arriving mid-flight was
    // handed the *previous* values wearing the *incoming* reading's timestamp.
    // Downstream, where fetchedAt is a primary key, the real measurement then
    // lost a primary-key conflict against the stale copy of it.
    const first = countingFetcher();
    await getUsage({ fetcher: first.fn });
    const firstReading = entry().reading;
    assert.ok(firstReading);

    // Force the next call past the hard TTL so it fetches.
    const e = entry();
    e.timestamp = Date.now() - CACHE_TTL_MS - 1;
    writeEntry(e);

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const inFlight = getUsage({ fetcher: countingFetcher(gate).fn });

    // Mid-flight read: old values, and they must carry the old measurement time.
    const during = readCachedUsage();
    assert.equal(during.data?.fiveHour, 25);
    assert.equal(
      during.data?.fetchedAt,
      firstReading.fetchedAt,
      'a mid-flight read must not borrow the incoming reading\'s timestamp',
    );

    release();
    await inFlight;

    const landed = entry().reading;
    assert.ok(landed);
    assert.notEqual(
      landed.fetchedAt,
      during.data?.fetchedAt,
      'the reading that landed must be distinguishable from the one served during the flight',
    );
  });

  test('a rate-limited display carries the last good measurement\'s time, not the failure\'s', async () => {
    await getUsage({ fetcher: countingFetcher().fn });
    const goodAt = entry().reading?.fetchedAt;
    assert.ok(goodAt);

    await getUsage({
      forceRefresh: true,
      fetcher: async () => ({ data: null, error: 'rate-limited' as const, retryAfterSec: 60 }),
    });

    const held = readCachedUsage();
    assert.equal(held.data?.apiError, 'rate-limited');
    assert.equal(held.data?.fiveHour, 25, 'real numbers are still shown');
    assert.equal(
      held.data?.fetchedAt,
      goodAt,
      'and they are stamped with when they were measured, not when the 429 arrived',
    );
  });

  // ── §6 Credentials ───────────────────────────────────────────────────────

  test('§6 no credentials means no fetch and no error state', async () => {
    const credPath = path.join(cfgDir, '.credentials.json');
    const backup = fs.readFileSync(credPath, 'utf8');
    fs.rmSync(credPath);
    try {
      const f = countingFetcher();
      const r = await getUsage({ fetcher: f.fn });
      assert.equal(f.calls(), 0);
      assert.equal(r.data, null);
      assert.equal(r.source, 'none');
      assert.ok(!fs.existsSync(usageCachePath()), 'nothing to record, so nothing is written');
    } finally {
      fs.writeFileSync(credPath, backup, { mode: 0o600 });
      fs.chmodSync(credPath, 0o600);
    }
  });

  test('§6 an expired credential is treated as absent', async () => {
    const credPath = path.join(cfgDir, '.credentials.json');
    const backup = fs.readFileSync(credPath, 'utf8');
    fs.writeFileSync(credPath, JSON.stringify({
      claudeAiOauth: { accessToken: 't', subscriptionType: 'claude_max_20', expiresAt: Date.now() - 1 },
    }), { mode: 0o600 });
    fs.chmodSync(credPath, 0o600);
    try {
      const f = countingFetcher();
      assert.equal((await getUsage({ fetcher: f.fn })).data, null);
      assert.equal(f.calls(), 0);
    } finally {
      fs.writeFileSync(credPath, backup, { mode: 0o600 });
      fs.chmodSync(credPath, 0o600);
    }
  });

  // ── readCachedUsage: the read-only door ──────────────────────────────────

  test('readCachedUsage never fetches, never writes, never creates the directory', async () => {
    const before = fs.existsSync(usageDir());
    const r = readCachedUsage();
    assert.equal(r.data, null);
    assert.equal(r.source, 'none');
    assert.equal(fs.existsSync(usageDir()), before, 'a read must not have side effects');

    await getUsage({ fetcher: countingFetcher().fn });
    const mtime = fs.statSync(usageCachePath()).mtimeMs;
    const hit = readCachedUsage();
    assert.equal(hit.data?.fiveHour, 25);
    assert.equal(fs.statSync(usageCachePath()).mtimeMs, mtime, 'a read must not rewrite the entry');
  });
});
