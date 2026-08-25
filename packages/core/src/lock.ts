import * as fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { creditGrantLockPath, fetchLockPath, profileLockPath, usageDir } from './paths.js';
import { warn } from './log.js';
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
 * Take over a lock whose holder is gone, without taking one whose holder is not.
 *
 * Reclaiming is a read-modify-write on a file — decide it is stale, remove it,
 * create a new one — and POSIX gives no way to do that atomically. Every
 * variant that tries to fake it with `unlink` or `rename` has a window:
 *
 *   - stat, unlink, create: two participants both see the stale lock, and the
 *     second unlink deletes the *first's brand-new* lock. Both creates succeed.
 *     Measured at 1 double-holder in 20 trials.
 *   - rename the stale lock aside, then create: better, because exactly one
 *     participant can rename a given path. But a third participant, still
 *     holding a stat from before that rename, renames the *winner's fresh* lock
 *     aside next; it detects the mistake and puts it back, and another create
 *     lands in that gap. Measured at 1 double-holder in 15 trials.
 *
 * The window cannot be closed by being cleverer about the swap, so reclaim is
 * serialised instead: a participant must hold a second, dedicated lock before
 * it may remove the first. That one is only ever taken with `O_EXCL` and held
 * for microseconds, so it needs no reclaim algorithm of its own.
 *
 * Under that lock the staleness is re-checked, which is what makes it safe: if
 * someone acquired legitimately in the meantime, their lock is fresh and we
 * leave it alone. And if a plain `O_EXCL` create wins the gap between our
 * unlink and our create, our create fails and we yield to them. Every path ends
 * with at most one holder.
 */
function reclaimIfStale(lockPath: string, now: number): number | null {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(lockPath);
  } catch {
    // Released between our create and this stat. Yielding one round is
    // harmless — the caller serves the cache and the next tick acquires —
    // and trying to create here is precisely what let a reclaimer in
    // mid-steal produce a second holder.
    return null;
  }

  if (st.isSymbolicLink()) {
    // Nothing legitimate puts a symlink here: the directory is 0700 and ours.
    // Leaving it wedges fetching permanently with no diagnostic, because
    // isFetchLockHeld reports a symlink as *not* held, so callers keep trying
    // and keep losing. Remove it — unlink does not follow the link — and say so.
    warn('fetch lock was a symlink; removing it', { lockPath });
    try { fs.unlinkSync(lockPath); } catch { /* someone got there first */ }
    return tryCreateLock(lockPath);
  }

  if (now - st.mtimeMs < FETCH_COORDINATION_MS) return null; // a live peer holds it

  const reclaimPath = `${lockPath}.reclaim`;
  let reclaimFd = tryCreateLock(reclaimPath);
  if (reclaimFd === null) {
    // Either a peer is reclaiming right now, or a reclaimer died holding this.
    // The guarded sequence takes microseconds, so a reclaim lock older than the
    // coordination window is certainly abandoned.
    try {
      const rst = fs.lstatSync(reclaimPath);
      if (!rst.isSymbolicLink() && Date.now() - rst.mtimeMs >= FETCH_COORDINATION_MS) {
        try { fs.unlinkSync(reclaimPath); } catch { /* ignore */ }
        reclaimFd = tryCreateLock(reclaimPath);
      }
    } catch { /* vanished — a peer finished; yield this round */ }
    if (reclaimFd === null) return null;
  }
  try { fs.closeSync(reclaimFd); } catch { /* ignore */ }

  try {
    // Re-check under the reclaim lock. Anything that acquired since our first
    // stat did so legitimately and must not be disturbed.
    let current: fs.Stats;
    try {
      current = fs.lstatSync(lockPath);
    } catch {
      return tryCreateLock(lockPath); // gone; a plain create is now the whole story
    }
    if (Date.now() - current.mtimeMs < FETCH_COORDINATION_MS) return null;

    try { fs.unlinkSync(lockPath); } catch { /* a peer beat us to it */ }
    return tryCreateLock(lockPath);
  } finally {
    try { fs.unlinkSync(reclaimPath); } catch { /* ignore */ }
  }
}

/** `open(O_CREAT | O_EXCL)`, or null when the path already exists. */
function tryCreateLock(lockPath: string): number | null {
  try {
    return fs.openSync(
      lockPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
  } catch {
    return null;
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

  let fd = tryCreateLock(lockPath);
  if (fd === null) fd = reclaimIfStale(lockPath, now);
  if (fd === null) return null;

  const token = `${process.pid}.${randomBytes(8).toString('hex')}`;

  // openSync's mode is masked by umask; force 0600 so an unusual umask cannot
  // leave the lock world-readable.
  try { fs.fchmodSync(fd, 0o600); } catch { /* ignore */ }

  /*
   * The token write is not optional, and neither is the close.
   *
   * Swallowing a failed write leaves the lock file present but empty, so
   * `release` never recognises it as ours and never unlinks it — the lock is
   * then leaked for the full staleness window, blocking every participant on
   * the machine for twenty seconds over a disk error. And an unhandled throw
   * from `closeSync` escaped this function *after* the lock file existed, with
   * no handle returned to release it: the same leak by another route.
   *
   * If we cannot establish ownership, we do not hold the lock. Clean up and say
   * we lost, which callers already handle — they serve the cache and move on.
   */
  try {
    fs.writeSync(fd, token);
    fs.closeSync(fd);
  } catch {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
    warn('could not claim the fetch lock; yielding', { lockPath });
    return null;
  }

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
