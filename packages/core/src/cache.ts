import * as fs from 'node:fs';
import type {
  BucketKey,
  BucketReading,
  CacheEntry,
  ExtraUsageData,
  Reading,
  UsageData,
} from './types.js';
import { BUCKET_KEYS, SCHEMA_VERSION } from './types.js';
import { readFileSecure, writeFileSecure } from './secure-fs.js';
import { legacyCachePath, usageCachePath, usageDir } from './paths.js';
import { warn } from './log.js';
import {
  CACHE_TTL_MS,
  CACHE_SOFT_TTL_MS,
  CACHE_FAILURE_TTL_MS,
  CACHE_RATE_LIMITED_BASE_MS,
  CACHE_RATE_LIMITED_MAX_MS,
  RETRY_AFTER_MAX_MS,
} from './constants.js';
import { parseDate } from './parse.js';

/** Create the shared directory, 0700. Idempotent; failures are the caller's problem to notice. */
export function ensureUsageDir(): void {
  try {
    fs.mkdirSync(usageDir(), { recursive: true, mode: 0o700 });
  } catch { /* a later write will surface it */ }
}

// ── Flat UsageData  ⇄  on-disk Reading ─────────────────────────────────────
//
// The only place the two shapes meet. Everything above this line speaks flat
// UsageData; everything below speaks the protocol.

/** Flat field names paired with their protocol bucket key. */
const FLAT_BY_BUCKET: Record<BucketKey, { value: keyof UsageData; reset: keyof UsageData }> = {
  fiveHour: { value: 'fiveHour', reset: 'fiveHourResetAt' },
  sevenDay: { value: 'sevenDay', reset: 'sevenDayResetAt' },
  sevenDaySonnet: { value: 'sonnet', reset: 'sonnetResetAt' },
  sevenDayOpus: { value: 'opus', reset: 'opusResetAt' },
  sevenDayDesign: { value: 'design', reset: 'designResetAt' },
  sevenDayRoutines: { value: 'routines', reset: 'routinesResetAt' },
  sevenDayCode: { value: 'code', reset: 'codeResetAt' },
};

