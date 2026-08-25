import type { UsageData, UsageResult } from './types.js';
import { readCredentials, getPlanName } from './credentials.js';
import { clamp, parseDate, parseExtraUsage, jitteredBackoff } from './parse.js';
import {
  bumpTimestamp,
  migrateLegacyCache,
  priorBuckets,
  readCache,
  toReading,
  toUsageData,
  updateEntry,
} from './cache.js';
import { acquireFetchLock } from './lock.js';
import { fetchApi } from './api.js';
import { readProfileCache } from './profile.js';
import { appendReading } from './readings.js';
import { writeFileSecure } from './secure-fs.js';
import { debugPath } from './paths.js';

/** Test seam: callers can inject a fake fetcher without standing up an HTTP server. */
export type FetchApiFn = typeof fetchApi;

export interface GetUsageOpts {
  forceRefresh?: boolean;
  fetcher?: FetchApiFn;
}

function debugEnabled(): boolean {
  return process.env.CLAUDE_USAGE_DEBUG === '1' || process.env.CLAUDE_QUOTA_DEBUG === '1';
}

/**
 * The plan name is a label, not a measurement.
 *
 * The profile API's `rate_limit_tier` is authoritative; the credential's copy
 * can be stale after a plan change until Claude Code refreshes the OAuth
 * token. `skipCreds` matters on the cache-hit path: reading the credential
 * costs a Keychain invocation (~50-200 ms), which is not worth paying on every
 * statusline tick just to re-confirm a name we already have.
 */
function livePlanName(now: number, skipCreds = false): string | null {
  const profile = readProfileCache(now);
  if (profile?.rateLimitTier || profile?.organizationType) {
    const fromProfile = getPlanName(profile.organizationType ?? '', profile.rateLimitTier);
    if (fromProfile) return fromProfile;
  }
  if (skipCreds) return null;
  const creds = readCredentials(now);
  return creds ? getPlanName(creds.subscriptionType, creds.rateLimitTier) : null;
}

/**
 * Read whatever is cached. Never fetches, never writes, never spawns.
 *
 * For callers that want to render the current number without becoming
 * responsible for keeping it fresh.
 */
export function readCachedUsage(now: number = Date.now()): UsageResult {
  const cached = readCache(now);
  if (!cached) return { data: null, isStale: false, source: 'none' };
  const fresh = livePlanName(now, /* skipCreds */ true);
  const data = fresh ? { ...cached.data, planName: fresh } : cached.data;
  return { data, isStale: cached.isStale, source: cached.source };
}

/**
 * The whole point of the package: a usage reading, fetched only if nobody else
 * already did.
 *
 * Every participant on the machine calls this. Whoever finds the shared entry
 * stale and wins the lock pays for one request; everyone else reads what that
 * one wrote. A participant that is the only one running still gets a number,
 * because it is also the one that fetches.
 */
