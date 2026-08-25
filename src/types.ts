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

// Everything about usage measurement now lives in the shared package: the
// on-disk protocol, the fetch, the coordination. Re-exported here so the
// renderer keeps importing its types from one place.
export type {
  ApiError,
  CreditGrantApiResponse,
  ExtraUsageData,
  ProfileApiResponse,
  UsageApiResponse,
  UsageData,
  UsageResult,
} from '@mmdemirbas/claude-usage';

export interface GitStatus {
  branch: string;
  isDirty: boolean;
}