function bucketOf(v: unknown): BucketReading | null {
  if (v == null || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const util = o.utilization;
  const resets = o.resetsAt;
  return {
    utilization: typeof util === 'number' && Number.isFinite(util) ? util : null,
    resetsAt: typeof resets === 'string' && resets !== '' ? resets : null,
  };
}

/** On-disk reading → the flat shape callers render from. */
export function toUsageData(reading: Reading): UsageData {
  const data = {
    planName: reading.planName ?? '',
    extraUsage: reading.extraUsage,
    fetchedAt: reading.fetchedAt,
    buckets: reading.buckets,
  } as UsageData;

  for (const key of BUCKET_KEYS) {
    const flat = FLAT_BY_BUCKET[key];
    const bucket = bucketOf(reading.buckets?.[key]);
    (data as unknown as Record<string, unknown>)[flat.value] = bucket?.utilization ?? null;
    (data as unknown as Record<string, unknown>)[flat.reset] = parseDate(bucket?.resetsAt ?? undefined);
  }

  if (reading.error !== null) {
    data.apiUnavailable = true;
    data.apiError = reading.error;
  }
  return data;
}

/**
 * Flat shape → on-disk reading.
 *
 * `priorBuckets` carries forward any bucket key this build does not have a
 * flat field for. Without it, an older participant writing a reading would
 * silently drop the newest quota bucket a newer one had recorded — the file
 * would lose data on every write by whichever tool was upgraded last.
 */
export function toReading(
  data: UsageData,
  fetchedAt: number,
  priorBuckets?: Record<string, BucketReading | null>,
): Reading {
  const known = new Set<string>(BUCKET_KEYS);
  const buckets: Record<string, BucketReading | null> = {};

  for (const [key, value] of Object.entries(priorBuckets ?? {})) {
    if (!known.has(key)) buckets[key] = bucketOf(value);
  }

  for (const key of BUCKET_KEYS) {
    const flat = FLAT_BY_BUCKET[key];
    const util = (data as unknown as Record<string, unknown>)[flat.value];
    const reset = (data as unknown as Record<string, unknown>)[flat.reset];
    const utilization = typeof util === 'number' && Number.isFinite(util) ? util : null;
    const resetsAt = reset instanceof Date && !isNaN(reset.getTime()) ? reset.toISOString() : null;
    buckets[key] = utilization === null && resetsAt === null ? null : { utilization, resetsAt };
  }

  return {
    fetchedAt,
    planName: data.planName || null,
    buckets,
    extraUsage: data.extraUsage,
    error: data.apiError ?? null,
  };
}

// ── Reading the entry ──────────────────────────────────────────────────────

function coerceReading(v: unknown): Reading | null {
  if (v == null || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.fetchedAt !== 'number' || !Number.isFinite(o.fetchedAt)) return null;
  const buckets = o.buckets;
  return {
    fetchedAt: o.fetchedAt,
    planName: typeof o.planName === 'string' && o.planName !== '' ? o.planName : null,
    buckets:
      buckets != null && typeof buckets === 'object'
        ? (buckets as Record<string, BucketReading | null>)
        : {},
    extraUsage: (o.extraUsage ?? null) as ExtraUsageData | null,
    error: (o.error ?? null) as Reading['error'],
  };
}

/**
 * The three states `usage.json` can be in, kept distinct because they call for
 * different behaviour and conflating two of them is how a file gets destroyed.
 *
 * `absent` and `future` both mean "nothing this build can serve", but only
 * `absent` means "go and fetch one". A `future` entry belongs to a newer
 * participant that is already keeping it current; fetching would add request
 * rate for a reading this build cannot store, and writing would downgrade the
 * file for the participant that can.
 */
export type EntryRead =
  | { kind: 'absent' }
  | { kind: 'future'; version: number }
  | { kind: 'entry'; entry: CacheEntry };

/**
 * Parse `usage.json` with no interpretation of freshness.
 *
 * Protocol §7. A file this build cannot vouch for — refused by the safety
 * check, unparseable, or from a newer schema — is never partially interpreted.
 */
export function readEntryStatus(): EntryRead {
  const raw = readFileSecure(usageCachePath(), (reason) => {
    warn('usage cache rejected', { reason });
  });
  if (raw == null) return { kind: 'absent' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'absent' };
  }
  if (parsed == null || typeof parsed !== 'object') return { kind: 'absent' };

  const o = parsed as Record<string, unknown>;
  const version = typeof o.schemaVersion === 'number' ? o.schemaVersion : 0;
  if (version > SCHEMA_VERSION) {
    warn('usage cache written by a newer schema; standing down', { version });
    return { kind: 'future', version };
  }
  if (typeof o.timestamp !== 'number' || !Number.isFinite(o.timestamp)) return { kind: 'absent' };

  const backoff = (o.backoff ?? {}) as Record<string, unknown>;
  return {
    kind: 'entry',
    entry: {
      ...o,
      schemaVersion: version,
      timestamp: o.timestamp,
      reading: coerceReading(o.reading),
      lastGood: coerceReading(o.lastGood),
      backoff: {
        rateLimitedCount:
          typeof backoff.rateLimitedCount === 'number' ? backoff.rateLimitedCount : 0,
        retryAfterUntil:
          typeof backoff.retryAfterUntil === 'number' ? backoff.retryAfterUntil : null,
      },
    },
  };
}

/** The entry, or null for anything this build cannot serve. */
export function readEntry(): CacheEntry | null {
  const read = readEntryStatus();
  return read.kind === 'entry' ? read.entry : null;
}

/**
 * The instant a 429 backoff expires, bounded so a hostile or corrupt
 * `retryAfterUntil` cannot silence every participant on the machine until
 * someone deletes the file by hand.
 */
export function backoffUntil(entry: CacheEntry): number {
  const derived = Math.min(
    CACHE_RATE_LIMITED_BASE_MS * Math.pow(2, Math.max(0, entry.backoff.rateLimitedCount - 1)),
    CACHE_RATE_LIMITED_MAX_MS,
  );
  return Math.min(
    entry.backoff.retryAfterUntil ?? entry.timestamp + derived,
    entry.timestamp + RETRY_AFTER_MAX_MS,
  );
}

/**
 * Serve the cached entry, or say there is nothing to serve.
 *
 * Protocol §5. The freshness thresholds are shared on purpose: a participant
 * using a shorter TTL than its peers fetches while they consider the cache
 * fresh, which is the exact redundant traffic this whole arrangement exists to
 * stop.
 */
