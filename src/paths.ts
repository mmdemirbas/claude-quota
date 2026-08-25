import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { configDir } from '@mmdemirbas/claude-usage';

/** Directory under the user's home that holds caches + the dashboard. */
export function pluginDir(): string {
  // configDir(), not homedir(): CLAUDE_CONFIG_DIR is how a second account is
  // configured, and this directory holds that account's dashboard, its data.js
  // and its debug dumps. Hardcoding the home directory made two accounts write
  // one shared dashboard, and pointed the legacy-cache migration at a path the
  // plugin never wrote under a custom config dir — so the upgrade path was dead
  // exactly where it was needed.
  return join(configDir(), 'plugins', 'claude-quota');
}

// ── Cache-file ABI ────────────────────────────────────────────────────────
//
// data.js and credit-grant.js are loaded by the dashboard HTML as
// <script src>; each file assigns to a global variable that the
// renderer reads. usage.ts writes the files using the same names;
// dashboard.ts interpolates these constants into the loader script.
//
// The dashboard's renderer JS (dashboard.ts JS block) references the
// global names DATA and CREDIT_GRANT *literally* — a renderer rewrite
// would be needed to change either constant. Treat these as a frozen
// internal ABI; paths.test.ts pins the values so a stealth rename is
// caught at test time.
export const CACHE_VAR_DATA = 'DATA';
export const CACHE_VAR_CREDIT_GRANT = 'CREDIT_GRANT';
export const CACHE_FILE_DATA = 'data.js';
export const CACHE_FILE_CREDIT_GRANT = 'credit-grant.js';

/** Absolute path to the dashboard HTML file. */
export function dashboardHtmlPath(): string {
  return join(pluginDir(), 'dashboard.html');
}

/**
 * `file://` URL pointing at the dashboard HTML file, suitable for an
 * OSC 8 hyperlink in the statusline or a plain click target in docs.
 *
 * Path components are percent-encoded so a homedir containing spaces
 * or other reserved characters produces a valid URL (terminals and
 * browsers reject `file:///My Folder/...` as malformed). The URL
 * constructor handles the encoding correctly without disturbing legal
 * path separators.
 */
export function dashboardFileUrl(): string {
  // pathToFileURL, not string interpolation. `new URL(\`file://${path}\`)` reads
  // a `#` in the path as a fragment and a `?` as a query, so a home directory
  // called `/Users/a#b` produced a URL pointing at `/Users/a`, and a `%` made
  // the URL fail to decode at all. pathToFileURL percent-escapes all three.
  return pathToFileURL(dashboardHtmlPath()).toString();
}
