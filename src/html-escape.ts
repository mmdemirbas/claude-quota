/**
 * NOTE: this module has no production caller.
 *
 * The dashboard is a generated page whose escaping runs in the *browser*, so
 * it carries its own `_esc` inside the emitted script and cannot import from
 * here. This function therefore covers nothing at runtime; it and its tests
 * document the escape set that `_esc` is expected to match. Keep the two in
 * step, or delete both — what must not happen is reading this file and
 * concluding the server-side interpolation path is covered by it.
 *
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
