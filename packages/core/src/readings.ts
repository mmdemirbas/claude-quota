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
  const line = `${JSON.stringify(reading)}\n`;
  try {
    fs.appendFileSync(readingsPath(), line, { mode: 0o600, flag: 'a' });
  } catch {
    return false;
  }
  compactIfNeeded();
  return true;
}

/** `fetchedAt` of the newest line, or null when the log is empty or unreadable. */
export function lastReadingAt(): number | null {
  const all = readReadings();
  const last = all[all.length - 1];
  return last?.fetchedAt ?? null;
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
 * Drop readings older than the retention window once the file grows past the
 * compaction threshold.
 *
 * Called only from `appendReading`, so it runs under the fetch lock and cannot
 * race an append. `statSync` first because the common case is a small file and
 * a stat is far cheaper than a parse.
 */
function compactIfNeeded(now: number = Date.now()): void {
  let size: number;
  try {
    size = fs.statSync(readingsPath()).size;
  } catch {
    return;
  }
  if (size <= READINGS_COMPACT_BYTES) return;

  const kept = readReadings(now - READINGS_RETENTION_MS);
  if (kept.length === 0) return;
  const body = kept.map((r) => JSON.stringify(r)).join('\n');
  writeFileSecure(readingsPath(), `${body}\n`);
  warn('compacted readings log', { from: size, kept: kept.length });
}
