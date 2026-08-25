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
import { fetchJson } from './api.js';
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
  // A cache written before the tier fields existed cannot answer the question
  // it is consulted for; treat it as a miss and re-fetch.
  if (!cache.rateLimitTier) return null;
  return {
    orgUUID: cache.orgUUID,
    rateLimitTier: cache.rateLimitTier,
    organizationType: cache.organizationType,
  };
}

function writeProfileCache(data: ProfileData, timestamp: number): void {
  const cache: ProfileCacheFile = {
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

/** Prepaid credit grant in dollars, or null when there is none or it is unknown. */
export async function getCreditGrant(): Promise<number | null> {
  const now = Date.now();

  const cached = readCreditGrantCache(now);
  if (cached) return cached.value;

  const lock = acquireFetchLock(now, creditGrantLockPath());
  if (!lock) {
    const recheck = readCreditGrantCache(now);
    return recheck ? recheck.value : null;
  }

  try {
    const creds = readCredentials(now);
    if (!creds) return null;

    // Cold profile defers to ensureProfileCached so the *profile* lock
    // serialises that fetch. Without the deferral two participants holding
    // different locks — credit-grant and profile — would both call the profile
    // endpoint.
    let profileData = readProfileCache(now);
    if (!profileData) {
      await ensureProfileCached();
      profileData = readProfileCache(now);
      if (!profileData) return null;
    }

    const grant = await fetchJson<CreditGrantApiResponse>(
      `/api/oauth/organizations/${encodeURIComponent(profileData.orgUUID)}/overage_credit_grant`,
      creds.accessToken,
    );

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
      return null;
    }

    const dollars = grant.amount_minor_units / 100;
    writeCreditGrantCache(dollars, now);
    return dollars;
  } finally {
    lock.release();
  }
}
