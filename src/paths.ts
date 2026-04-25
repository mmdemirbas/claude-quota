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
 * Path components are percent-encoded so a homedir containing spaces
 * or other reserved characters produces a valid URL (terminals and
 * browsers reject `file:///My Folder/...` as malformed). The URL
 * constructor handles the encoding correctly without disturbing legal
 * path separators.
 */
export function dashboardFileUrl(): string {
  return new URL(`file://${dashboardHtmlPath()}`).toString();
}
