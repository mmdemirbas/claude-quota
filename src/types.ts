/** JSON structure Claude Code sends on stdin */
export interface StdinData {
  model?: { display_name?: string };
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
  /** Extra usage info */
  extraUsage: ExtraUsageData | null;
  /** API error state */
  apiUnavailable?: boolean;
  apiError?: ApiError;
}

export interface ExtraUsageData {
  enabled: boolean;
  monthlyLimit: number;
  usedCredits: number;
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
