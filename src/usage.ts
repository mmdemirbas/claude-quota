import * as fs from 'node:fs';
import * as path from 'node:path';
import * as https from 'node:https';
import { StringDecoder } from 'node:string_decoder';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type {
  UsageApiResponse, UsageData, ExtraUsageData, CacheFile, ApiError,
  ProfileApiResponse, CreditGrantApiResponse, ProfileCacheFile, CreditGrantCacheFile,
} from './types.js';
import { readCredentials, getPlanName } from './credentials.js';
import { readFileSecure, writeFileSecure } from './secure-fs.js';
import { pluginDir } from './paths.js';
import { warn } from './log.js';

const CACHE_TTL_MS = 2 * 60_000;           // 2 min hard TTL (force re-fetch)
const CACHE_SOFT_TTL_MS = 45_000;          // 45s soft TTL (serve stale + background refresh)
const CACHE_FAILURE_TTL_MS = 15_000;        // 15s for failures
const CACHE_RATE_LIMITED_BASE_MS = 60_000;   // 60s base for 429 backoff
const CACHE_RATE_LIMITED_MAX_MS = 5 * 60_000;
const FETCH_COORDINATION_MS = 20_000;       // 20s — if fetcher hasn't written by now, it died
const PROFILE_CACHE_TTL_MS = 24 * 60 * 60_000; // 24h — org UUID rarely changes
const CREDIT_GRANT_CACHE_TTL_MS = 10 * 60_000; // 10 min — changes only on top-up
const API_TIMEOUT_MS = 15_000;

function getCachePath(): string {
  return path.join(pluginDir(), 'data.js');
}

function getProfileCachePath(): string {
  return path.join(pluginDir(), '.profile-cache.json');
}

function getCreditGrantCachePath(): string {
  return path.join(pluginDir(), 'credit-grant.js');
}

/**
 * Read JSON from a .js file that wraps it as `var NAME=<json>;`.
 *
 * Goes through readFileSecure so a world-writable or non-owned cache
 * file (e.g., planted by another local user) is refused — we will treat
 * the cache as missing and re-fetch rather than serve attacker data
 * into render/dashboard code paths.
 */
function readJsCache(filePath: string): string | null {
  const content = readFileSecure(filePath, (reason) => {
    warn('cache file rejected', { path: filePath, reason });
  });
  if (content == null) return null;
  const eqIdx = content.indexOf('=');
  if (eqIdx < 0) return null;
  // Strip "var NAME=" prefix and trailing ";"
  return content.slice(eqIdx + 1).replace(/;\s*$/, '');
}

/** Write JSON to a .js file as `var NAME=<json>;` */
function writeJsCache(filePath: string, varName: string, json: string): void {
  writeCacheFile(filePath, `var ${varName}=${json};`);
}

// ── Cache ──────────────────────────────────────────────────────────────────

/**
 * Coerce a JSON-deserialized date value (string from the on-disk cache,
 * or already-a-Date if hydrateDates is called twice) back to a Date.
 * Returns null on a malformed or non-parseable value so the renderer
 * never sees an Invalid Date — that previously leaked NaN/undefined into
 * the bar/glyph rendering. Exported for testing.
 */
export function rehydrateDate(v: unknown): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function hydrateDates(data: UsageData): UsageData {
  return {
    ...data,
    fiveHourResetAt: rehydrateDate(data.fiveHourResetAt),
    sevenDayResetAt: rehydrateDate(data.sevenDayResetAt),
    sonnetResetAt: rehydrateDate(data.sonnetResetAt),
    opusResetAt: rehydrateDate(data.opusResetAt),
  };
}

