import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { CacheFile } from '../types.js';
import { pluginDir, CACHE_VAR_DATA } from '../paths.js';
import { FETCH_COORDINATION_MS } from './constants.js';
import { getCachePath, readJsCache, writeJsCache } from './cache.js';

// ── Fetch lock ──────────────────────────────────────────────────────────────
//
// The bump-then-fetch coordination is best-effort: two instances that race
// past readCache within the same millisecond both see the un-bumped cache
// and both fetch. With several Claude windows open this fans out into a
// handful of simultaneous API hits — the fastest path to a 429.
//
// The lock file below makes acquisition atomic: O_EXCL means only one
// process succeeds; the rest fall back to serving the cached value (or a
// failure record). Stale locks (process killed mid-fetch) are reclaimed
// after FETCH_COORDINATION_MS so a crash never wedges the cache forever.

function getFetchLockPath(): string {
  return path.join(pluginDir(), '.fetch.lock');
}

export function getCreditGrantLockPath(): string {
  return path.join(pluginDir(), '.credit-grant.lock');
}

export function getProfileLockPath(): string {
  return path.join(pluginDir(), '.profile.lock');
}

/**
 * Cheap "is someone currently fetching?" check used by the statusline
 * parent before it spawns a background refresher. Returns true when a
 * fresh lock file exists — meaning another instance (or our own
 * earlier spawn) is mid-fetch and a duplicate spawn would just race to
 * fail at acquireFetchLock.
 *
 * `lockPathOverride` is provided for tests and for callers that want
 * to peek at a lock other than the main usage one.
 */
export function isFetchLockHeld(now: number = Date.now(), lockPathOverride?: string): boolean {
  const lockPath = lockPathOverride ?? getFetchLockPath();
  try {
    const stat = fs.lstatSync(lockPath);
    if (stat.isSymbolicLink()) return false;
    return (now - stat.mtimeMs) < FETCH_COORDINATION_MS;
  } catch { return false; }
}

/**
 * Try to acquire the fetch lock. Returns a handle on success (callers
 * MUST release it via the returned `release()` once the fetch
 * completes); null if another instance already holds the lock and the
 * lock is fresh.
 *
 * A stale lock (mtime older than FETCH_COORDINATION_MS) is reclaimed —
 * that path covers the case where the prior holder was killed before
 * it could release.
 *
 * Identity-checked release: at acquire we write a per-acquisition
 * token (PID + 8 random bytes) into the lock file; release reads it
 * back and only unlinks when it matches. Without this, a holder
 * delayed past FETCH_COORDINATION_MS by a suspended event loop could
 * have its lock reclaimed by a peer, then on resume call unlink and
 * delete the *peer's* lock — handing the orphaned lock back to the
 * very thundering herd we're guarding against.
 *
 * `lockPathOverride` is provided for tests; production callers leave
 * it undefined and the path resolves under the plugin dir.
 */
export function acquireFetchLock(now: number, lockPathOverride?: string): { release: () => void } | null {
  const lockPath = lockPathOverride ?? getFetchLockPath();
  // Only auto-create the plugin dir on the production path. Tests pass
  // a path inside their own tmp dir and don't want a side-effect on the
  // real ~/.claude/plugins/claude-quota location.
  if (lockPathOverride === undefined) {
    try {
      fs.mkdirSync(pluginDir(), { recursive: true });
    } catch { /* ignore */ }
  }

  const tryCreate = (): number | null => {
    try {
      return fs.openSync(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    } catch {
      return null;
    }
  };

  let fd = tryCreate();
  if (fd === null) {
    // Lock exists. Check if it's stale.
    try {
      const st = fs.lstatSync(lockPath);
      if (!st.isSymbolicLink() && now - st.mtimeMs >= FETCH_COORDINATION_MS) {
        // Reclaim. unlink + recreate; if any step races a winning peer
        // the second tryCreate fails and we yield to them.
        try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
        fd = tryCreate();
      }
    } catch { /* lock vanished between failure and stat — try once more */ }
  }
  if (fd === null) return null;

  // Per-acquisition token, used by release() to verify the on-disk
  // lock is still ours. Random bytes prevent a peer that happened to
  // pick the same PID after a fork-restart from impersonating us.
  const token = `${process.pid}.${randomBytes(8).toString('hex')}`;

  // Belt-and-suspenders: openSync's mode is masked by umask. Force 0o600
  // explicitly so an unusual umask can't leave the lock world-readable.
  try { fs.fchmodSync(fd, 0o600); } catch { /* ignore */ }
  try { fs.writeSync(fd, token); } catch { /* ignore */ }
  fs.closeSync(fd);

  return {
    release: () => {
      try {
        // Verify the lock contents still match our token before
        // unlinking. If a peer reclaimed the lock as stale and wrote
        // its own token, leave the file alone.
        const onDisk = fs.readFileSync(lockPath, 'utf8');
        if (onDisk === token) fs.unlinkSync(lockPath);
      } catch {
        // File missing (already reclaimed and re-released) or any
        // other read/unlink error: nothing to do, nothing to clean up.
      }
    },
  };
}

/**
 * Bump the cache timestamp without changing data.
 *
 * Prevents parallel instances from all *spawning a background refresh*
 * at the same time: downstream `readCache` consumers see a fresh
 * timestamp (so age < CACHE_SOFT_TTL_MS, isStale=false) and don't
 * trigger another spawn. Fetch coordination is owned by the
 * .fetch.lock file — this function only suppresses redundant spawns.
 */
export function bumpCacheTimestamp(now: number = Date.now()): void {
  try {
    const raw = readJsCache(getCachePath());
    if (!raw) return;
    const cache: CacheFile = JSON.parse(raw);
    // Skip bump for non-rate-limited failures (short TTL handles those).
    // Always bump for rate-limited entries whose backoff has expired, otherwise
    // parallel instances all see an expired backoff and race to fetch.
    if (cache.data.apiUnavailable && !cache.rateLimitedCount) return;
    cache.timestamp = now;
    writeJsCache(getCachePath(), CACHE_VAR_DATA, JSON.stringify(cache));
  } catch { /* no cache to bump */ }
}
