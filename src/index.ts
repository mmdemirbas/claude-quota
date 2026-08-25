#!/usr/bin/env node
import { readStdin } from './stdin.js';
import {
  getUsage,
  getCreditGrant,
  ensureProfileCached,
  isFetchLockHeld,
  writeFileSecure,
  warn,
} from '@mmdemirbas/claude-usage';
import { getGitStatus } from './git.js';
import { render } from './render.js';
import { terminalDims } from './terminal.js';
import { ensureDashboardHtml } from './dashboard.js';
import { writeDashboardData, writeDashboardCreditGrant } from './dashboard-data.js';
import { pluginDir } from './paths.js';
import { fileURLToPath } from 'node:url';
import { realpathSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const DEBUG = process.env.CLAUDE_QUOTA_DEBUG === '1';

/**
 * Persist a debug snapshot under the plugin dir. Contents can include stdin
 * context (cwd, transcript_path) which is not a secret but leaks user activity
 * if another local user can read the file. Goes through writeFileSecure so the
 * dump lands with mode 0o600.
 */
function debugDump(filename: string, data: unknown): void {
  if (!DEBUG) return;
  try {
    mkdirSync(pluginDir(), { recursive: true });
    writeFileSecure(join(pluginDir(), filename), JSON.stringify(data, null, 2));
  } catch { /* ignore */ }
}

function spawnBackgroundRefresh(scriptPath: string): void {
  try {
    const child = spawn(process.execPath, [scriptPath, '--background'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch { /* ignore */ }
}

async function main(): Promise<void> {
  try {
    const stdin = await readStdin();
    debugDump('.debug-stdin.json', stdin);

    if (!stdin) {
      console.log('[claude-quota] Ready. Restart Claude Code to activate.');
      return;
    }

    // Warm the profile cache before getUsage / getCreditGrant fan out. Fast on
    // a hit; one /api/oauth/profile round trip a day on a miss. Pays back by
    // letting the first render after a fresh install show the live API tier
    // rather than a name derived from a stale credential.
    await ensureProfileCached();

    const [usage, git, creditGrant] = await Promise.all([
      getUsage(),
      stdin.cwd ? Promise.resolve(getGitStatus(stdin.cwd)) : Promise.resolve(null),
      getCreditGrant(),
    ]);

    // Merge the credit grant into extra usage — only meaningful when extras
    // are actually enabled; the disabled variant is just a flag. `known` is
    // what matters: an unknown balance must not be rendered as "no balance".
    if (usage.data?.extraUsage?.enabled && creditGrant.known && creditGrant.value !== null) {
      usage.data.extraUsage = { ...usage.data.extraUsage, creditGrant: creditGrant.value };
    }

    if (usage.isStale && !isFetchLockHeld()) {
      // A spawn is only useful when no fetch is in flight: a child that loses
      // the lock exits without fetching, so the process cost buys nothing.
      //
      // This deliberately does not bump the entry first. Bumping here is a
      // read-modify-write performed *without* the fetch lock, and the check
      // above is a TOCTOU: a peer can acquire, fetch and write in the window,
      // and the bump then replaces that fresh reading with the older one under
      // a new timestamp — protected, for the next two minutes, by a TTL it did
      // not earn. Suppressing a few redundant spawns is not worth regressing
      // the cache; the child bumps properly, under the lock.
      spawnBackgroundRefresh(scriptPath);
    }

    const { columns, rows } = terminalDims(stdin);
    render({ stdin, usage: usage.data, git, columns, rows });

    // Republish the dashboard's derived data + shell so a browser reload shows
    // what this render showed.
    writeDashboardData(usage.data);
    // Only republish a balance we actually learned. Writing an unknown as null
    // blanked a real balance on the dashboard whenever a second window happened
    // to hold the credit-grant lock.
    if (creditGrant.known) writeDashboardCreditGrant(creditGrant.value);
    ensureDashboardHtml();
  } catch (error) {
    // stdout IS the statusline — error text here renders literally in Claude
    // Code. Send it to stderr so the terminal surfaces the failure instead.
    const msg = error instanceof Error ? error.message : 'Unknown error';
    warn('render failed', { msg });
  }
}

/**
 * Refresh the shared cache and exit. No stdin, no render.
 *
 * This is what makes the statusline a *participant* rather than an owner: any
 * other program can trigger the same refresh by calling getUsage itself, and
 * this path exists only so a terminal redraw can hand the work to a detached
 * child instead of blocking the draw on a network round trip.
 */
async function background(): Promise<void> {
  const usage = await getUsage({ forceRefresh: true });
  const creditGrant = await getCreditGrant();
  writeDashboardData(usage.data);
  if (creditGrant.known) writeDashboardCreditGrant(creditGrant.value);
}

// Run when executed directly
const scriptPath = fileURLToPath(import.meta.url);
const argvPath = process.argv[1];
const isSame = (a: string, b: string): boolean => {
  try { return realpathSync(a) === realpathSync(b); }
  catch { return a === b; }
};
if (argvPath && isSame(argvPath, scriptPath)) {
  if (process.argv.includes('--background')) {
    void background();
  } else {
    void main();
  }
}

export { main };
