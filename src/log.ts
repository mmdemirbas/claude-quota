/**
 * Emit a single-line warning to stderr for security-relevant events.
 *
 * Used for auth/keychain/cache-permission anomalies that a user or
 * administrator should be able to notice without turning on debug mode.
 * Never include secrets in `context` — this lands on the terminal.
 *
 * Silenced when CLAUDE_QUOTA_SILENT=1 so automated/batch callers can
 * opt out without code changes.
 */
export function warn(event: string, context?: Record<string, string | number>): void {
  if (process.env['CLAUDE_QUOTA_SILENT'] === '1') return;
  const parts: string[] = [`[claude-quota] ${event}`];
  if (context) {
    for (const [k, v] of Object.entries(context)) {
      parts.push(`${k}=${v}`);
    }
  }
  try {
    process.stderr.write(parts.join(' ') + '\n');
  } catch { /* ignore */ }
}