export function readCache(
  now: number,
): { data: UsageData; isStale: boolean; source: 'cache' | 'backoff' } | null {
  const entry = readEntry();
  if (entry === null || entry.reading === null) return null;

  if (entry.reading.error === 'rate-limited' && entry.backoff.rateLimitedCount > 0) {
    if (now < backoffUntil(entry)) {
      // In backoff: show real numbers, flagged, and do not fetch. They keep the
      // instant they were measured — see the note below.
      const display = entry.lastGood
        ? { ...toUsageData(entry.lastGood), apiError: 'rate-limited' as const }
        : toUsageData(entry.reading);
      return { data: display, isStale: false, source: 'backoff' };
    }
    return null; // backoff expired — fetch regardless of the failure TTL
  }

  const ttl = entry.reading.error !== null ? CACHE_FAILURE_TTL_MS : CACHE_TTL_MS;

  /*
   * Age is measured in absolute terms, because it can legitimately be negative.
   *
   * A fetch that completes while the machine's clock is fast — VM resume, RTC
   * drift, a manual change — leaves an entry stamped in the future. NTP then
   * steps the clock back, and `now - timestamp` is negative for as long as the
   * skew lasts: smaller than any TTL, so every participant serves that reading
   * as fresh, never marks it stale, and never reaches the lock. Measured with
   * an hour of skew: served as fresh, `isStale` false, for the whole hour.
   *
   * Taking the magnitude makes a future-dated entry look old rather than
   * eternally new, so the next participant refetches and the entry heals.
   */
  const age = Math.abs(now - entry.timestamp);
  if (age >= ttl) return null;

  // Any failure, not only a 429, keeps showing the last real numbers. See the
  // note in usage.ts writeFailure: blanking a quota display over one HTTP 500
  // throws away information we still hold.
  const display =
    entry.reading.error !== null && entry.lastGood
      ? { ...toUsageData(entry.lastGood), apiError: entry.reading.error, apiUnavailable: true }
      : toUsageData(entry.reading);

  /*
   * `fetchedAt` is the instant the reading was *measured*, and never
   * `entry.timestamp`.
   *
   * The two are different facts. `entry.timestamp` is cache bookkeeping — it
   * moves when a participant bumps the entry before a request, without any new
   * measurement — while `fetchedAt` is the only thing that says how old the
   * numbers on screen actually are.
   *
   * Stamping the display with the entry timestamp broke both. It told the user
   * a reading was current when it was minutes old and merely re-confirmed. And
   * because the fetcher derives its bump and its reading's `fetchedAt` from one
   * `now`, a reader arriving mid-flight was handed the *previous* values
   * wearing the *incoming* reading's timestamp — so downstream, where
   * `fetchedAt` is a primary key, the real measurement lost a primary-key
   * conflict against a stale copy of itself and was dropped. The same mechanism
   * stamped last-good numbers with the time of the 429 that failed to replace
   * them, diluting any rate computed from the history.
   */
  return {
    data: display,
    isStale: entry.reading.error === null && age >= CACHE_SOFT_TTL_MS,
    source: 'cache',
  };
}

// ── Writing the entry ──────────────────────────────────────────────────────

function blankEntry(now: number): CacheEntry {
  return {
    schemaVersion: SCHEMA_VERSION,
    timestamp: now,
    reading: null,
    lastGood: null,
    backoff: { rateLimitedCount: 0, retryAfterUntil: null },
  };
}

/**
 * Read-modify-write the entry.
 *
 * Callers hold the fetch lock, so this is not a concurrency guard — it is how
 * unknown top-level keys survive a write by a participant that does not know
 * what they mean (§2).
 */
export function updateEntry(now: number, mutate: (entry: CacheEntry) => void): CacheEntry | null {
  const read = readEntryStatus();
  // Refuse to downgrade a file written by a newer participant (§7). Every
  // caller here is on a path that would otherwise replace it wholesale.
  if (read.kind === 'future') return null;

  const entry = read.kind === 'entry' ? read.entry : blankEntry(now);
  entry.schemaVersion = SCHEMA_VERSION;
  mutate(entry);
  ensureUsageDir();
  // A swallowed write failure is how a 429 counter stops escalating: every
  // participant re-reads an unchanged file, writes 1, fails, and fetches again
  // — hammering a rate-limited endpoint with nothing on screen saying why.
  if (!writeFileSecure(usageCachePath(), JSON.stringify(entry))) {
    warn('could not write the usage cache', { path: usageCachePath() });
    return null;
  }
  return entry;
}

/**
 * Mark the entry fresh without claiming a reading that has not arrived.
 *
 * Called by the lock holder immediately before it issues the request. Peers
 * reading mid-flight see a fresh timestamp and skip queueing their own
 * refresh; the reading itself is untouched, so nobody is shown a number that
 * was never measured.
 */
