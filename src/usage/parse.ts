import type { ExtraUsageData, UsageApiResponse, UsageData } from '../types.js';
import {
  CACHE_RATE_LIMITED_BASE_MS,
  CACHE_RATE_LIMITED_JITTER,
  CACHE_RATE_LIMITED_MAX_MS,
} from './constants.js';

/**
 * Coerce a JSON-deserialized date value (string from the on-disk cache,
 * or already-a-Date if hydrateDates is called twice) back to a Date.
 * Returns null on a malformed or non-parseable value so the renderer
 * never sees an Invalid Date — that previously leaked NaN/undefined into
 * the bar/glyph rendering.
 */
export function rehydrateDate(v: unknown): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

export function hydrateDates(data: UsageData): UsageData {
  return {
    ...data,
    fiveHourResetAt: rehydrateDate(data.fiveHourResetAt),
    sevenDayResetAt: rehydrateDate(data.sevenDayResetAt),
    sonnetResetAt: rehydrateDate(data.sonnetResetAt),
    opusResetAt: rehydrateDate(data.opusResetAt),
    designResetAt: rehydrateDate(data.designResetAt),
    routinesResetAt: rehydrateDate(data.routinesResetAt),
    codeResetAt: rehydrateDate(data.codeResetAt),
  };
}

/**
 * 429 backoff with multiplicative jitter.
 *
 * Without jitter, every instance with the same `rateLimitedCount`
 * computes the same retry boundary — they wake up together, fetch
 * together, and re-trigger the same 429 in lockstep. Multiplying the
 * deterministic backoff by a uniform value in [1 - J, 1 + J] keeps
 * concurrent retriers desynchronised.
 */
export function jitteredBackoff(rateLimitedCount: number, rng: () => number = Math.random): number {
  const exp = Math.pow(2, Math.max(0, rateLimitedCount - 1));
  const base = Math.min(CACHE_RATE_LIMITED_BASE_MS * exp, CACHE_RATE_LIMITED_MAX_MS);
  const factor = 1 + (rng() * 2 - 1) * CACHE_RATE_LIMITED_JITTER;
  return Math.round(base * factor);
}

/**
 * Clamp API utilization to integer 0-100.
 * The API returns values in the 0-100 range (not 0-1).
 */
export function clamp(v: number | undefined | null): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  return Math.round(Math.max(0, Math.min(100, v)));
}

/**
 * Parse a `Retry-After` header value (RFC 7231 §7.1.3).
 *
 * Two accepted formats:
 *   - delta-seconds   →   "120"
 *   - HTTP-date       →   "Wed, 21 Oct 2026 07:28:00 GMT"
 *
 * Returns the delay in seconds (rounded to integer, never negative)
 * or undefined for missing/malformed values.
 */
export function parseRetryAfter(raw: string | undefined, now: number): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  // Integer-seconds form. Reject non-numeric strings explicitly so
  // "Wed, 21 Oct 2026..." doesn't parse as 0 via parseInt's prefix
  // tolerance — it would, since "21" is a valid prefix of "21 Oct".
  if (/^\d+$/.test(trimmed)) {
    const sec = parseInt(trimmed, 10);
    return Number.isFinite(sec) ? sec : undefined;
  }

  // HTTP-date form. Date.parse handles RFC 1123 / RFC 850 / asctime
  // shapes. Convert to seconds-from-now, clamped to ≥ 0 (a date in
  // the past means "you can retry now").
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(0, Math.round((parsed - now) / 1000));
}

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

export function parseExtraUsage(raw: UsageApiResponse['extra_usage']): ExtraUsageData | null {
  if (raw == null) return null; // API didn't return extra_usage at all
  if (!raw.is_enabled) return { enabled: false };

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
