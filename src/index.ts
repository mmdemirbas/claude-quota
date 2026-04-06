#!/usr/bin/env node
import { readStdin } from './stdin.js';
import { getUsage, getCreditGrant } from './usage.js';
import { getGitStatus } from './git.js';
import { render } from './render.js';
import { terminalDims } from './terminal.js';
import { buildDashboardData, generateDashboardHtml } from './dashboard.js';
import { fileURLToPath } from 'node:url';
import { realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';

const DEBUG = process.env.CLAUDE_QUOTA_DEBUG === '1';

function debugDump(filename: string, data: unknown): void {
  if (!DEBUG) return;
  try {
    const dir = join(homedir(), '.claude', 'plugins', 'claude-quota');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, filename), JSON.stringify(data, null, 2), 'utf8');
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

    if (isStale) spawnBackgroundRefresh(scriptPath);

    const { columns, rows } = terminalDims(stdin);
    render({ stdin, usage, git, columns, rows });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.log(`[claude-quota] Error: ${msg}`);
  }
}

// Run when executed directly
const scriptPath = fileURLToPath(import.meta.url);
const argvPath = process.argv[1];
const isSame = (a: string, b: string): boolean => {
  try { return realpathSync(a) === realpathSync(b); }
  catch { return a === b; }
};
async function dashboard(): Promise<void> {
  const [{ data: usage }, creditGrant] = await Promise.all([
    getUsage({ forceRefresh: true }),
    getCreditGrant(),
  ]);

  if (!usage) {
    console.error('[claude-quota] No usage data available.');
    process.exitCode = 1;
    return;
  }

  // Merge credit grant
  if (usage.extraUsage && creditGrant !== null) {
    usage.extraUsage = { ...usage.extraUsage, creditGrant };
  }

  const data = buildDashboardData(usage, creditGrant);
  const html = generateDashboardHtml(data);

  // Write to plugin dir so the file persists for reloading
  const dir = join(homedir(), '.claude', 'plugins', 'claude-quota');
  mkdirSync(dir, { recursive: true });
  const htmlPath = join(dir, 'dashboard.html');
  writeFileSync(htmlPath, html, 'utf8');

  // Open in default browser
  try {
    if (process.platform === 'darwin') {
      execFileSync('open', [htmlPath], { stdio: 'ignore' });
    } else if (process.platform === 'linux') {
      spawn('xdg-open', [htmlPath], { detached: true, stdio: 'ignore' }).unref();
    } else {
      // Windows or unknown — just print the path
      console.log(htmlPath);
      return;
    }
    console.log(`Dashboard opened: ${htmlPath}`);
  } catch {
    console.log(`Dashboard written to: ${htmlPath}`);
  }
}

if (argvPath && isSame(argvPath, scriptPath)) {
  if (process.argv.includes('--dashboard')) {
    void dashboard();
  } else if (process.argv.includes('--background')) {
    // Background refresh: update cache silently, no render
    void getUsage({ forceRefresh: true });
  } else {
    void main();
  }
}

export { main };
