import * as fs from 'node:fs';
import type { Reading } from './types.js';
import { checkFileSafe, writeFileSecure } from './secure-fs.js';
import { readingsPath } from './paths.js';
import { ensureUsageDir } from './cache.js';
import { READINGS_COMPACT_BYTES, READINGS_RETENTION_MS } from './constants.js';
import { warn } from './log.js';

/**
 * The append-only reading log.
 *
 * The usage API answers only "right now" — it has no history endpoint. A
 * curve, and any projection worth believing, can only be built from readings
 * that were actually taken, so every distinct one is kept here where any
 * participant can find it. A tool that was not running for six hours can still
 * see what happened in them.
 *
 * This is a shared convenience, not an archive. A participant needing
 * unbounded history keeps its own store; this file is compacted (§3.1).
 */

/**
 * Append a reading. Caller must hold the fetch lock.
 *
 * Under the lock, "is this newer than the last line" is a sound check, so two
 * participants never write the same reading twice. A single O_APPEND write per
 * line means concurrent appenders cannot interleave partial lines even if the
 * lock is somehow bypassed.
 */
export function appendReading(reading: Reading): boolean {
  if (reading.error !== null) return false; // successes only

  const last = lastReadingAt();
  if (last !== null && reading.fetchedAt <= last) return false;

  ensureUsageDir();
  if (!healPermissions()) return false;

  const line = `${JSON.stringify(reading)}\n`;
  try {
    fs.appendFileSync(readingsPath(), line, { mode: 0o600, flag: 'a' });
  } catch {
    return false;
  }
  compactIfNeeded();
  return true;
}

/**
 * Make sure the log is still a file we are willing to read.
 *
 * `appendFileSync` checks nothing, while every read here goes through
 * `checkFileSafe`. Those two disagreeing is a trap: a log that picks up a group
 * or world bit — restored from a backup, copied between machines, rsynced
 * without `-p` — becomes unreadable to `readReadings`, so reads return empty,
 * `lastReadingAt` returns null and compaction takes its "nothing kept" early
 * exit, *while appends keep succeeding*. The file then grows without bound,
 * nothing will ever read it again, and the monotonicity guard is silently off,
 * which also breaks the append-ordering the tail read depends on.
 *
 * The file is ours in a 0700 directory, so a permissive mode is an accident
 * rather than an intention: fix it. A symlink or another user's file is not an
 * accident — refuse those.
 */