export async function getUsage(opts?: GetUsageOpts): Promise<UsageResult> {
  const now = Date.now();

  if (!opts?.forceRefresh) {
    const cached = readCache(now);
    if (cached) {
      // Re-derive the plan name from the profile cache only — see livePlanName.
      const fresh = livePlanName(now, /* skipCreds */ true);
      let data = cached.data;
      if (fresh) data = { ...data, planName: fresh };
      else if (!data.planName) {
        const full = livePlanName(now);
        if (full) data = { ...data, planName: full };
      }
      return { data, isStale: cached.isStale, source: cached.source };
    }
  }

  // Nothing usable in the shared entry. If this machine has a pre-protocol
  // claude-quota cache, adopt it rather than discarding a live backoff counter
  // and the last good reading — which is exactly what a rate-limited account
  // can least afford to lose.
  if (migrateLegacyCache(now) && !opts?.forceRefresh) {
    const cached = readCache(now);
    if (cached) {
      const fresh = livePlanName(now, /* skipCreds */ true);
      return {
        data: fresh ? { ...cached.data, planName: fresh } : cached.data,
        isStale: cached.isStale,
        source: cached.source,
      };
    }
  }

  const none: UsageResult = { data: null, isStale: false, source: 'none' };

  // ANTHROPIC_BASE_URL is deliberately ignored: the OAuth usage endpoint is
  // tied to anthropic.com and does not exist behind a proxy or gateway. A user
  // on a Bedrock-only setup simply has no Claude OAuth token, readCredentials
  // returns null, and we do nothing. That is not an error state.
  const creds = readCredentials(now);
  if (!creds) return none;

  const planName = livePlanName(now);
  if (!planName) return none; // API-key user, not a subscription

  const lock = acquireFetchLock(now);
  if (!lock) {
    // A peer is fetching. Re-read — their write may have just landed — and
    // otherwise yield rather than fire a duplicate request.
    const cached = readCache(now);
    if (cached) {
      return { data: cached.data, isStale: cached.isStale, source: 'peer' };
    }
    return { data: null, isStale: false, source: 'peer' };
  }

  // Holding the lock. Mark the entry fresh before the request so peers reading
  // mid-flight do not queue refreshes of their own. The reading is untouched:
  // nobody is shown a number that was not measured.
  bumpTimestamp(now);

  let result;
  try {
    result = await (opts?.fetcher ?? fetchApi)(creds.accessToken);

    if (!result.data) {
      return { data: writeFailure(now, planName, result.error, result.retryAfterSec), isStale: false, source: 'fetch' };
    }

    if (debugEnabled()) {
      try {
        writeFileSecure(
          debugPath('.debug-api.json'),
          JSON.stringify({ fetchedAt: now, raw: result.data }, null, 2),
        );
      } catch { /* ignore */ }
    }

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
      // Codenames are Anthropic-internal; the mapping is inferred from the
      // labels on claude.ai/settings/usage. Run with CLAUDE_USAGE_DEBUG=1 to
      // dump the raw response when a bucket that should be there is missing.
      //   cowork     → Claude Design
      //   oauth_apps → Claude Routines
      //   omelette   → Claude Code
      design: clamp(result.data.seven_day_cowork?.utilization),
      designResetAt: parseDate(result.data.seven_day_cowork?.resets_at),
      routines: clamp(result.data.seven_day_oauth_apps?.utilization),
      routinesResetAt: parseDate(result.data.seven_day_oauth_apps?.resets_at),
      code: clamp(result.data.seven_day_omelette?.utilization),
      codeResetAt: parseDate(result.data.seven_day_omelette?.resets_at),
      extraUsage: parseExtraUsage(result.data.extra_usage),
    };

    const reading = toReading(usage, now, priorBuckets());
    updateEntry(now, (entry) => {
      entry.timestamp = now;
      entry.reading = reading;
      entry.lastGood = reading;
      entry.backoff = { rateLimitedCount: 0, retryAfterUntil: null };
    });
    appendReading(reading);

    return { data: { ...usage, buckets: reading.buckets }, isStale: false, source: 'fetch' };
  } finally {
    lock.release();
  }
}

/**
 * Record a failed fetch and return what the caller should show.
 *
 * `lastGood` and `rateLimitedCount` are preserved across *every* failure kind,
 * not just 429s. Without that, a single intermittent 500 between two 429s
 * wiped the last good reading (so the user saw "no data" instead of real
 * numbers) and reset the counter, defeating the exponential escalation.
 */
function writeFailure(
  now: number,
  planName: string,
  error: UsageData['apiError'],
  retryAfterSec: number | undefined,
): UsageData {
  const isRateLimit = error === 'rate-limited';
  const failure: UsageData = {
    planName,
    fiveHour: null, fiveHourResetAt: null,
    sevenDay: null, sevenDayResetAt: null,
    sonnet: null, sonnetResetAt: null,
    opus: null, opusResetAt: null,
    design: null, designResetAt: null,
    routines: null, routinesResetAt: null,
    code: null, codeResetAt: null,
    extraUsage: null,
    apiUnavailable: true,
    apiError: error,
  };

  let lastGood: UsageData | null = null;

  updateEntry(now, (entry) => {
    lastGood = entry.lastGood ? toUsageData(entry.lastGood) : null;
    entry.timestamp = now;
    entry.reading = toReading(failure, now, entry.reading?.buckets ?? entry.lastGood?.buckets);
    if (isRateLimit) {
      const count = entry.backoff.rateLimitedCount + 1;
      entry.backoff = {
        rateLimitedCount: count,
        // The server's Retry-After when it sent one; otherwise a jittered
        // backoff, so peers coming off the same count do not all retry at the
        // same instant and re-trigger the 429 in lockstep.
        retryAfterUntil: retryAfterSec ? now + retryAfterSec * 1000 : now + jitteredBackoff(count),
      };
    }
  });

  if (isRateLimit && lastGood) {
    return { ...(lastGood as UsageData), apiError: 'rate-limited' };
  }
  return failure;
}
