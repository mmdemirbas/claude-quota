import * as path from 'node:path';
import type {
  CreditGrantApiResponse, CreditGrantCacheFile,
  ProfileApiResponse, ProfileCacheFile,
} from '../types.js';
import { readCredentials } from '../credentials.js';
import { readFileSecure } from '../secure-fs.js';
import {
  pluginDir,
  CACHE_VAR_CREDIT_GRANT,
  CACHE_FILE_CREDIT_GRANT,
} from '../paths.js';
import { warn } from '../log.js';
import {
  PROFILE_CACHE_TTL_MS,
  CREDIT_GRANT_CACHE_TTL_MS,
  CREDIT_GRANT_NULL_TTL_MS,
} from './constants.js';
import { readJsCache, writeJsCache, writeCacheFile } from './cache.js';
import { fetchJson } from './api.js';
import { acquireFetchLock, getCreditGrantLockPath, getProfileLockPath } from './lock.js';

export interface ProfileData {
  orgUUID: string;
  rateLimitTier?: string;
  organizationType?: string;
}

function getProfileCachePath(): string {
  return path.join(pluginDir(), '.profile-cache.json');
}

function getCreditGrantCachePath(): string {
  return path.join(pluginDir(), CACHE_FILE_CREDIT_GRANT);
}

export function readProfileCache(now: number): ProfileData | null {
  const raw = readFileSecure(getProfileCachePath(), (reason) => {
    warn('profile cache rejected', { reason });
  });
  if (raw == null) return null;
  try {
    const cache: ProfileCacheFile = JSON.parse(raw);
    if (now - cache.timestamp < PROFILE_CACHE_TTL_MS && cache.orgUUID) {
      // Force re-fetch if cache was written before we started storing tier info
      if (!cache.rateLimitTier) return null;
      return { orgUUID: cache.orgUUID, rateLimitTier: cache.rateLimitTier, organizationType: cache.organizationType };
    }
    return null;
  } catch { return null; }
}

function writeProfileCache(data: ProfileData, timestamp: number): void {
  const cache: ProfileCacheFile = { orgUUID: data.orgUUID, rateLimitTier: data.rateLimitTier, organizationType: data.organizationType, timestamp };
  writeCacheFile(getProfileCachePath(), JSON.stringify(cache));
}

function readCreditGrantCache(now: number): { hit: true; value: number | null } | null {
  try {
    const raw = readJsCache(getCreditGrantCachePath());
    if (!raw) return null;
    const cache: CreditGrantCacheFile = JSON.parse(raw);
    const ttl = cache.creditGrant === null ? CREDIT_GRANT_NULL_TTL_MS : CREDIT_GRANT_CACHE_TTL_MS;
    if (now - cache.timestamp < ttl) {
      return { hit: true, value: cache.creditGrant };
    }
    return null;
  } catch { return null; }
}

function writeCreditGrantCache(creditGrant: number | null, timestamp: number): void {
  const cache: CreditGrantCacheFile = { creditGrant, timestamp };
  writeJsCache(getCreditGrantCachePath(), CACHE_VAR_CREDIT_GRANT, JSON.stringify(cache));
}

/**
 * Make sure the profile cache is populated before code that depends on
 * it runs. Fast path: profile cache hit returns immediately. Cold path:
 * one /api/oauth/profile fetch then write to the profile cache.
 *
 * This exists so the parent process can sequence a profile-cache warm
 * up *before* getUsage's livePlanName runs in parallel — without it,
 * the first render after a fresh install or a 24-hour profile-TTL
 * expiry shows a plan name derived from the (potentially stale)
 * credentials file instead of the live API tier.
 */
export async function ensureProfileCached(): Promise<void> {
  const now = Date.now();
  if (readProfileCache(now)) return;

  const creds = readCredentials(now);
  if (!creds) return;

  // Cross-instance lock so a 24h-TTL expiry doesn't fan out to one
  // /api/oauth/profile call per parallel statusline tick. The peer
  // that loses the lock just exits — by the time it next renders the
  // winner will have written the cache, and readProfileCache hits.
  const lock = acquireFetchLock(now, getProfileLockPath());
  if (!lock) return;

  try {
    // Re-check inside the lock: a peer may have written the cache
    // between our miss above and our lock acquisition. Without this
    // we burn an unnecessary HTTP round trip even though the lock
    // gated the herd.
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
 * Fetch the prepaid credit grant balance.
 * Returns credit grant in dollars, or null if unavailable.
 * Uses separate caches for profile (24h TTL) and credit grant (10min TTL).
 */
export async function getCreditGrant(): Promise<number | null> {
  const now = Date.now();

  // Check credit grant cache first (wrapper distinguishes "no grant" from "cache miss")
  const cached = readCreditGrantCache(now);
  if (cached) return cached.value;

  // Cold path: about to hit /api/oauth/profile and/or
  // /api/oauth/organizations/.../overage_credit_grant. Acquire a
  // dedicated lock so N parallel claude-quota processes don't
  // fan out to N profile + N grant calls — the same thundering-
  // herd that the usage-fetch lock guards against.
  const lock = acquireFetchLock(now, getCreditGrantLockPath());
  if (!lock) {
    // Peer is already fetching. Re-check the cache: if its write
    // landed between our miss above and the lock check, serve it.
    const recheck = readCreditGrantCache(now);
    return recheck ? recheck.value : null;
  }

  try {
    // Need credentials for API calls
    const creds = readCredentials(now);
    if (!creds) return null;

    // Get org UUID (from cache or profile API). May have already been
    // populated by ensureProfileCached() running ahead of us in
    // index.ts; cache hit is the common case.
    let profileData = readProfileCache(now);
    if (!profileData) {
      const profile = await fetchJson<ProfileApiResponse>('/api/oauth/profile', creds.accessToken);
      const uuid = profile?.organization?.uuid;
      if (!uuid) return null;
      profileData = {
        orgUUID: uuid,
        rateLimitTier: profile?.organization?.rate_limit_tier,
        organizationType: profile?.organization?.organization_type,
      };
      writeProfileCache(profileData, now);
    }

    // Fetch credit grant
    const grant = await fetchJson<CreditGrantApiResponse>(
      `/api/oauth/organizations/${encodeURIComponent(profileData.orgUUID)}/overage_credit_grant`,
      creds.accessToken,
    );
    // Debug dump — same DEBUG flag as the usage endpoint. Helps when
    // a feature shown on claude.ai (e.g. "$X spent / $Y limit" under
    // disabled extras) is missing from our parsed UsageData and we
    // need to compare what the server actually returned with what we
    // expect.
    if (process.env.CLAUDE_QUOTA_DEBUG === '1') {
      try {
        const path = await import('node:path');
        const { pluginDir } = await import('../paths.js');
        const { writeFileSecure } = await import('../secure-fs.js');
        writeFileSecure(
          path.join(pluginDir(), '.debug-credit-grant.json'),
          JSON.stringify({ fetchedAt: now, raw: grant }, null, 2),
        );
      } catch { /* ignore */ }
    }
    if (!grant || !grant.granted || grant.amount_minor_units == null) {
      writeCreditGrantCache(null, now);
      return null;
    }

    // Convert cents to dollars
    const dollars = grant.amount_minor_units / 100;
    writeCreditGrantCache(dollars, now);
    return dollars;
  } finally {
    lock.release();
  }
}
