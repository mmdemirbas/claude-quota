/** JSON structure Claude Code sends on stdin */
export interface StdinData {
  model?: { display_name?: string };
  effort_level?: string;  // snake_case variant
  effortLevel?: string;   // camelCase variant
  effort?: string;        // no-underscore variant
  context_window?: {
    current_usage?: {
      input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      output_tokens?: number;
    };
    context_window_size?: number;
  };
  cwd?: string;
  transcript_path?: string;
  /** Terminal width in columns — may be provided by Claude Code in a future version. */
  columns?: number;
  /** Terminal height in rows — may be provided by Claude Code in a future version. */
  rows?: number;
}

/** Full usage API response from api.anthropic.com/api/oauth/usage */
export interface UsageApiResponse {
  five_hour?: { utilization?: number; resets_at?: string };
  seven_day?: { utilization?: number; resets_at?: string };
  seven_day_sonnet?: { utilization?: number; resets_at?: string };
  seven_day_opus?: { utilization?: number; resets_at?: string };
  seven_day_oauth_apps?: { utilization?: number; resets_at?: string } | null;
  seven_day_cowork?: { utilization?: number; resets_at?: string } | null;
  extra_usage?: {
    is_enabled?: boolean;
    monthly_limit?: number;
    used_credits?: number;
    utilization?: number | null;
  };
}

export type ApiError = 'rate-limited' | 'network' | 'timeout' | 'parse' | `http-${number}`;

/** Parsed usage data for rendering */
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
  /** Extra usage info */
  extraUsage: ExtraUsageData | null;
  /** API error state */
  apiUnavailable?: boolean;
  apiError?: ApiError;
  /** Unix ms when this data was fetched from the API (or loaded from cache). */
  fetchedAt?: number;
}

/**
 * Discriminated on `enabled` so the disabled state cannot accidentally
 * carry zero values that a caller might divide. The renderer narrows
 * via `if (extra.enabled) { … }` before reading the numeric fields.
 */
export type ExtraUsageData =
  | { enabled: false }
  | {
      enabled: true;
      monthlyLimit: number;
      usedCredits: number;
      /** Total prepaid credit grant in dollars. null when unknown. */
      creditGrant: number | null;
    };

/** Profile API response from /api/oauth/profile */
export interface ProfileApiResponse {
  organization?: {
    uuid?: string;
    organization_type?: string;
    rate_limit_tier?: string;
  };
}

/** Credit grant API response from /api/oauth/organizations/{orgUUID}/overage_credit_grant */
export interface CreditGrantApiResponse {
  available?: boolean;
  granted?: boolean;
  amount_minor_units?: number;
  currency?: string;
}

/** File-based profile cache */
export interface ProfileCacheFile {
  orgUUID: string;
  /** Live rate_limit_tier from profile API (e.g. "default_claude_max_20x") */
  rateLimitTier?: string;
  /** Live organization_type from profile API (e.g. "claude_max") */
  organizationType?: string;
  timestamp: number;
}

/** File-based credit grant cache */
export interface CreditGrantCacheFile {
  /** Credit grant in dollars (null if unavailable) */
  creditGrant: number | null;
  timestamp: number;
}

/** File-based cache entry */
export interface CacheFile {
  data: UsageData;
  timestamp: number;
  rateLimitedCount?: number;
  retryAfterUntil?: number;
  lastGoodData?: UsageData;
}

export interface GitStatus {
  branch: string;
  isDirty: boolean;
}
