import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as https from 'node:https';
import type { UsageApiResponse, UsageData, ExtraUsageData, CacheFile, ApiError } from './types.js';
import { readCredentials, getPlanName } from './credentials.js';

const CACHE_TTL_MS = 5 * 60_000;           // 5 min hard TTL (force re-fetch)
const CACHE_SOFT_TTL_MS = 2 * 60_000;      // 2 min soft TTL (serve stale + background refresh)
const CACHE_FAILURE_TTL_MS = 15_000;        // 15s for failures
const CACHE_RATE_LIMITED_BASE_MS = 60_000;   // 60s base for 429 backoff
const CACHE_RATE_LIMITED_MAX_MS = 5 * 60_000;
const API_TIMEOUT_MS = 15_000;

function getPluginDir(): string {
  return path.join(os.homedir(), '.claude', 'plugins', 'claude-quota');
}

function getCachePath(): string {
  return path.join(getPluginDir(), '.usage-cache.json');
}

// ── Cache ──────────────────────────────────────────────────────────────────

function hydrateDates(data: UsageData): UsageData {
  const d = { ...data };
  if (d.fiveHourResetAt) d.fiveHourResetAt = new Date(d.fiveHourResetAt);
  if (d.sevenDayResetAt) d.sevenDayResetAt = new Date(d.sevenDayResetAt);
  if (d.sonnetResetAt) d.sonnetResetAt = new Date(d.sonnetResetAt);
  if (d.opusResetAt) d.opusResetAt = new Date(d.opusResetAt);
  return d;
}

function readCache(now: number): { data: UsageData; isStale: boolean } | null {
  try {
    const raw = fs.readFileSync(getCachePath(), 'utf8');
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
        return { data: display, isStale: false };
      }
      // Backoff expired — fetch fresh regardless of failure TTL
      return null;
    }

    const ttl = cache.data.apiUnavailable ? CACHE_FAILURE_TTL_MS : CACHE_TTL_MS;
    const age = now - cache.timestamp;
    if (age < ttl) {
      const display = (cache.data.apiError === 'rate-limited' && cache.lastGoodData)
        ? { ...hydrateDates(cache.lastGoodData), apiError: 'rate-limited' as const }
        : hydrateDates(cache.data);
      // Only mark stale for successful responses; failures have a short TTL already
      const isStale = !cache.data.apiUnavailable && age >= CACHE_SOFT_TTL_MS;
      return { data: display, isStale };
    }

    return null;
  } catch {
    return null;
  }
}

function writeCache(data: UsageData, timestamp: number, opts?: Partial<CacheFile>): void {
  try {
    const dir = getPluginDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const cache: CacheFile = { data, timestamp, ...opts };
    fs.writeFileSync(getCachePath(), JSON.stringify(cache), 'utf8');
  } catch { /* ignore */ }
}

// ── API ────────────────────────────────────────────────────────────────────

const MAX_RESPONSE_BODY = 1_048_576; // 1 MB guard

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
      timeout: API_TIMEOUT_MS,
    }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => {
        if (body.length < MAX_RESPONSE_BODY) body += c.toString();
      });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          const code = res.statusCode ?? 0;
          const error: ApiError = code === 429 ? 'rate-limited' : `http-${code}`;
          const retryRaw = res.headers['retry-after'];
          const retryVal = Array.isArray(retryRaw) ? retryRaw[0] : retryRaw;
          const retryAfterSec = retryVal ? parseInt(retryVal, 10) || undefined : undefined;
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

/** Exported for testing. */
export function parseExtraUsage(raw: UsageApiResponse['extra_usage']): ExtraUsageData | null {
  if (raw == null) return null; // API didn't return extra_usage at all
  if (!raw.is_enabled) return { enabled: false, monthlyLimit: 0, usedCredits: 0 };
  if (!raw.monthly_limit) return null; // enabled but no limit — avoid $0/$0 display
  // API returns values in cents; convert to dollars for display
  return {
    enabled: true,
    monthlyLimit: raw.monthly_limit / 100,
    usedCredits: (raw.used_credits ?? 0) / 100,
  };
}

// ── Main ───────────────────────────────────────────────────────────────────

export async function getUsage(opts?: { forceRefresh?: boolean }): Promise<{ data: UsageData | null; isStale: boolean }> {
  const now = Date.now();

  // Check cache first — serve cached data regardless of env settings
  if (!opts?.forceRefresh) {
    const cached = readCache(now);
    if (cached) return cached;
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

  const planName = getPlanName(creds.subscriptionType, creds.rateLimitTier);
  if (!planName) return none; // API user

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

    if (isRateLimit) {
      // Recover last good data and preserve backoff state across invocations
      let prevCount = 0;
      let lastGoodData: UsageData | undefined;
      try {
        const raw = fs.readFileSync(getCachePath(), 'utf8');
        const prev: CacheFile = JSON.parse(raw);
        prevCount = prev.rateLimitedCount ?? 0;
        lastGoodData = prev.lastGoodData ?? (!prev.data.apiUnavailable ? prev.data : undefined);
      } catch { /* no prior cache — first rate-limit */ }
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

    writeCache(failure, now);
    return { data: failure, isStale: false };
  }

  // Parse full response
  const usage: UsageData = {
    planName,
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