function readCache(now: number): { data: UsageData; isStale: boolean } | null {
  try {
    const raw = readJsCache(getCachePath());
    if (!raw) return null;
    const cache: CacheFile = JSON.parse(raw);

    // Handle rate-limit backoff
    if (cache.data.apiError === 'rate-limited' && cache.rateLimitedCount) {
      const backoff = Math.min(
        CACHE_RATE_LIMITED_BASE_MS * Math.pow(2, Math.max(0, cache.rateLimitedCount - 1)),
        CACHE_RATE_LIMITED_MAX_MS,
      );
      const retryUntil = cache.retryAfterUntil ?? (cache.timestamp + backoff);
      if (now < retryUntil) {
        // Still in backoff — return last good data with syncing hint; never trigger background refresh
        const display = cache.lastGoodData
          ? { ...hydrateDates(cache.lastGoodData), apiError: 'rate-limited' as const }
          : hydrateDates(cache.data);
        return { data: { ...display, fetchedAt: cache.timestamp }, isStale: false };
      }
      // Backoff expired — fetch fresh regardless of failure TTL
      return null;
    }

    const ttl = cache.data.apiUnavailable ? CACHE_FAILURE_TTL_MS : CACHE_TTL_MS;
    const age = now - cache.timestamp;
    if (age < ttl) {
      // A previous fetch was started but never completed (process killed after bump).
      // After the coordination window, stop trusting the bump and force re-fetch.
      if (cache.fetchStartedAt && now - cache.fetchStartedAt >= FETCH_COORDINATION_MS) {
        return null;
      }
      const display = (cache.data.apiError === 'rate-limited' && cache.lastGoodData)
        ? { ...hydrateDates(cache.lastGoodData), apiError: 'rate-limited' as const }
        : hydrateDates(cache.data);
      // Only mark stale for successful responses; failures have a short TTL already
      const isStale = !cache.data.apiUnavailable && age >= CACHE_SOFT_TTL_MS;
      return { data: { ...display, fetchedAt: cache.timestamp }, isStale };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Pull rate-limit counter + last-good snapshot out of an on-disk cache file
 * for use when writing a *failure* entry. Both fields must be preserved
 * across consecutive failures (rate-limited or not) so that:
 *   - the next 429 keeps escalating exponential backoff instead of restarting
 *   - the rate-limit display can keep showing the prior good values
 *
 * Exported for testing.
 */
export function recoverCacheState(cachePath: string): { prevCount: number; lastGoodData: UsageData | undefined } {
  try {
    const rawJs = readJsCache(cachePath);
    if (!rawJs) return { prevCount: 0, lastGoodData: undefined };
    const prev: CacheFile = JSON.parse(rawJs);
    return {
      prevCount: prev.rateLimitedCount ?? 0,
      lastGoodData: prev.lastGoodData ?? (!prev.data.apiUnavailable ? prev.data : undefined),
    };
  } catch {
    return { prevCount: 0, lastGoodData: undefined };
  }
}

function writeCache(data: UsageData, timestamp: number, opts?: Partial<CacheFile>): void {
  const cache: CacheFile = { data, timestamp, ...opts };
  delete cache.fetchStartedAt; // fetch completed — clear the coordination lock
  writeJsCache(getCachePath(), 'DATA', JSON.stringify(cache));
}

// ── API ────────────────────────────────────────────────────────────────────
//
// TLS TRUST MODEL
// ───────────────
// Calls to api.anthropic.com rely on Node's default HTTPS validation
// against the system certificate store. We do NOT pin Anthropic's
// certificate: Anthropic rotates its leaf cert and does not publish a
// pin set, so any hardcoded hash would eventually cause a hard outage.
//
// Implications the user should know:
//   - Anyone with the ability to install a trusted CA on the machine
//     (root/admin, or a corporate MDM profile) can MITM our API calls
//     and inject arbitrary usage data or redirect the OAuth token.
//   - Node's minimum TLS version is pinned below to TLSv1.2; downgrade
//     attacks to SSLv3/TLSv1.0 are refused.
//
// Mitigations that already exist elsewhere:
//   - The dashboard escapes user-controlled fields so an injected
//     planName cannot execute script (see dashboard.ts _esc).
//   - Cache files are 0o600 so a MITM'd response still cannot be
//     read by other local users from disk (see secure-fs.ts).

const MAX_RESPONSE_BODY = 1_048_576; // 1 MB guard
const MIN_TLS_VERSION = 'TLSv1.2' as const;

/**
 * Collect a response body up to MAX_RESPONSE_BODY bytes.
 *
 * Uses StringDecoder so a multi-byte UTF-8 character split across two
 * chunks does not become a U+FFFD replacement. Calls req.destroy() when
 * the cap is reached so the connection stops downloading bytes the
 * caller will never read; without this the previous pre-append guard
 * silently kept the socket draining for whatever the server still had
 * queued.
 *
 * Returns { body, overflowed }: when overflowed is true, the caller
 * should treat the body as malformed (it was truncated mid-stream).
 */
function collectBody(req: ClientRequest, res: IncomingMessage): Promise<{ body: string; overflowed: boolean }> {
  return new Promise((resolve) => {
    const decoder = new StringDecoder('utf8');
    let body = '';
    let bytes = 0;
    let overflowed = false;
    res.on('data', (c: Buffer) => {
      if (overflowed) return;
      bytes += c.length;
      if (bytes > MAX_RESPONSE_BODY) {
        overflowed = true;
        req.destroy();
        return;
      }
      body += decoder.write(c);
    });
    res.on('end', () => {
      if (!overflowed) body += decoder.end();
      resolve({ body, overflowed });
    });
    res.on('error', () => resolve({ body, overflowed }));
  });
}

function fetchApi(accessToken: string): Promise<{ data: UsageApiResponse | null; error?: ApiError; retryAfterSec?: number }> {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/api/oauth/usage',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'claude-quota/0.2',
      },
      minVersion: MIN_TLS_VERSION,
      timeout: API_TIMEOUT_MS,
    }, (res) => {
      void collectBody(req, res).then(({ body, overflowed }) => {
        if (overflowed) {
          resolve({ data: null, error: 'parse' });
          return;
        }
        if (res.statusCode !== 200) {
          const code = res.statusCode ?? 0;
          const error: ApiError = code === 429 ? 'rate-limited' : `http-${code}`;
          const retryRaw = res.headers['retry-after'];
          const retryVal = Array.isArray(retryRaw) ? retryRaw[0] : retryRaw;
          const retryAfterSec = retryVal ? parseInt(retryVal, 10) || undefined : undefined;
          // Surface auth failures distinctly so a revoked or rotated token
          // does not present as a generic "API down". 429 stays quiet —
          // rate-limits are handled with UI backoff, not warnings.
          if (code === 401 || code === 403) {
            warn('usage API auth failed', { code });
          }
          resolve({ data: null, error, retryAfterSec });
          return;
        }
        try {
          resolve({ data: JSON.parse(body) as UsageApiResponse });
        } catch {
          resolve({ data: null, error: 'parse' });
        }
      });
    });

    req.on('error', () => resolve({ data: null, error: 'network' }));
    req.on('timeout', () => { req.destroy(); resolve({ data: null, error: 'timeout' }); });
    req.end();
  });
}

