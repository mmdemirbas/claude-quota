/**
 * @mmdemirbas/claude-usage — a shared, coordinated cache for Claude
 * subscription usage readings.
 *
 * The reference implementation of `docs/usage-cache-protocol.md`. Every
 * program on the machine that wants quota numbers calls `getUsage()`. Whoever
 * finds the shared entry stale and wins the fetch lock pays for one request;
 * everyone else reads what that one wrote. No participant needs to know that
 * any other participant exists, and a participant running alone still gets a
 * number, because it is also the one that fetches.
 *
 * ```ts
 * import { getUsage, readReadings } from '@mmdemirbas/claude-usage';
 *
 * const { data, isStale, source } = await getUsage();
 * //    source: 'cache' | 'fetch' | 'peer' | 'backoff' | 'none'
 *
 * const week = readReadings(Date.now() - 7 * 24 * 60 * 60_000);
 * ```
 */

// The two calls almost every caller needs.
export { getUsage, readCachedUsage, type FetchApiFn, type GetUsageOpts } from './usage.js';

// The shared history. Appended by whoever fetches; readable by anyone.
export { readReadings, appendReading, lastReadingAt } from './readings.js';

// Plan label and prepaid balance — same account, same directory, separate
// cadence. Not part of the protocol proper.
export { ensureProfileCached, getCreditGrant, readProfileCache, type ProfileData } from './profile.js';

// Where everything lives. Exported so a caller can show the path in a
// diagnostic rather than hardcoding it.
export {
  configDir,
  usageDir,
  usageCachePath,
  readingsPath,
  fetchLockPath,
  profileCachePath,
  creditGrantCachePath,
} from './paths.js';

// The on-disk entry, for tools that want to inspect rather than render.
export {
  readEntry,
  readEntryStatus,
  type EntryRead,
  readCache,
  backoffUntil,
  bumpTimestamp,
  migrateLegacyCache,
  toReading,
  toUsageData,
  ensureUsageDir,
} from './cache.js';

// Coordination primitives, for a caller implementing its own fetch of a
// different endpoint against the same account.
export { acquireFetchLock, isFetchLockHeld } from './lock.js';

// Safe file IO. Exported because a participant writing its own derived
// artifacts beside these should apply the same ownership and mode rules.
export { readFileSecure, writeFileSecure, checkFileSafe, type FileSafetyIssue } from './secure-fs.js';

// Structured warning channel, so a caller's diagnostics land the same way.
export { warn } from './log.js';

/*
 * Credentials are deliberately NOT exported.
 *
 * `readCredentials` returns a live OAuth bearer token. It was exported on the
 * reasoning that a caller might want to know whether this machine has a
 * subscription token before showing any quota UI — but no caller ever asked,
 * and answering that question does not require handing over the token itself.
 * Both real consumers already learn it from `getUsage`, which returns
 * `source: 'none'` when there is no subscription to read.
 *
 * The export is the whole risk here: it puts a credential one import away from
 * any code that pulls in this package, including code written later by someone
 * who will not think about it. Fetching is this package's job precisely so
 * that nothing else has to hold the token.
 *
 * If a caller genuinely needs the has-a-subscription answer without a fetch,
 * add a `hasSubscription(): boolean` here. Do not re-export the reader.
 */

// Pure helpers, used by the tests and by renderers.
export {
  clamp,
  parseDate,
  parseExtraUsage,
  parseRetryAfter,
  jitteredBackoff,
  rehydrateDate,
  hydrateDates,
} from './parse.js';

// The HTTP layer, exported for tests that inject a transport.
export { requestApi, fetchApi, fetchJson, type RequestApiOpts, type RequestOutcome } from './api.js';

// Shared thresholds. A participant that uses different ones breaks the
// protocol for everybody — see §5.
export * from './constants.js';

export type {
  ApiError,
  BucketKey,
  BucketReading,
  CacheEntry,
  CreditGrantApiResponse,
  ExtraUsageData,
  ProfileApiResponse,
  Reading,
  UsageApiResponse,
  UsageData,
  UsageResult,
} from './types.js';
export { BUCKET_KEYS, BUCKET_WINDOW_MS, SCHEMA_VERSION } from './types.js';
