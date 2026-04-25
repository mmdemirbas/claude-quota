import type { UsageData } from './types.js';
import { readCredentials, getPlanName } from './credentials.js';
import { clamp, parseDate, parseExtraUsage, jitteredBackoff, hydrateDates } from './usage/parse.js';
import { getCachePath, readCache, writeCache, recoverCacheState } from './usage/cache.js';
import { acquireFetchLock, bumpCacheTimestamp } from './usage/lock.js';
import { fetchApi } from './usage/api.js';
import { readProfileCache } from './usage/profile.js';

// ── Re-exports for the public surface ─────────────────────────────────────
//
// The original usage.ts grew to ~900 lines over the course of three
// review iterations. Splitting into usage/* submodules keeps the
// per-file scope navigable; this file remains the import target for
// the rest of the codebase and the test suite.

export {
  // Pure helpers (used directly by tests)
  clamp, parseDate, parseExtraUsage, jitteredBackoff,
  rehydrateDate, parseRetryAfter,
} from './usage/parse.js';
export { recoverCacheState } from './usage/cache.js';
export { acquireFetchLock, bumpCacheTimestamp } from './usage/lock.js';
export {
  requestApi,
  type RequestApiOpts,
  type RequestOutcome,
} from './usage/api.js';
export { ensureProfileCached, getCreditGrant } from './usage/profile.js';

// ── Main ───────────────────────────────────────────────────────────────────

/**
 * Test seam: callers can inject a fake fetcher for integration tests
 * without spinning up an HTTP server. Production callers omit it.
 */
export type FetchApiFn = typeof fetchApi;

export async function getUsage(opts?: { forceRefresh?: boolean; fetcher?: FetchApiFn }): Promise<{ data: UsageData | null; isStale: boolean }> {
  const now = Date.now();

  // Derive plan name from profile cache (live API tier) → credentials (bootstrap fallback).
  // Profile API's organization.rate_limit_tier is the authoritative source; credential
  // rateLimitTier can be stale after plan upgrades until Claude Code refreshes the OAuth token.
  //
  // `skipCreds` is set on the cache-hit hot path: every render that doesn't
  // need a fresh fetch would otherwise pay a Keychain `security` invocation
  // (~50–200 ms) just to re-confirm the plan name we already have. The
  // profile-cache lookup is cheap (a single 0o600 file read), so we still
  // prefer it; we just don't fall back to credentials when the cache hit
  // already carried a plan name.
  const livePlanName = (skipCreds = false): string | null => {
    const profile = readProfileCache(now);
    if (profile?.rateLimitTier || profile?.organizationType) {
      const fromProfile = getPlanName(profile.organizationType ?? '', profile.rateLimitTier);
      if (fromProfile) return fromProfile;
    }
    if (skipCreds) return null;
    const creds = readCredentials(now);
    return creds ? getPlanName(creds.subscriptionType, creds.rateLimitTier) : null;
  };

  // Check cache first — serve cached data regardless of env settings
  if (!opts?.forceRefresh) {
    const cached = readCache(now);
    if (cached) {
      // Re-derive planName from the profile cache only. The cached planName
      // already came from a successful fetch's credentials/profile; falling
      // back to readCredentials here would Keychain-hit on every tick.
      const fresh = livePlanName(/* skipCreds */ true);
      if (fresh) cached.data = { ...cached.data, planName: fresh };
      else if (!cached.data.planName) {
        // Cache somehow predates the planName field — last-resort full lookup.
        const full = livePlanName();
        if (full) cached.data = { ...cached.data, planName: full };
      }
      return cached;
    }
  }

  const none = { data: null, isStale: false } as const;

  // ANTHROPIC_BASE_URL is intentionally ignored. Even when a user routes
  // Claude Code through a token-rewriting proxy (RTK) or a self-hosted
  // gateway, the OAuth usage/profile endpoints are tied to anthropic.com
  // and our request helper goes there directly (see api.ts). Users on a
  // truly non-anthropic backend (Bedrock-only, etc.) will simply have no
  // Claude OAuth token in the keychain — readCredentials returns null
  // below and we noop.
  const creds = readCredentials(now);
  if (!creds) return none;

  const planName = livePlanName();
  if (!planName) return none; // API user

  // Try to acquire the cross-instance fetch lock. If we don't get it,
  // another claude-quota process is already fetching — re-read the
  // cache (it may have just landed) and serve whatever's there. This is
  // the main rate-limit safety valve: with N parallel windows open we
  // emit at most one upstream call instead of N.
  const lock = acquireFetchLock(now);
  if (!lock) {
    const cached = readCache(now);
    if (cached) return cached;
    // No cache and no lock — yield without firing a duplicate request.
    return none;
  }

  // We hold the lock. Bump the cache so parallel instances reading
  // through readCache see a fresh-looking entry and don't pile on with
  // their own background-refresh spawns.
  bumpCacheTimestamp(now);

  let result;
  try {
    result = await (opts?.fetcher ?? fetchApi)(creds.accessToken);
  } finally {
    lock.release();
  }

  if (!result.data) {
    const isRateLimit = result.error === 'rate-limited';
    const failure: UsageData = {
      planName,
      fiveHour: null, fiveHourResetAt: null,
      sevenDay: null, sevenDayResetAt: null,
      sonnet: null, sonnetResetAt: null,
      opus: null, opusResetAt: null,
      extraUsage: null,
      apiUnavailable: true,
      apiError: result.error,
    };

    // Recover last good data and prior backoff count from the cache. Both
    // are preserved across non-429 failures too — without this, a single
    // intermittent 500 between two 429s wiped lastGoodData (so the user
    // saw "no data" instead of last-good values) and reset the rate-limit
    // counter (defeating exponential backoff escalation).
    const { prevCount, lastGoodData } = recoverCacheState(getCachePath());

    if (isRateLimit) {
      const newCount = prevCount + 1;
      writeCache(failure, now, {
        rateLimitedCount: newCount,
        // Prefer the server's Retry-After when present; otherwise derive
        // a jittered backoff so parallel instances coming off the same
        // count don't all retry at exactly the same instant.
        retryAfterUntil: result.retryAfterSec
          ? now + result.retryAfterSec * 1000
          : now + jitteredBackoff(newCount),
        lastGoodData,
      });
      const data = lastGoodData
        ? { ...hydrateDates(lastGoodData), apiError: 'rate-limited' as const }
        : failure;
      return { data, isStale: false };
    }

    // Non-429 failure: keep the prior counter and last-good snapshot intact
    // so a 429 that follows still finds them.
    writeCache(failure, now, { rateLimitedCount: prevCount, lastGoodData });
    return { data: failure, isStale: false };
  }

  // Parse full response
  const usage: UsageData = {
    planName,
    fetchedAt: now,
    fiveHour: clamp(result.data.five_hour?.utilization),
    fiveHourResetAt: parseDate(result.data.five_hour?.resets_at),
    sevenDay: clamp(result.data.seven_day?.utilization),
    sevenDayResetAt: parseDate(result.data.seven_day?.resets_at),
    sonnet: clamp(result.data.seven_day_sonnet?.utilization),
    sonnetResetAt: parseDate(result.data.seven_day_sonnet?.resets_at),
    opus: clamp(result.data.seven_day_opus?.utilization),
    opusResetAt: parseDate(result.data.seven_day_opus?.resets_at),
    extraUsage: parseExtraUsage(result.data.extra_usage),
  };

  writeCache(usage, now, { lastGoodData: usage, rateLimitedCount: 0 });
  return { data: usage, isStale: false };
}
