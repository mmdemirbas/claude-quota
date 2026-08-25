import type {
  CreditGrantApiResponse, CreditGrantCacheFile,
  ProfileApiResponse, ProfileCacheFile,
} from './types.js';
import { readCredentials } from './credentials.js';
import { readFileSecure, writeFileSecure } from './secure-fs.js';
import { creditGrantCachePath, debugPath, profileCachePath } from './paths.js';
import { warn } from './log.js';
import {
  PROFILE_CACHE_TTL_MS,
  CREDIT_GRANT_CACHE_TTL_MS,
  CREDIT_GRANT_NULL_TTL_MS,
} from './constants.js';
import { ensureUsageDir } from './cache.js';
import { fetchJson, fetchJsonOutcome } from './api.js';
import { acquireFetchLock, creditGrantLockPath, profileLockPath } from './lock.js';

/**
 * The organisation profile and the prepaid credit balance.
 *
 * Neither is a usage measurement, so neither belongs in the protocol's
 * `usage.json` (§8) — but both are fetched from the same account, change
 * rarely, and would otherwise be re-fetched once per participant. They get the
 * same treatment: a cache in the shared directory and a lock of their own.
 */

export interface ProfileData {
  orgUUID: string;
  rateLimitTier?: string;
  organizationType?: string;
}