// ── Parsing ────────────────────────────────────────────────────────────────

/**
 * Clamp API utilization to integer 0-100.
 * The API returns values in the 0-100 range (not 0-1).
 * Exported for testing.
 */
export function clamp(v: number | undefined | null): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  return Math.round(Math.max(0, Math.min(100, v)));
}

/** Exported for testing. */
export function parseDate(s: string | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/** Coerce an API monetary field to a non-negative finite dollar amount, or null when unparseable. */
function parseMinorUnits(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return v / 100;
}

/** Exported for testing. */
export function parseExtraUsage(raw: UsageApiResponse['extra_usage']): ExtraUsageData | null {
  if (raw == null) return null; // API didn't return extra_usage at all
  if (!raw.is_enabled) return { enabled: false, monthlyLimit: 0, usedCredits: 0, creditGrant: null };

  // API returns values in cents; convert to dollars. A non-numeric field
  // (e.g. schema drift or MITM-injected garbage) must not produce NaN
  // percentages in the renderer — treat "enabled but unparseable" as if
  // the quota were absent.
  const monthlyLimit = parseMinorUnits(raw.monthly_limit);
  if (monthlyLimit == null || monthlyLimit === 0) return null;

  const usedRaw = raw.used_credits ?? 0;
  const usedCredits = parseMinorUnits(usedRaw) ?? 0;

  return {
    enabled: true,
    monthlyLimit,
    usedCredits,
    creditGrant: null, // filled later by getCreditGrant()
  };
}

// ── Multi-instance coordination ───────────────────────────────────────────

/**
 * Bump the cache timestamp without changing data.
 *
 * Prevents parallel instances from all fetching at the same time:
 * downstream readers see a fresh timestamp (so age < TTL) and serve
 * the cached value instead of triggering their own fetch.
 *
 * Exported so the parent process can bump *before* spawning the
 * detached background refresher — closing the window where a third
 * parallel instance could read the still-stale cache, also flag it
 * stale, and spawn a duplicate refresher.
 */
export function bumpCacheTimestamp(now: number = Date.now()): void {
  try {
    const raw = readJsCache(getCachePath());
    if (!raw) return;
    const cache: CacheFile = JSON.parse(raw);
    // Skip bump for non-rate-limited failures (short TTL handles those).
    // Always bump for rate-limited entries whose backoff has expired, otherwise
    // parallel instances all see an expired backoff and race to fetch.
    if (cache.data.apiUnavailable && !cache.rateLimitedCount) return;
    cache.timestamp = now;
    cache.fetchStartedAt = now;
    writeJsCache(getCachePath(), 'DATA', JSON.stringify(cache));
  } catch { /* no cache to bump */ }
}

/** Cache file writer: plugin dir is created if missing, output is atomic and 0o600. */
function writeCacheFile(filePath: string, content: string): void {
  try {
    fs.mkdirSync(pluginDir(), { recursive: true });
  } catch { /* ignore */ }
  writeFileSecure(filePath, content);
}

// ── Profile & credit grant caching ────────────────────────────────────────

interface ProfileData {
  orgUUID: string;
  rateLimitTier?: string;
  organizationType?: string;
}

function readProfileCache(now: number): ProfileData | null {
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
    if (now - cache.timestamp < CREDIT_GRANT_CACHE_TTL_MS) {
      return { hit: true, value: cache.creditGrant };
    }
    return null;
  } catch { return null; }
}

