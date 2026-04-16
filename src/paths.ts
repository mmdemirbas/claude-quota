import { homedir } from 'node:os';
import { join } from 'node:path';

/** Directory under the user's home that holds caches + the dashboard. */
export function pluginDir(): string {
  return join(homedir(), '.claude', 'plugins', 'claude-quota');
}

/** Absolute path to the dashboard HTML file. */
export function dashboardHtmlPath(): string {
  return join(pluginDir(), 'dashboard.html');
}

/**
 * `file://` URL pointing at the dashboard HTML file, suitable for an
 * OSC 8 hyperlink in the statusline or a plain click target in docs.
 *
 * Avoids any path normalization: the URL points at the exact path the
 * plugin writes to, so clicking it opens the live file even if the
 * user's shell has a different cwd.
 */
export function dashboardFileUrl(): string {
  return `file://${dashboardHtmlPath()}`;
}
