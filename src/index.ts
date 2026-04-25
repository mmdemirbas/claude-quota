#!/usr/bin/env node
import { readStdin } from './stdin.js';
import { getUsage, getCreditGrant, bumpCacheTimestamp } from './usage.js';
import { getGitStatus } from './git.js';
import { render } from './render.js';
import { terminalDims } from './terminal.js';
import { ensureDashboardHtml } from './dashboard.js';
import { writeFileSecure } from './secure-fs.js';
import { warn } from './log.js';
import { fileURLToPath } from 'node:url';
import { realpathSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';

const DEBUG = process.env.CLAUDE_QUOTA_DEBUG === '1';

/**
 * Persist a debug snapshot under the plugin dir. Contents can include
 * stdin context (cwd, transcript_path) which is not a secret but leaks
 * user activity if another local user can read the file. Goes through
 * writeFileSecure so the dump lands with mode 0o600.
 */
function debugDump(filename: string, data: unknown): void {
  if (!DEBUG) return;
  try {
    const dir = join(homedir(), '.claude', 'plugins', 'claude-quota');
    mkdirSync(dir, { recursive: true });
    writeFileSecure(join(dir, filename), JSON.stringify(data, null, 2));
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

    const [{ data: usage, isStale }, git, creditGrant] = await Promise.all([
      getUsage(),
      stdin.cwd ? Promise.resolve(getGitStatus(stdin.cwd)) : Promise.resolve(null),
      getCreditGrant(),
    ]);

    // Merge credit grant into extra usage data
    if (usage?.extraUsage && creditGrant !== null) {
      usage.extraUsage = { ...usage.extraUsage, creditGrant };
    }

    if (isStale) {
      // Bump before spawning so a third parallel instance landing between
      // here and the child's own bump sees a fresh-looking cache and skips
      // the redundant refresh. The child still bumps inside getUsage —
      // double-bump is cheap (a single small file write).
      bumpCacheTimestamp();
      spawnBackgroundRefresh(scriptPath);
    }

    const { columns, rows } = terminalDims(stdin);
    render({ stdin, usage, git, columns, rows });

    // Ensure the dashboard HTML shell exists (data.js is written by usage.ts)
    ensureDashboardHtml();
  } catch (error) {
    // stdout IS the statusline — error text here would render literally
    // in Claude Code. Send to stderr so the terminal (not the statusline)
    // surfaces the failure.
    const msg = error instanceof Error ? error.message : 'Unknown error';
    warn('render failed', { msg });
  }
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
    // Background refresh: update cache silently, no render
    void getUsage({ forceRefresh: true });
  } else {
    void main();
  }
}

export { main };
