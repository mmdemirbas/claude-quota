import * as fs from 'node:fs';

/**
 * Reject a file for reading if its permission bits or ownership would let
 * another local user tamper with or read it. Caller uses the returned
 * reason to log and fall back.
 *
 * Rules enforced on POSIX:
 *   - File must not be a symlink (follow = attacker redirect).
 *   - Mode must not expose group or world bits (any of 0o077).
 *   - File must be owned by the current process uid when `process.getuid`
 *     is available.
 *
 * On platforms that lack POSIX uid/mode semantics (Windows), the checks
 * degrade to "not a symlink". Callers should still enforce other
 * protections (e.g., ACLs) out of band.
 */
export type FileSafetyIssue =
  | 'missing'
  | 'symlink'
  | 'permissive-mode'
  | 'wrong-owner'
  | 'stat-error';

export function checkFileSafe(filePath: string): { ok: true } | { ok: false; reason: FileSafetyIssue } {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: false, reason: 'missing' };
    return { ok: false, reason: 'stat-error' };
  }
  if (stat.isSymbolicLink()) return { ok: false, reason: 'symlink' };

  // POSIX permission bits live in the low 12 bits of mode.
  if ((stat.mode & 0o077) !== 0) {
    return { ok: false, reason: 'permissive-mode' };
  }

  const getuid = (process as NodeJS.Process & { getuid?: () => number }).getuid;
  if (typeof getuid === 'function') {
    const uid = getuid.call(process);
    if (stat.uid !== uid) return { ok: false, reason: 'wrong-owner' };
  }

  return { ok: true };
}

/**
 * Read a file's contents only if its permissions/ownership are safe.
 * Returns null on any safety violation or read error.
 */
export function readFileSecure(filePath: string, onReject?: (reason: FileSafetyIssue) => void): string | null {
  const safety = checkFileSafe(filePath);
  if (!safety.ok) {
    if (safety.reason !== 'missing' && onReject) onReject(safety.reason);
    return null;
  }
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Write a file with mode 0o600, replacing an existing file atomically.
 *
 * Uses O_EXCL on the tmp path so a racing symlink or pre-existing file
 * cannot hijack the open. Enforces 0o600 via the tmp's create-mode (Node
 * applies this on O_CREAT) and an explicit chmod as a belt-and-suspenders
 * defense against an unusual umask. rename() atomically swaps in the new
 * file — the prior path's old permissive mode is dropped with the file.
 *
 * Pre-existing symlinks at `filePath` are NOT followed: since rename
 * replaces the path entry itself, the symlink is severed. Callers that
 * need symlink refusal before writes should combine with checkFileSafe.
 *
 * **Returns whether the file was actually written.** It used to return void
 * and swallow every error, so a caller could not tell a completed write from a
 * failed one — and the callers that matter act on that: a cache entry reporting
 * success when the directory is unwritable means the 429 counter never
 * escalates, so every participant keeps fetching into a rate limit with nothing
 * on screen saying why.
 */
export function writeFileSecure(filePath: string, content: string): boolean {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  let fd: number | undefined;
  try {
    // Refuse to overwrite a symlink target: the attacker may have redirected
    // our write to a file outside the usage dir. Rename itself handles this
    // atomically, but catch it explicitly for clearer failure on read.
    try {
      const existing = fs.lstatSync(filePath);
      if (existing.isSymbolicLink()) {
        fs.unlinkSync(filePath);
      }
    } catch { /* missing is fine */ }

    // A previous process killed between open and rename leaves this path
    // behind, and pids are recycled — so O_EXCL would then fail forever for
    // whoever inherits that pid. Clearing it first costs nothing; the file is
    // ours by construction (it carries our pid) and holds no data anyone wants.
    try { fs.unlinkSync(tmpPath); } catch { /* usually absent */ }

    fd = fs.openSync(tmpPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);

    /*
     * Write in a loop, because a single writeSync is not a whole file.
     *
     * `fs.writeSync` returns a byte count, and on a full disk or over quota it
     * returns a *short* count rather than throwing. Discarding that count meant
     * the truncated body was then fsynced, chmod'd and renamed over the good
     * file. For usage.json that produces unparseable JSON, which reads as an
     * absent cache, which discards lastGood and the 429 counter — at the moment
     * the account is rate-limited. For readings.jsonl it silently truncates the
     * retained history. Node's own writeFileSync loops for exactly this reason.
     */
    const buf = Buffer.from(content, 'utf8');
    let written = 0;
    while (written < buf.length) {
      const n = fs.writeSync(fd, buf, written, buf.length - written);
      if (n <= 0) throw new Error('short write');
      written += n;
    }

    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    // Enforce 0o600 regardless of umask — cheap insurance.
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    return false;
  }
}