export function bumpTimestamp(now: number): void {
  /*
   * Re-serialising the *parsed* entry would not be inert.
   *
   * `coerceReading` rebuilds a reading from the five fields this build knows,
   * so anything a newer peer added inside `reading` or `lastGood` is dropped on
   * write. Entry-level keys survive — `readEntryStatus` spreads them — but one
   * level down they did not, and §7 permits a peer at the same schema version
   * to add fields. The bump is documented as changing the timestamp and nothing
   * else, so it edits the raw JSON instead of a reconstruction of it.
   */
  const raw = readFileSecure(usageCachePath());
  if (raw === null) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (parsed === null || typeof parsed !== 'object') return;

  const o = parsed as Record<string, unknown>;
  const version = typeof o.schemaVersion === 'number' ? o.schemaVersion : 0;
  if (version > SCHEMA_VERSION) return; // a newer schema is not ours to touch

  // A non-429 failure has a 15s TTL that already does this job. Bumping it
  // would stretch a failure entry to the full 2 minutes.
  const reading = o.reading as { error?: unknown } | null | undefined;
  const backoff = (o.backoff ?? {}) as { rateLimitedCount?: unknown };
  const count = typeof backoff.rateLimitedCount === 'number' ? backoff.rateLimitedCount : 0;
  if (reading?.error != null && count === 0) return;

  o.timestamp = now;
  ensureUsageDir();
  writeFileSecure(usageCachePath(), JSON.stringify(o));
}

/** Buckets from the newest reading on disk, so an unknown key survives our write. */
export function priorBuckets(): Record<string, BucketReading | null> | undefined {
  const entry = readEntry();
  if (entry === null) return undefined;

  // `?? entry.lastGood?.buckets` never fired: coerceReading guarantees an
  // object, `{}` at minimum, so an empty bucket map on a failure reading
  // shadowed a populated one on lastGood — and the unknown bucket this
  // function exists to carry forward was dropped on the next write. Merge
  // instead, newest winning.
  const carried: Record<string, BucketReading | null> = { ...(entry.lastGood?.buckets ?? {}) };
  for (const [key, value] of Object.entries(entry.reading?.buckets ?? {})) {
    carried[key] = value;
  }
  return Object.keys(carried).length > 0 ? carried : undefined;
}

// ── Legacy import ──────────────────────────────────────────────────────────

/**
 * One-shot import of claude-quota's pre-protocol cache.
 *
 * Runs only when the shared entry is absent. Without it, the first run after
 * an upgrade discards a live 429 backoff counter and the last good reading,
 * which is exactly when a rate-limited account can least afford a fresh fetch.
 *
 * The legacy file is a `.js` assignment (`var DATA={…}`) because a dashboard
 * page loads it with a script tag. It is parsed as JSON rather than evaluated:
 * it was written by another program, and running it would make any bug there a
 * bug here.
 */
export function migrateLegacyCache(now: number): boolean {
  /*
   * `readEntryStatus`, not `readEntry`: the latter collapses "absent" and
   * "written by a newer schema" into null, and those must not be confused here
   * of all places. This function's whole job is to write, and it runs before
   * `getUsage`'s stand-down check — so using `readEntry` meant a v2 file was
   * replaced by a legacy v1 reading on any machine that had ever run the
   * pre-protocol plugin, taking its unknown buckets, its unknown fields and an
   * active 429 backoff with it. Worse, the build then no longer detected a
   * newer schema, so §7's stand-down was defeated permanently for everyone.
   */
  if (readEntryStatus().kind !== 'absent') return false;

  const raw = readFileSecure(legacyCachePath());
  if (raw == null) return false;

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return false;

  let legacy: Record<string, unknown>;
  try {
    legacy = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return false;
  }

  const timestamp = typeof legacy.timestamp === 'number' ? legacy.timestamp : null;
  if (timestamp === null) return false;

  const asReading = (v: unknown, fetchedAt: number): Reading | null => {
    if (v == null || typeof v !== 'object') return null;
    const d = v as Record<string, unknown>;
    const flat: Record<string, unknown> = { ...d };
    // Legacy stored Dates as ISO strings after a JSON round trip; toReading
    // wants Date objects.
    for (const key of BUCKET_KEYS) {
      const resetField = FLAT_BY_BUCKET[key].reset;
      const iso = d[resetField];
      flat[resetField] = typeof iso === 'string' ? parseDate(iso) : null;
    }
    const at = typeof d.fetchedAt === 'number' ? d.fetchedAt : fetchedAt;
    return toReading(flat as unknown as UsageData, at);
  };

  const reading = asReading(legacy.data, timestamp);
  if (reading === null) return false;
  const lastGood = asReading(legacy.lastGoodData, timestamp) ?? (reading.error === null ? reading : null);

  ensureUsageDir();
  writeFileSecure(
    usageCachePath(),
    JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      timestamp,
      reading,
      lastGood,
      backoff: {
        rateLimitedCount:
          typeof legacy.rateLimitedCount === 'number' ? legacy.rateLimitedCount : 0,
        retryAfterUntil:
          typeof legacy.retryAfterUntil === 'number' ? legacy.retryAfterUntil : null,
      },
    } satisfies CacheEntry),
  );
  warn('imported legacy usage cache', { timestamp, now });
  return true;
}
