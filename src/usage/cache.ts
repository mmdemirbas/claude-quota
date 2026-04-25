import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CacheFile, UsageData } from '../types.js';
import { readFileSecure, writeFileSecure } from '../secure-fs.js';
import { pluginDir, CACHE_VAR_DATA, CACHE_FILE_DATA } from '../paths.js';
import { warn } from '../log.js';
import {
  CACHE_TTL_MS,
  CACHE_SOFT_TTL_MS,
  CACHE_FAILURE_TTL_MS,
  CACHE_RATE_LIMITED_BASE_MS,
  CACHE_RATE_LIMITED_MAX_MS,
} from './constants.js';
import { hydrateDates } from './parse.js';

export function getCachePath(): string {
  return path.join(pluginDir(), CACHE_FILE_DATA);
}

/**
 * Read JSON from a .js file that wraps it as `var NAME=<json>;`.
 *
 * Goes through readFileSecure so a world-writable or non-owned cache
 * file (e.g., planted by another local user) is refused — we will treat
 * the cache as missing and re-fetch rather than serve attacker data
 * into render/dashboard code paths.
 */
export function readJsCache(filePath: string): string | null {
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
export function writeJsCache(filePath: string, varName: string, json: string): void {
  writeCacheFile(filePath, `var ${varName}=${json};`);
}

/** Cache file writer: plugin dir is created if missing, output is atomic and 0o600. */
export function writeCacheFile(filePath: string, content: string): void {
  try {
    fs.mkdirSync(pluginDir(), { recursive: true });
  } catch { /* ignore */ }
  writeFileSecure(filePath, content);
}

export function readCache(now: number): { data: UsageData; isStale: boolean } | null {
  try {
    const raw = readJsCache(getCachePath());
    if (!raw) return null;
    const cache: CacheFile = JSON.parse(raw);

    // Handle rate-limit backoff
    if (cache.data.apiError === 'rate-limited' && cache.rateLimitedCount) {
      // retryAfterUntil is preferred — set either from the server's
      // Retry-After header or as a jittered count-derived backoff at
      // write time. The fallback below covers caches written before the
      // jitter migration and stays bounded by CACHE_RATE_LIMITED_MAX_MS.
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
      // No fetcher-death detection here: the .fetch.lock file's stale-
      // reclaim covers that. If a fetcher died mid-flight, the next
      // acquireFetchLock caller picks up the lock after FETCH_COORDINATION_MS
      // and re-fetches; this read path just serves the (slightly stale)
      // cache until then.
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

export function writeCache(data: UsageData, timestamp: number, opts?: Partial<CacheFile>): void {
  const cache: CacheFile = { data, timestamp, ...opts };
  writeJsCache(getCachePath(), CACHE_VAR_DATA, JSON.stringify(cache));
}
