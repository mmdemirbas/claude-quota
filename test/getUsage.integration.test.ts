import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getUsage, type FetchApiFn } from '../src/usage.js';
import type { UsageApiResponse } from '../src/types.js';

// POSIX-only: we redirect HOME to a tmp dir so pluginDir() resolves
// under our control. Windows uses USERPROFILE which works the same way,
// but file-mode 0o600 enforcement in the secure-fs path is POSIX-only.
const isPosix = process.platform !== 'win32';

describe('getUsage orchestration', { skip: !isPosix }, () => {
  let tmpHome: string;
  let cfgDir: string;
  let pluginDir: string;
  let prevHome: string | undefined;
  let prevCfg: string | undefined;
  let prevSilent: string | undefined;
  let prevBase: string | undefined;
  let prevApiBase: string | undefined;

  before(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-quota-getUsage-'));
    cfgDir = path.join(tmpHome, '.claude');
    pluginDir = path.join(cfgDir, 'plugins', 'claude-quota');
    fs.mkdirSync(pluginDir, { recursive: true });

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
    // Wipe cache + lock between tests so each starts cold.
    for (const f of ['data.js', '.fetch.lock', '.profile-cache.json', 'credit-grant.js', '.credit-grant.lock']) {
      try { fs.rmSync(path.join(pluginDir, f), { force: true }); } catch { /* ignore */ }
    }
  });

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
    fs.writeFileSync(path.join(pluginDir, '.fetch.lock'), '99999', { mode: 0o600 });

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

    // Read the on-disk cache to confirm the counter survived.
    const raw = fs.readFileSync(path.join(pluginDir, 'data.js'), 'utf8');
    const json = raw.slice(raw.indexOf('=') + 1).replace(/;\s*$/, '');
    const cache = JSON.parse(json);
    assert.equal(cache.rateLimitedCount, 2, 'counter must escalate across the 500');
    assert.ok(cache.lastGoodData, 'lastGoodData must survive the 500');
    assert.equal(cache.lastGoodData.fiveHour, 25);
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
});
