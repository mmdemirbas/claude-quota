/**
 * HTML-escape a string for safe interpolation into dashboard markup.
 *
 * Used for any value that originates outside the codebase (OAuth API
 * responses, credentials file, cached profile data) before it is
 * concatenated into an HTML string in the dashboard. A compromised API
 * response or poisoned cache file could otherwise inject arbitrary
 * scripts when the user opens dashboard.html.
 *
 * Mirrors the client-side `_esc` helper inlined in dashboard.ts so both
 * sides apply identical escaping. Any change to one must be mirrored
 * in the other; the html-escape.test.ts suite pins both.
 */
export function escapeHtml(s: unknown): string {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
