/**
 * Types for the usage cache protocol, version 1.
 *
 * Two shapes matter and they are deliberately different:
 *
 *   - `Reading` / `CacheEntry` are the **on-disk** shapes. JSON-native: no Date
 *     objects, ISO strings for instants, an open map for quota buckets. These
 *     are the contract with any other program on the machine, so they change
 *     only with a schema version bump.
 *
 *   - `UsageData` is the **in-memory** shape callers render from. Flat, with
 *     real Dates. It may be reshaped freely; nothing outside this process
 *     depends on it.
 *
 * The mapping between them lives in cache.ts and nowhere else.
 */

/** Raw response from `GET /api/oauth/usage`. */
export interface UsageApiResponse {
  five_hour?: { utilization?: number; resets_at?: string };
  seven_day?: { utilization?: number; resets_at?: string };
  seven_day_sonnet?: { utilization?: number; resets_at?: string };
  seven_day_opus?: { utilization?: number; resets_at?: string };
  seven_day_oauth_apps?: { utilization?: number; resets_at?: string } | null;
  seven_day_cowork?: { utilization?: number; resets_at?: string } | null;
  seven_day_omelette?: { utilization?: number; resets_at?: string } | null;
  extra_usage?: {
    is_enabled?: boolean;
    monthly_limit?: number;
    used_credits?: number;
    utilization?: number | null;
  };
}

export type ApiError = 'rate-limited' | 'network' | 'timeout' | 'parse' | `http-${number}`;

/** Current schema version of `usage.json`. Protocol §7. */
export const SCHEMA_VERSION = 1;

/**
 * Quota bucket keys defined by version 1 of the protocol.
 *
 * Anthropic ships new buckets under internal codenames without notice, which
 * is why the on-disk `buckets` field is an open map rather than a fixed record:
 * a newer participant can write a bucket an older one has never heard of, the
 * older one ignores it, and the file keeps it.
 */
export const BUCKET_KEYS = [
  'fiveHour',
  'sevenDay',
  'sevenDaySonnet',
  'sevenDayOpus',
  'sevenDayDesign',
  'sevenDayRoutines',
  'sevenDayCode',
] as const;

export type BucketKey = (typeof BUCKET_KEYS)[number];

/** Window length in ms for each bucket, for callers placing a reading on a timeline. */
export const BUCKET_WINDOW_MS: Record<BucketKey, number> = {
  fiveHour: 5 * 60 * 60_000,
  sevenDay: 7 * 24 * 60 * 60_000,
  sevenDaySonnet: 7 * 24 * 60 * 60_000,
  sevenDayOpus: 7 * 24 * 60 * 60_000,
  sevenDayDesign: 7 * 24 * 60 * 60_000,
  sevenDayRoutines: 7 * 24 * 60 * 60_000,
  sevenDayCode: 7 * 24 * 60 * 60_000,
};

/** One quota bucket as stored on disk. */
export interface BucketReading {
  /** Integer 0-100. */
  utilization: number | null;
  /** ISO 8601 instant, or null when the API omitted it. */
  resetsAt: string | null;
}

/** Extra-usage state. Dollars, not the API's minor units. */
export type ExtraUsageData =
  | { enabled: false }
  | {
      enabled: true;
      monthlyLimit: number;
      usedCredits: number;
      /** Total prepaid credit grant in dollars. null when unknown. */
      creditGrant: number | null;
    };

/** A single measurement, as stored in `usage.json` and `readings.jsonl`. */
export interface Reading {
  /** Unix ms at which the API answered. */
  fetchedAt: number;
  planName: string | null;
  /** Open map — unknown keys are preserved, never dropped. */
  buckets: Record<string, BucketReading | null>;
  extraUsage: ExtraUsageData | null;
  /** null on success. */
  error: ApiError | null;
}

/** The whole of `usage.json`. */
export interface CacheEntry {
  schemaVersion: number;
  /** Unix ms. Not always `reading.fetchedAt` — see the bump-before-fetch rule. */
  timestamp: number;
  reading: Reading | null;
  lastGood: Reading | null;
  backoff: {
    rateLimitedCount: number;
    retryAfterUntil: number | null;
  };
  /** Anything a newer participant wrote that this one does not understand. */
  [unknown: string]: unknown;
}

/** In-memory shape callers render from. Flat, with real Dates. */
export interface UsageData {
  planName: string;
  /** 5-hour session utilization 0-100 */
  fiveHour: number | null;
  fiveHourResetAt: Date | null;
  /** 7-day all-models utilization 0-100 */
  sevenDay: number | null;
  sevenDayResetAt: Date | null;
  /** 7-day sonnet-only utilization 0-100 */
  sonnet: number | null;
  sonnetResetAt: Date | null;
  /** 7-day opus-only utilization 0-100 */
  opus: number | null;
  opusResetAt: Date | null;
  /** 7-day Claude Design (cowork) utilization 0-100 */
  design: number | null;
  designResetAt: Date | null;
  /** 7-day Claude Routines (oauth apps) utilization 0-100 */
  routines: number | null;
  routinesResetAt: Date | null;
  /** 7-day Claude Code (omelette) utilization 0-100 */
  code: number | null;
  codeResetAt: Date | null;
  extraUsage: ExtraUsageData | null;
  apiUnavailable?: boolean;
  apiError?: ApiError;
  /** Unix ms when this data was fetched from the API (or loaded from cache). */
  fetchedAt?: number;
  /**
   * Buckets exactly as stored, including any this build has no flat field for.
   * Present so a caller can iterate everything the file holds without waiting
   * for a release that names the newest codename.
   */
  buckets?: Record<string, BucketReading | null>;
}

/** Profile API response from `/api/oauth/profile`. */
export interface ProfileApiResponse {
  organization?: {
    uuid?: string;
    organization_type?: string;
    rate_limit_tier?: string;
  };
}

/** Credit grant API response. */
export interface CreditGrantApiResponse {
  available?: boolean;
  granted?: boolean;
  amount_minor_units?: number;
  currency?: string;
}

export interface ProfileCacheFile {
  /** Cache-shape marker. Present means the tier fields were stored deliberately. */
  v?: number;
  orgUUID: string;
  rateLimitTier?: string;
  organizationType?: string;
  timestamp: number;
}

export interface CreditGrantCacheFile {
  /** Credit grant in dollars (null if unavailable). */
  creditGrant: number | null;
  timestamp: number;
}

/** What `getUsage` and `readCachedUsage` resolve to. */
export interface UsageResult {
  data: UsageData | null;
  /** Past the soft TTL: worth serving, worth refreshing soon. */
  isStale: boolean;
  /**
   * Where the answer came from. `peer` means another process held the fetch
   * lock, so this call deliberately did not hit the API.
   */
  source: 'cache' | 'fetch' | 'peer' | 'backoff' | 'none';
}
