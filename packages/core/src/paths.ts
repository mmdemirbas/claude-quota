import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Claude Code's configuration directory.
 *
 * `CLAUDE_CONFIG_DIR` is honoured because Claude Code honours it: the OAuth
 * credential that authorises a usage fetch lives under this root, so the root
 * is the account boundary. Two config directories mean two accounts, and their
 * usage must not land in one cache.
 */
export function configDir(): string {
  const env = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (env) return resolve(env);
  return join(homedir(), '.claude');
}

/**
 * The shared usage directory — the whole of the inter-process contract.
 *
 * Every participant derives this the same way and nobody needs to know which
 * other participants exist. See `docs/usage-cache-protocol.md` §1.
 */
export function usageDir(): string {
  return join(configDir(), 'usage');
}

/** The current entry: newest reading, last good reading, backoff state. */
export function usageCachePath(): string {
  return join(usageDir(), 'usage.json');
}

/** Append-only log of distinct successful readings. */
export function readingsPath(): string {
  return join(usageDir(), 'readings.jsonl');
}

/** Mutual exclusion for the upstream usage fetch. */
export function fetchLockPath(): string {
  return join(usageDir(), '.fetch.lock');
}

/**
 * Auxiliary caches. Not part of the published protocol (§8) — they hold a
 * label and a balance rather than a measurement — but they live in the same
 * directory so a second participant does not re-fetch them either.
 */
export function profileCachePath(): string {
  return join(usageDir(), 'profile.json');
}

export function profileLockPath(): string {
  return join(usageDir(), '.profile.lock');
}

export function creditGrantCachePath(): string {
  return join(usageDir(), 'credit-grant.json');
}

export function creditGrantLockPath(): string {
  return join(usageDir(), '.credit-grant.lock');
}

/** Debug dumps, written only when CLAUDE_USAGE_DEBUG / CLAUDE_QUOTA_DEBUG is set. */
export function debugPath(name: string): string {
  return join(usageDir(), name);
}

/**
 * Where claude-quota kept its cache before the shared directory existed.
 *
 * Read once, on the first run that finds no `usage.json`, so an upgrade does
 * not throw away a live backoff counter or the last good reading. Never
 * written. See `migrateLegacyCache` in cache.ts.
 */
export function legacyCachePath(): string {
  return join(configDir(), 'plugins', 'claude-quota', 'data.js');
}
