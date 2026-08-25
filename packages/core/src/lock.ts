import * as fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { creditGrantLockPath, fetchLockPath, profileLockPath, usageDir } from './paths.js';
import { FETCH_COORDINATION_MS } from './constants.js';

// ── The fetch lock ──────────────────────────────────────────────────────────
//
// This is the part that actually prevents redundant API calls. Everything else
// in the protocol is bookkeeping around it.
//
// Timestamp bumping alone is best-effort: two participants that race past the
// cache read in the same millisecond both see a stale entry and both fetch.
// With several Claude windows and a board open that fans out into a handful of
// simultaneous requests — the fastest route to a 429.
//
// O_EXCL makes acquisition atomic: exactly one process wins. The rest serve
// the cached value. A lock left behind by a killed process is reclaimed after
// FETCH_COORDINATION_MS, so a crash never wedges the cache permanently.

export { fetchLockPath, profileLockPath, creditGrantLockPath };

/**
 * Cheap "is someone fetching right now?" check.
 *
 * Used before spawning or scheduling a refresh: if a peer holds the lock, the
 * work would just race to fail at acquire.
 */
export function isFetchLockHeld(now: number = Date.now(), lockPathOverride?: string): boolean {
  const lockPath = lockPathOverride ?? fetchLockPath();
  try {
    const stat = fs.lstatSync(lockPath);
    if (stat.isSymbolicLink()) return false;
    return now - stat.mtimeMs < FETCH_COORDINATION_MS;
  } catch {
    return false;
  }
}

/**
 * Take the fetch lock, or return null because a peer holds it.
 *
 * A caller that gets null MUST NOT fetch. It re-reads the cache — the winner
 * may have finished in the meantime — and serves whatever is there.
 *
 * Release is identity-checked. At acquire we write a per-acquisition token
 * (PID plus 8 random bytes); release unlinks only when the file still contains
 * it. Without that check, a holder whose event loop was suspended past the
 * staleness threshold — having had its lock legitimately reclaimed — would on
 * resume delete the *peer's* lock and hand the file back to the thundering
 * herd the lock exists to prevent.
 *
 * `lockPathOverride` is for tests and for the auxiliary locks; production
 * callers leave it undefined.
 */
export function acquireFetchLock(
  now: number,
  lockPathOverride?: string,
): { release: () => void } | null {
  const lockPath = lockPathOverride ?? fetchLockPath();

  // Only auto-create on the production path. Tests pass a path inside their
  // own tmp dir and must not have a side effect on the real usage dir.
  if (lockPathOverride === undefined || lockPathOverride.startsWith(usageDir())) {
    try {
      fs.mkdirSync(usageDir(), { recursive: true, mode: 0o700 });
    } catch { /* ignore */ }
  }

  const tryCreate = (): number | null => {
    try {
      return fs.openSync(
        lockPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
        0o600,
      );
    } catch {
      return null;
    }
  };

  let fd = tryCreate();
  if (fd === null) {
    try {
      const st = fs.lstatSync(lockPath);
      if (!st.isSymbolicLink() && now - st.mtimeMs >= FETCH_COORDINATION_MS) {
        // Reclaim. If either step races a winning peer, the second create
        // fails and we yield to them.
        try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
        fd = tryCreate();
      }
    } catch { /* lock vanished between failure and stat */ }
  }
  if (fd === null) return null;

  const token = `${process.pid}.${randomBytes(8).toString('hex')}`;

  // openSync's mode is masked by umask; force 0600 so an unusual umask cannot
  // leave the lock world-readable.
  try { fs.fchmodSync(fd, 0o600); } catch { /* ignore */ }
  try { fs.writeSync(fd, token); } catch { /* ignore */ }
  fs.closeSync(fd);

  return {
    release: () => {
      try {
        const onDisk = fs.readFileSync(lockPath, 'utf8');
        if (onDisk === token) fs.unlinkSync(lockPath);
      } catch {
        // Already reclaimed, or already released. Nothing to clean up.
      }
    },
  };
}