function healPermissions(): boolean {
  const path = readingsPath();
  let st: fs.Stats;
  try {
    st = fs.lstatSync(path);
  } catch {
    return true; // absent; the append creates it 0600
  }

  if (st.isSymbolicLink()) {
    warn('readings log is a symlink; refusing to append', { path });
    return false;
  }
  const getuid = (process as NodeJS.Process & { getuid?: () => number }).getuid;
  if (typeof getuid === 'function' && st.uid !== getuid.call(process)) {
    warn('readings log is owned by another user; refusing to append', { path });
    return false;
  }
  if ((st.mode & 0o077) !== 0) {
    try {
      fs.chmodSync(path, 0o600);
      warn('readings log had group/world bits; tightened to 0600', { path });
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * `fetchedAt` of the newest line, or null when the log is empty or unreadable.
 *
 * Reads the tail rather than the file. This runs on every append, and an append
 * runs inside a statusline redraw that has a few hundred milliseconds to spend
 * in total — parsing a multi-megabyte log to learn one number is the kind of
 * cost that does not show up until the log has been accumulating for a month.
 *
 * Sound because the file is append-ordered: `appendReading` refuses anything
 * that does not advance `fetchedAt`, and compaction rewrites in order. If the
 * tail happens to hold no complete line, fall back to reading properly rather
 * than guessing.
 */
const TAIL_BYTES = 64 * 1024;

export function lastReadingAt(): number | null {
  const path = readingsPath();
  const safety = checkFileSafe(path);
  if (!safety.ok) return null;

  let fd: number | undefined;
  try {
    const size = fs.statSync(path).size;
    if (size === 0) return null;

    const length = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(length);
    fd = fs.openSync(path, 'r');
    // Use the count actually read. Discarding it leaves NUL padding in the
    // buffer on a short read, which makes the final line unparseable — and the
    // walk-back then returns an *older* fetchedAt than the true last line,
    // which lets a duplicate append through.
    const read = fs.readSync(fd, buf, 0, length, size - length);
    fs.closeSync(fd);
    fd = undefined;
    if (read <= 0) return null;

    const text = buf.subarray(0, read).toString('utf8');
    // Drop a leading partial line when the window started mid-record. Only
    // safe when the window did not cover the whole file.
    const lines = (read < size ? text.slice(text.indexOf('\n') + 1) : text).split('\n');

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line === undefined || line === '') continue;
      try {
        const parsed = JSON.parse(line) as Reading;
        if (typeof parsed.fetchedAt === 'number' && Number.isFinite(parsed.fetchedAt)) {
          return parsed.fetchedAt;
        }
      } catch { /* torn or truncated line — keep walking back */ }
    }

    // The window held nothing usable. Either every line in it is damaged or a
    // single record is larger than the window; a full read settles which.
    if (read < size) {
      const all = readReadings();
      return all[all.length - 1]?.fetchedAt ?? null;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * Every reading at or after `sinceMs`, oldest first.
 *
 * A line that will not parse is skipped rather than fatal: a torn final line
 * from an interrupted write is expected, and it says nothing about the rest of
 * the file.
 */
export function readReadings(sinceMs = 0): Reading[] {
  const path = readingsPath();
  const safety = checkFileSafe(path);
  if (!safety.ok) {
    if (safety.reason !== 'missing') warn('readings log rejected', { reason: safety.reason });
    return [];
  }

  let raw: string;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch {
    return [];
  }

  const out: Reading[] = [];
  for (const line of raw.split('\n')) {
    if (line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed == null || typeof parsed !== 'object') continue;
    const r = parsed as Reading;
    if (typeof r.fetchedAt !== 'number' || !Number.isFinite(r.fetchedAt)) continue;
    if (r.fetchedAt < sinceMs) continue;
    out.push(r);
  }
  out.sort((a, b) => a.fetchedAt - b.fetchedAt);
  return out;
}

/**
 * Bring the log back under its size cap, dropping the oldest readings.
 *
 * Two bounds apply and they are not equals. Age is what we would *like* to
 * keep; size is what the file may actually cost everyone else. Age alone
 * cannot terminate: at the highest sustainable fetch rate — one per hard TTL,
 * 720 a day — thirty days of readings is about 7 MB, well over the 4 MB cap. A
 * compaction that only drops by age would then remove nothing, leave the file
 * over the threshold, and run again on the very next append, rewriting several
 * megabytes every two minutes for as long as the machine is in use.
 *
 * So age is applied first, and if the result is still too large the oldest
 * survivors are dropped until it fits. That makes progress guaranteed: every
 * compaction ends under the cap, so the next one is not due until the file has
 * grown again.
 *
 * Called only from `appendReading`, so it runs under the fetch lock and cannot
 * race an append. `statSync` first because the common case is a file well under
 * the cap, and a stat is far cheaper than a parse.
 */
function compactIfNeeded(now: number = Date.now()): void {
  let size: number;
  try {
    size = fs.statSync(readingsPath()).size;
  } catch {
    return;
  }
  if (size <= READINGS_COMPACT_BYTES) return;

  let kept = readReadings(now - READINGS_RETENTION_MS);
  if (kept.length === 0) return;

  const encode = (rs: Reading[]): string => `${rs.map((r) => JSON.stringify(r)).join('\n')}\n`;

  // Still too big after the age pass: drop from the front until it fits. The
  // target leaves headroom so the next append does not immediately re-trigger.
  let body = encode(kept);
  if (Buffer.byteLength(body) > READINGS_COMPACT_BYTES) {
    const target = Math.floor(READINGS_COMPACT_BYTES * 0.8);
    const perLine = Buffer.byteLength(body) / kept.length;
    const fits = Math.max(1, Math.floor(target / perLine));
    kept = kept.slice(-fits);
    body = encode(kept);
    // Line widths vary, so the estimate can still overshoot. Trim the rest off
    // one bite at a time; this loop is bounded by kept.length and each pass
    // strictly shrinks it.
    while (kept.length > 1 && Buffer.byteLength(body) > READINGS_COMPACT_BYTES) {
      kept = kept.slice(Math.ceil(kept.length * 0.1));
      body = encode(kept);
    }
    if (Buffer.byteLength(body) > READINGS_COMPACT_BYTES) {
      // A single reading larger than the whole cap. Nothing here can fix that,
      // and it would otherwise re-run a full compaction on every append with no
      // way to make progress — so say it out loud rather than churning quietly.
      warn('a single reading exceeds the log size cap', {
        bytes: Buffer.byteLength(body),
        cap: READINGS_COMPACT_BYTES,
      });
    }
  }

  if (!writeFileSecure(readingsPath(), body)) {
    warn('could not compact the readings log', { path: readingsPath() });
    return;
  }
  warn('compacted readings log', { fromBytes: size, toBytes: Buffer.byteLength(body), kept: kept.length });
}