function readJson<T>(path: string, label: string): T | null {
  const raw = readFileSecure(path, (reason) => warn(`${label} cache rejected`, { reason }));
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeJson(path: string, value: unknown): void {
  ensureUsageDir();
  writeFileSecure(path, JSON.stringify(value));
}

export function readProfileCache(now: number): ProfileData | null {
  const cache = readJson<ProfileCacheFile>(profileCachePath(), 'profile');
  if (cache == null) return null;
  if (now - cache.timestamp >= PROFILE_CACHE_TTL_MS || !cache.orgUUID) return null;
  /*
   * `v` marks a cache written by a build that stores the tier fields.
   *
   * The check used to be "no rateLimitTier means too old to use", which is
   * wrong for an organisation whose profile response simply omits
   * `rate_limit_tier` — the field is optional. Such a cache was written and
   * then rejected by its own reader on every read, so `ensureProfileCached`
   * missed forever and every statusline render issued a fresh profile request,
   * awaited on the critical path. Worse during a rate limit: that request 429s,
   * caches nothing, and repeats once per render with no backoff at all.
   */
  if (cache.v === undefined && !cache.rateLimitTier) return null;
  return {
    orgUUID: cache.orgUUID,
    rateLimitTier: cache.rateLimitTier,
    organizationType: cache.organizationType,
  };
}

function writeProfileCache(data: ProfileData, timestamp: number): void {
  const cache: ProfileCacheFile = {
    v: 2,
    orgUUID: data.orgUUID,
    rateLimitTier: data.rateLimitTier,
    organizationType: data.organizationType,
    timestamp,
  };
  writeJson(profileCachePath(), cache);
}

function readCreditGrantCache(now: number): { hit: true; value: number | null } | null {
  const cache = readJson<CreditGrantCacheFile>(creditGrantCachePath(), 'credit grant');
  if (cache == null) return null;
  // "No grant" is far more stable than a balance — most accounts never enable
  // extra credits, and re-asking every ten minutes is ~144 pointless calls a
  // day. Hold the null for a day instead.
  const ttl = cache.creditGrant === null ? CREDIT_GRANT_NULL_TTL_MS : CREDIT_GRANT_CACHE_TTL_MS;
  if (now - cache.timestamp >= ttl) return null;
  return { hit: true, value: cache.creditGrant };
}

function writeCreditGrantCache(creditGrant: number | null, timestamp: number): void {
  const cache: CreditGrantCacheFile = { creditGrant, timestamp };
  writeJson(creditGrantCachePath(), cache);
}

/**
 * Populate the profile cache if it is cold.
 *
 * Callers that need the live plan tier run this before anything that reads the
 * profile cache, so the first render after a fresh install or a 24-hour TTL
 * expiry shows the API's tier rather than one derived from a possibly stale
 * credential.
 */
export async function ensureProfileCached(): Promise<void> {
  const now = Date.now();
  if (readProfileCache(now)) return;

  const creds = readCredentials(now);
  if (!creds) return;

  // Its own lock, so a TTL expiry does not fan out to one profile call per
  // parallel participant. The loser just exits; by its next tick the winner
  // will have written the cache.
  const lock = acquireFetchLock(now, profileLockPath());
  if (!lock) return;

  try {
    // Re-check inside the lock: a peer may have written between our miss and
    // our acquisition, and the round trip would be wasted.
    if (readProfileCache(now)) return;

    const profile = await fetchJson<ProfileApiResponse>('/api/oauth/profile', creds.accessToken);
    const uuid = profile?.organization?.uuid;
    if (!uuid) return;
    writeProfileCache({
      orgUUID: uuid,
      rateLimitTier: profile.organization?.rate_limit_tier,
      organizationType: profile.organization?.organization_type,
    }, now);
  } finally {
    lock.release();
  }
}

/**
 * The prepaid credit grant.
 *
 * `known: false` means "could not find out", which is not the same as "there is
 * no grant" and must not be rendered as one. Collapsing the two blanked a real
 * balance on the dashboard whenever a second window happened to hold the lock,
 * and cached a dropped connection as "no grant" for a day.
 */
export interface CreditGrantState {
  known: boolean;
  value: number | null;
}

const UNKNOWN: CreditGrantState = { known: false, value: null };

export async function getCreditGrant(): Promise<CreditGrantState> {
  const now = Date.now();

  const cached = readCreditGrantCache(now);
  if (cached) return { known: true, value: cached.value };

  const lock = acquireFetchLock(now, creditGrantLockPath());
  if (!lock) {
    const recheck = readCreditGrantCache(now);
    return recheck ? { known: true, value: recheck.value } : UNKNOWN;
  }

  try {
    const creds = readCredentials(now);
    if (!creds) return UNKNOWN;

    // Cold profile defers to ensureProfileCached so the *profile* lock
    // serialises that fetch. Without the deferral two participants holding
    // different locks — credit-grant and profile — would both call the profile
    // endpoint.
    let profileData = readProfileCache(now);
    if (!profileData) {
      await ensureProfileCached();
      profileData = readProfileCache(now);
      if (!profileData) return UNKNOWN;
    }

    /*
     * `fetchJson` returns null for a 429, a 500, a timeout and a parse failure
     * alike, so it cannot distinguish "this account has no grant" from "the
     * server did not answer". Caching the second as the first held a real
     * balance at zero for a day — most likely triggered by the very rate limit
     * that makes someone look at their quota. Ask for the outcome instead.
     */
    const outcome = await fetchJsonOutcome<CreditGrantApiResponse>(
      `/api/oauth/organizations/${encodeURIComponent(profileData.orgUUID)}/overage_credit_grant`,
      creds.accessToken,
    );
    if (!outcome.ok) return UNKNOWN;
    const grant = outcome.data;

    if (process.env.CLAUDE_USAGE_DEBUG === '1' || process.env.CLAUDE_QUOTA_DEBUG === '1') {
      try {
        writeFileSecure(
          debugPath('.debug-credit-grant.json'),
          JSON.stringify({ fetchedAt: now, raw: grant }, null, 2),
        );
      } catch { /* ignore */ }
    }

    if (!grant || !grant.granted || grant.amount_minor_units == null) {
      writeCreditGrantCache(null, now);
      return { known: true, value: null };
    }

    const dollars = grant.amount_minor_units / 100;
    writeCreditGrantCache(dollars, now);
    return { known: true, value: dollars };
  } finally {
    lock.release();
  }
}