function writeCreditGrantCache(creditGrant: number | null, timestamp: number): void {
  const cache: CreditGrantCacheFile = { creditGrant, timestamp };
  writeJsCache(getCreditGrantCachePath(), 'CREDIT_GRANT', JSON.stringify(cache));
}

// ── Generic HTTPS JSON GET ────────────────────────────────────────────────

function fetchJson<T>(urlPath: string, accessToken: string): Promise<T | null> {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: urlPath,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'claude-quota/0.2',
      },
      minVersion: MIN_TLS_VERSION,
      timeout: API_TIMEOUT_MS,
    }, (res) => {
      void collectBody(req, res).then(({ body, overflowed }) => {
        if (overflowed || res.statusCode !== 200) { resolve(null); return; }
        try { resolve(JSON.parse(body) as T); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// ── Credit grant public API ───────────────────────────────────────────────

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

  // Need credentials for API calls
  const creds = readCredentials(now);
  if (!creds) return null;

  // Get org UUID (from cache or profile API)
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
  if (!grant || !grant.granted || grant.amount_minor_units == null) {
    writeCreditGrantCache(null, now);
    return null;
  }

  // Convert cents to dollars
  const dollars = grant.amount_minor_units / 100;
  writeCreditGrantCache(dollars, now);
  return dollars;
}

// ── Main ───────────────────────────────────────────────────────────────────

export async function getUsage(opts?: { forceRefresh?: boolean }): Promise<{ data: UsageData | null; isStale: boolean }> {
  const now = Date.now();

  // Derive plan name from profile cache (live API tier) → credentials (bootstrap fallback).
  // Profile API's organization.rate_limit_tier is the authoritative source; credential
  // rateLimitTier can be stale after plan upgrades until Claude Code refreshes the OAuth token.
  const livePlanName = (): string | null => {
    const profile = readProfileCache(now);
    if (profile?.rateLimitTier || profile?.organizationType) {
      const fromProfile = getPlanName(profile.organizationType ?? '', profile.rateLimitTier);
      if (fromProfile) return fromProfile;
    }
    const creds = readCredentials(now);
    return creds ? getPlanName(creds.subscriptionType, creds.rateLimitTier) : null;
  };

  // Check cache first — serve cached data regardless of env settings
  if (!opts?.forceRefresh) {
    const cached = readCache(now);
    if (cached) {
      // Always re-derive planName so plan changes are reflected immediately.
      const fresh = livePlanName();
      if (fresh) cached.data = { ...cached.data, planName: fresh };
      return cached;
    }
  }

  const none = { data: null, isStale: false } as const;

  // Skip fetching if using a non-Anthropic API endpoint
  const baseUrl = (process.env.ANTHROPIC_BASE_URL ?? process.env.ANTHROPIC_API_BASE_URL ?? '').trim();
  if (baseUrl) {
    try {
      if (new URL(baseUrl).origin !== 'https://api.anthropic.com') return none;
    } catch { return none; }
  }

  // Read credentials
  const creds = readCredentials(now);
  if (!creds) return none;

  const planName = livePlanName();
  if (!planName) return none; // API user

  // Bump cache timestamp to prevent parallel instances from also fetching
  bumpCacheTimestamp(now);

  // Fetch
  const result = await fetchApi(creds.accessToken);

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
      writeCache(failure, now, {
        rateLimitedCount: prevCount + 1,
        retryAfterUntil: result.retryAfterSec ? now + result.retryAfterSec * 1000 : undefined,
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
