import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getUsage, readReadings, type FetchApiFn } from '../src/index.js';
import { usageCachePath, usageDir, readingsPath, legacyCachePath } from '../src/paths.js';
import type { CacheEntry, UsageApiResponse } from '../src/types.js';

// POSIX-only: we redirect HOME and CLAUDE_CONFIG_DIR to a tmp dir so the
// shared usage directory resolves under our control. Windows uses USERPROFILE
// the same way, but the 0o600 enforcement in secure-fs is POSIX-only.
const isPosix = process.platform !== 'win32';

describe('getUsage orchestration', { skip: !isPosix }, () => {
  let tmpHome: string;
  let cfgDir: string;
  let prevHome: string | undefined;
  let prevCfg: string | undefined;
  let prevSilent: string | undefined;
  let prevBase: string | undefined;
  let prevApiBase: string | undefined;

  before(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-quota-getUsage-'));
    cfgDir = path.join(tmpHome, '.claude');
    fs.mkdirSync(cfgDir, { recursive: true });

    prevHome = process.env.HOME;
    prevCfg = process.env.CLAUDE_CONFIG_DIR;
    prevSilent = process.env.CLAUDE_QUOTA_SILENT;
    prevBase = process.env.ANTHROPIC_BASE_URL;
    prevApiBase = process.env.ANTHROPIC_API_BASE_URL;
    process.env.HOME = tmpHome;
    process.env.CLAUDE_CONFIG_DIR = cfgDir;
    process.env.CLAUDE_QUOTA_SILENT = '1';
    // ANTHROPIC_BASE_URL may be set by the user's environment to a local
    // proxy. getUsage short-circuits to `none` for any non-api.anthropic.com
    // origin — clear both vars for the test scope.
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_API_BASE_URL;

    // Plant a credentials file. Using a custom CLAUDE_CONFIG_DIR makes
    // readFromKeychain compute a hashed service name that won't exist,
    // so the file path is consulted.
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
    const restore = (name: string, prev: string | undefined): void => {
      if (prev === undefined) delete process.env[name]; else process.env[name] = prev;
    };
    restore('HOME', prevHome);
    restore('CLAUDE_CONFIG_DIR', prevCfg);
    restore('CLAUDE_QUOTA_SILENT', prevSilent);
    restore('ANTHROPIC_BASE_URL', prevBase);
    restore('ANTHROPIC_API_BASE_URL', prevApiBase);
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(() => {
    // Wipe the whole shared directory plus any legacy cache, so each test
    // starts cold and no migration fires except where a test plants one.
    try { fs.rmSync(usageDir(), { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(path.dirname(legacyCachePath()), { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function readEntryFile(): CacheEntry {
    return JSON.parse(fs.readFileSync(usageCachePath(), 'utf8')) as CacheEntry;
  }

  function makeFetcher(response: { data: UsageApiResponse | null; error?: 'rate-limited' | 'network' | 'timeout' | 'parse' | `http-${number}`; retryAfterSec?: number }, calls?: { count: number }): FetchApiFn {
    return async (_token: string) => {
      if (calls) calls.count++;
      return response;
    };
  }

  const goodResponse: UsageApiResponse = {
    five_hour: { utilization: 25, resets_at: new Date(Date.now() + 3600_000).toISOString() },
    seven_day: { utilization: 17, resets_at: new Date(Date.now() + 86400_000).toISOString() },
  };

  // ── Cache-hit path ────────────────────────────────────────────────────────

  test('cache hit returns cached value without invoking the fetcher', async () => {
    const calls = { count: 0 };
    const fetcher = makeFetcher({ data: goodResponse }, calls);

    // Cold call writes the cache.
    const first = await getUsage({ fetcher });
    assert.equal(calls.count, 1);
    assert.equal(first.data?.fiveHour, 25);

    // Second call within hard TTL must serve cache, no second fetch.
    const second = await getUsage({ fetcher });
    assert.equal(calls.count, 1, 'cached response must not re-invoke the fetcher');
    assert.equal(second.data?.fiveHour, 25);
  });

  // ── Lock contention path ──────────────────────────────────────────────────

  test('peer holding the fetch lock yields without firing a duplicate fetch', async () => {
    // Plant a fresh peer-held lock.
    fs.mkdirSync(usageDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(usageDir(), '.fetch.lock'), '99999', { mode: 0o600 });

    const calls = { count: 0 };
    const fetcher = makeFetcher({ data: goodResponse }, calls);
    const result = await getUsage({ fetcher });

    assert.equal(calls.count, 0, 'must not fetch while peer holds the lock');
    // No cache exists either → returns none.
    assert.equal(result.data, null);
  });

  // ── 429 backoff path ──────────────────────────────────────────────────────

  test('429 stores backoff state; subsequent call within backoff returns last-good without re-fetching', async () => {
    const calls = { count: 0 };

    // Step 1: a successful fetch lands the cache (acts as last-good baseline).
    await getUsage({ fetcher: makeFetcher({ data: goodResponse }, calls) });
    assert.equal(calls.count, 1);

    // Step 2: a 429. Force re-fetch to bypass the cache TTL.
    const rl = await getUsage({ forceRefresh: true, fetcher: makeFetcher({ data: null, error: 'rate-limited', retryAfterSec: 60 }, calls) });
    assert.equal(calls.count, 2);
    assert.equal(rl.data?.apiError, 'rate-limited');
    assert.equal(rl.data?.fiveHour, 25, 'rate-limited display must show last-good values');

    // Step 3: another call inside the backoff window — must NOT fetch.
    const within = await getUsage({ fetcher: makeFetcher({ data: goodResponse }, calls) });
    assert.equal(calls.count, 2, 'inside backoff window the fetcher must not fire');
    assert.equal(within.data?.apiError, 'rate-limited');
  });

  // ── Non-429 failure preserves rate-limit state ────────────────────────────

  test('500 between two 429s preserves the backoff counter and last-good snapshot', async () => {
    const calls = { count: 0 };

    // Bootstrap with a successful fetch.
    await getUsage({ fetcher: makeFetcher({ data: goodResponse }, calls) });
    // First 429 → counter = 1, lastGoodData captured.
    await getUsage({ forceRefresh: true, fetcher: makeFetcher({ data: null, error: 'rate-limited' }, calls) });
    // Intervening 500 — must NOT wipe counter/lastGoodData.
    await getUsage({ forceRefresh: true, fetcher: makeFetcher({ data: null, error: 'http-500' }, calls) });
    // Second 429 — backoff counter should now be 2 (escalated, not reset to 1).
    await getUsage({ forceRefresh: true, fetcher: makeFetcher({ data: null, error: 'rate-limited' }, calls) });

    const entry = readEntryFile();
    assert.equal(entry.backoff.rateLimitedCount, 2, 'counter must escalate across the 500');
    assert.ok(entry.lastGood, 'lastGood must survive the 500');
    assert.equal(entry.lastGood?.buckets.fiveHour?.utilization, 25);
  });

  // ── Retry-After upper bound ───────────────────────────────────────────────
  //
  // A tampered cache (any same-user process can write data.js) — or a
  // server returning a pathological Retry-After — could plant a
  // retryAfterUntil far in the future and silence the plugin until the
  // file is manually deleted. The read-site cap (RETRY_AFTER_MAX_MS = 24h)
  // is the safety valve.
  test('cached retryAfterUntil is capped so a corrupt value cannot silence the plugin forever', async () => {
    const calls = { count: 0 };

    // Plant a cache that *claims* to be rate-limited until 99 years from
    // now, but whose timestamp is 25 hours in the past. With the cap, the
    // effective retryUntil is timestamp + 24h, which is already past — so
    // the read should fall through and the next getUsage must fetch.
    const ancient = Date.now() - 25 * 3600_000;
    const planted: CacheEntry = {
      schemaVersion: 1,
      timestamp: ancient,
      reading: {
        fetchedAt: ancient,
        planName: 'Max 20x',
        buckets: {},
        extraUsage: null,
        error: 'rate-limited',
      },
      lastGood: null,
      backoff: {
        rateLimitedCount: 1,
        retryAfterUntil: Date.now() + 99 * 365 * 24 * 3600_000,
      },
    };
    fs.mkdirSync(usageDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(usageCachePath(), JSON.stringify(planted), { mode: 0o600 });
    fs.chmodSync(usageCachePath(), 0o600);

    const result = await getUsage({ fetcher: makeFetcher({ data: goodResponse }, calls) });
    assert.equal(calls.count, 1, 'cap must let the read fall through after RETRY_AFTER_MAX_MS');
    assert.equal(result.data?.fiveHour, 25);
  });

  // ── Force refresh + lock ──────────────────────────────────────────────────

  test('forceRefresh re-invokes the fetcher even when the cache is fresh', async () => {
    const calls = { count: 0 };
    await getUsage({ fetcher: makeFetcher({ data: goodResponse }, calls) });
    assert.equal(calls.count, 1);
    await getUsage({ forceRefresh: true, fetcher: makeFetcher({ data: goodResponse }, calls) });
    assert.equal(calls.count, 2, 'forceRefresh must bypass the cache');
  });

  // ── ANTHROPIC_BASE_URL is honoured but does not block the fetch ───────────
  //
  // A user routing Claude Code through a local token-rewriting proxy
  // (RTK at http://127.0.0.1:3457, or a self-hosted gateway) used to see
  // an empty plan/quota line because getUsage short-circuited. The
  // request itself targets api.anthropic.com directly via api.ts, so
  // setting ANTHROPIC_BASE_URL must not prevent the call.
  test('non-anthropic ANTHROPIC_BASE_URL does not block the fetch', async () => {
    const restore = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:3457';
    try {
      const calls = { count: 0 };
      const result = await getUsage({ fetcher: makeFetcher({ data: goodResponse }, calls) });
      assert.equal(calls.count, 1, 'fetcher must run despite a non-anthropic base URL');
      assert.equal(result.data?.fiveHour, 25);
    } finally {
      if (restore === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = restore;
    }
  });

  // ── The shared reading log ────────────────────────────────────────────────

  test('a successful fetch appends to the readings log; a failure does not', async () => {
    await getUsage({ fetcher: makeFetcher({ data: goodResponse }) });
    assert.equal(readReadings().length, 1);

    await getUsage({ forceRefresh: true, fetcher: makeFetcher({ data: null, error: 'http-500' }) });
    assert.equal(readReadings().length, 1, 'a failure is not a measurement');

    await getUsage({ forceRefresh: true, fetcher: makeFetcher({ data: goodResponse }) });
    assert.equal(readReadings().length, 2);
  });

  test('a torn final line does not cost the readings before it', async () => {
    await getUsage({ fetcher: makeFetcher({ data: goodResponse }) });
    fs.appendFileSync(readingsPath(), '{"fetchedAt":123,"buck');
    assert.equal(readReadings().length, 1);
  });

  // ── Legacy import ─────────────────────────────────────────────────────────

  test('a pre-protocol cache is adopted rather than discarded', async () => {
    const ts = Date.now();
    const legacy = {
      data: {
        planName: 'Max 20x',
        fiveHour: 33, fiveHourResetAt: new Date(ts + 3600_000).toISOString(),
        sevenDay: 11, sevenDayResetAt: null,
        sonnet: null, sonnetResetAt: null,
        opus: null, opusResetAt: null,
        design: null, designResetAt: null,
        routines: null, routinesResetAt: null,
        code: null, codeResetAt: null,
        extraUsage: null,
        fetchedAt: ts,
      },
      timestamp: ts,
      rateLimitedCount: 4,
    };
    fs.mkdirSync(path.dirname(legacyCachePath()), { recursive: true });
    fs.writeFileSync(legacyCachePath(), `var DATA=${JSON.stringify(legacy)};`, { mode: 0o600 });
    fs.chmodSync(legacyCachePath(), 0o600);

    const calls = { count: 0 };
    const result = await getUsage({ fetcher: makeFetcher({ data: goodResponse }, calls) });

    assert.equal(calls.count, 0, 'an adopted cache is still a cache hit');
    assert.equal(result.data?.fiveHour, 33);
    assert.equal(readEntryFile().backoff.rateLimitedCount, 4, 'the backoff counter must survive the import');
  });
});
