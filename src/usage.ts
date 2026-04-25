import * as fs from 'node:fs';
import * as path from 'node:path';
import * as https from 'node:https';
import { randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type {
  UsageApiResponse, UsageData, ExtraUsageData, CacheFile, ApiError,
  ProfileApiResponse, CreditGrantApiResponse, ProfileCacheFile, CreditGrantCacheFile,
} from './types.js';
import { readCredentials, getPlanName } from './credentials.js';
import { readFileSecure, writeFileSecure } from './secure-fs.js';
import { pluginDir, CACHE_VAR_DATA, CACHE_VAR_CREDIT_GRANT, CACHE_FILE_DATA, CACHE_FILE_CREDIT_GRANT } from './paths.js';
import { warn } from './log.js';

const CACHE_TTL_MS = 2 * 60_000;           // 2 min hard TTL (force re-fetch)
const CACHE_SOFT_TTL_MS = 90_000;          // 90s soft TTL (serve stale + background refresh).
                                            //   Doubled from 45s — background refresh fires
                                            //   half as often, which roughly halves the per-
                                            //   user request rate without changing the user-
                                            //   visible freshness much (the line still rolls
                                            //   over within the 2 min hard TTL).
const CACHE_FAILURE_TTL_MS = 15_000;        // 15s for failures
const CACHE_RATE_LIMITED_BASE_MS = 60_000;   // 60s base for 429 backoff
const CACHE_RATE_LIMITED_MAX_MS = 10 * 60_000; // cap the dwell at 10 min so an aggressive
                                                // sustained 429 doesn't hold the line indefinitely.
const CACHE_RATE_LIMITED_JITTER = 0.2;       // ±20% backoff jitter to keep parallel instances
                                              //   from re-converging onto the same retry boundary.
const FETCH_COORDINATION_MS = 20_000;       // 20s — stale-lock reclaim threshold (must exceed API_TIMEOUT_MS so an in-flight fetch's lock isn't stolen by a peer)
const PROFILE_CACHE_TTL_MS = 24 * 60 * 60_000; // 24h — org UUID rarely changes
const CREDIT_GRANT_CACHE_TTL_MS = 10 * 60_000; // 10 min — balance changes only on top-up
// "No grant" is a much more stable state — most users never enable extra
// credits, and refetching every 10 min produces ~144 pointless API calls a
// day. Hold the null result for 24 h instead; a freshly-purchased grant
// will surface within a day, which is well inside the user's tolerance.
const CREDIT_GRANT_NULL_TTL_MS = 24 * 60 * 60_000;
const API_TIMEOUT_MS = 15_000;

// On-disk cache files double as <script src> for the dashboard. Names
// are pinned in paths.ts so dashboard.ts can interpolate them into its
// loader without depending on this module.

function getCachePath(): string {
  return path.join(pluginDir(), CACHE_FILE_DATA);
}

function getProfileCachePath(): string {
  return path.join(pluginDir(), '.profile-cache.json');
}

function getCreditGrantCachePath(): string {
  return path.join(pluginDir(), CACHE_FILE_CREDIT_GRANT);
}

/**
 * Read JSON from a .js file that wraps it as `var NAME=<json>;`.
 *
 * Goes through readFileSecure so a world-writable or non-owned cache
 * file (e.g., planted by another local user) is refused — we will treat
 * the cache as missing and re-fetch rather than serve attacker data
 * into render/dashboard code paths.
 */
function readJsCache(filePath: string): string | null {
  const content = readFileSecure(filePath, (reason) => {
    warn('cache file rejected', { path: filePath, reason });
  });
  if (content == null) return null;
  const eqIdx = content.indexOf('=');
  if (eqIdx < 0) return null;
  // Strip "var NAME=" prefix and trailing ";"
  return content.slice(eqIdx + 1).replace(/;\s*$/, '');
}

/** Write JSON to a .js file as `var NAME=<json>;` */
function writeJsCache(filePath: string, varName: string, json: string): void {
  writeCacheFile(filePath, `var ${varName}=${json};`);
}

// ── Cache ──────────────────────────────────────────────────────────────────

/**
 * Coerce a JSON-deserialized date value (string from the on-disk cache,
 * or already-a-Date if hydrateDates is called twice) back to a Date.
 * Returns null on a malformed or non-parseable value so the renderer
 * never sees an Invalid Date — that previously leaked NaN/undefined into
 * the bar/glyph rendering. Exported for testing.
 */
export function rehydrateDate(v: unknown): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function hydrateDates(data: UsageData): UsageData {
  return {
    ...data,
    fiveHourResetAt: rehydrateDate(data.fiveHourResetAt),
    sevenDayResetAt: rehydrateDate(data.sevenDayResetAt),
    sonnetResetAt: rehydrateDate(data.sonnetResetAt),
    opusResetAt: rehydrateDate(data.opusResetAt),
  };
}

/**
 * 429 backoff with multiplicative jitter.
 *
 * Without jitter, every instance with the same `rateLimitedCount`
 * computes the same retry boundary — they wake up together, fetch
 * together, and re-trigger the same 429 in lockstep. Multiplying the
 * deterministic backoff by a uniform value in [1 - J, 1 + J] keeps
 * concurrent retriers desynchronised.
 *
 * Exported for testing.
 */
export function jitteredBackoff(rateLimitedCount: number, rng: () => number = Math.random): number {
  const exp = Math.pow(2, Math.max(0, rateLimitedCount - 1));
  const base = Math.min(CACHE_RATE_LIMITED_BASE_MS * exp, CACHE_RATE_LIMITED_MAX_MS);
  const factor = 1 + (rng() * 2 - 1) * CACHE_RATE_LIMITED_JITTER;
  return Math.round(base * factor);
}

function readCache(now: number): { data: UsageData; isStale: boolean } | null {
  try {
    const raw = readJsCache(getCachePath());
    if (!raw) return null;
    const cache: CacheFile = JSON.parse(raw);

    // Handle rate-limit backoff
    if (cache.data.apiError === 'rate-limited' && cache.rateLimitedCount) {
      // retryAfterUntil is preferred — set either from the server's
      // Retry-After header or as a jittered count-derived backoff at
      // write time. The fallback below covers caches written before the
      // jitter migration and stays bounded by CACHE_RATE_LIMITED_MAX_MS.
      const backoff = Math.min(
        CACHE_RATE_LIMITED_BASE_MS * Math.pow(2, Math.max(0, cache.rateLimitedCount - 1)),
        CACHE_RATE_LIMITED_MAX_MS,
      );
      const retryUntil = cache.retryAfterUntil ?? (cache.timestamp + backoff);
      if (now < retryUntil) {
        // Still in backoff — return last good data with syncing hint; never trigger background refresh
        const display = cache.lastGoodData
          ? { ...hydrateDates(cache.lastGoodData), apiError: 'rate-limited' as const }
          : hydrateDates(cache.data);
        return { data: { ...display, fetchedAt: cache.timestamp }, isStale: false };
      }
      // Backoff expired — fetch fresh regardless of failure TTL
      return null;
    }

    const ttl = cache.data.apiUnavailable ? CACHE_FAILURE_TTL_MS : CACHE_TTL_MS;
    const age = now - cache.timestamp;
    if (age < ttl) {
      // No fetcher-death detection here: the .fetch.lock file's stale-
      // reclaim covers that. If a fetcher died mid-flight, the next
      // acquireFetchLock caller picks up the lock after FETCH_COORDINATION_MS
      // and re-fetches; this read path just serves the (slightly stale)
      // cache until then.
      const display = (cache.data.apiError === 'rate-limited' && cache.lastGoodData)
        ? { ...hydrateDates(cache.lastGoodData), apiError: 'rate-limited' as const }
        : hydrateDates(cache.data);
      // Only mark stale for successful responses; failures have a short TTL already
      const isStale = !cache.data.apiUnavailable && age >= CACHE_SOFT_TTL_MS;
      return { data: { ...display, fetchedAt: cache.timestamp }, isStale };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Pull rate-limit counter + last-good snapshot out of an on-disk cache file
 * for use when writing a *failure* entry. Both fields must be preserved
 * across consecutive failures (rate-limited or not) so that:
 *   - the next 429 keeps escalating exponential backoff instead of restarting
 *   - the rate-limit display can keep showing the prior good values
 *
 * Exported for testing.
 */
export function recoverCacheState(cachePath: string): { prevCount: number; lastGoodData: UsageData | undefined } {
  try {
    const rawJs = readJsCache(cachePath);
    if (!rawJs) return { prevCount: 0, lastGoodData: undefined };
    const prev: CacheFile = JSON.parse(rawJs);
    return {
      prevCount: prev.rateLimitedCount ?? 0,
      lastGoodData: prev.lastGoodData ?? (!prev.data.apiUnavailable ? prev.data : undefined),
    };
  } catch {
    return { prevCount: 0, lastGoodData: undefined };
  }
}

function writeCache(data: UsageData, timestamp: number, opts?: Partial<CacheFile>): void {
  const cache: CacheFile = { data, timestamp, ...opts };
  writeJsCache(getCachePath(), CACHE_VAR_DATA, JSON.stringify(cache));
}

// ── API ────────────────────────────────────────────────────────────────────
//
// TLS TRUST MODEL
// ───────────────
// Calls to api.anthropic.com rely on Node's default HTTPS validation
// against the system certificate store. We do NOT pin Anthropic's
// certificate: Anthropic rotates its leaf cert and does not publish a
// pin set, so any hardcoded hash would eventually cause a hard outage.
//
// Implications the user should know:
//   - Anyone with the ability to install a trusted CA on the machine
//     (root/admin, or a corporate MDM profile) can MITM our API calls
//     and inject arbitrary usage data or redirect the OAuth token.
//   - Node's minimum TLS version is pinned below to TLSv1.2; downgrade
//     attacks to SSLv3/TLSv1.0 are refused.
//
// Mitigations that already exist elsewhere:
//   - The dashboard escapes user-controlled fields so an injected
//     planName cannot execute script (see dashboard.ts _esc).
//   - Cache files are 0o600 so a MITM'd response still cannot be
//     read by other local users from disk (see secure-fs.ts).

const MAX_RESPONSE_BODY = 1_048_576; // 1 MB guard
const MIN_TLS_VERSION = 'TLSv1.2' as const;

/**
 * Collect a response body up to MAX_RESPONSE_BODY bytes.
 *
 * Uses StringDecoder so a multi-byte UTF-8 character split across two
 * chunks does not become a U+FFFD replacement. Calls req.destroy() when
 * the cap is reached so the connection stops downloading bytes the
 * caller will never read; without this the previous pre-append guard
 * silently kept the socket draining for whatever the server still had
 * queued.
 *
 * Returns { body, overflowed }: when overflowed is true, the caller
 * should treat the body as malformed (it was truncated mid-stream).
 */
function collectBody(req: ClientRequest, res: IncomingMessage): Promise<{ body: string; overflowed: boolean }> {
  return new Promise((resolve) => {
    const decoder = new StringDecoder('utf8');
    let body = '';
    let bytes = 0;
    let overflowed = false;
    res.on('data', (c: Buffer) => {
      if (overflowed) return;
      bytes += c.length;
      if (bytes > MAX_RESPONSE_BODY) {
        overflowed = true;
        req.destroy();
        return;
      }
      body += decoder.write(c);
    });
    res.on('end', () => {
      if (!overflowed) body += decoder.end();
      resolve({ body, overflowed });
    });
    res.on('error', () => resolve({ body, overflowed }));
  });
}

/**
 * Outcome of an HTTP exchange before per-endpoint interpretation. The
 * shared request helper resolves to one of these; each fetcher then
 * casts the body to its specific JSON shape (or applies its own
 * status-code semantics). Exported for testing.
 */
export type RequestOutcome =
  | { kind: 'ok'; body: string }
  | { kind: 'overflow' }                                  // body exceeded MAX_RESPONSE_BODY
  | { kind: 'http'; statusCode: number; headers: IncomingMessage['headers'] }
  | { kind: 'network' }
  | { kind: 'timeout' };

/**
 * Test seam: requestApi can be handed a custom `https.request`-shaped
 * function and an explicit timeout. Production callers omit both.
 */
export interface RequestApiOpts {
  /** Override the absolute-deadline timeout. Defaults to API_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Override the transport. Defaults to https.request. */
  httpsRequest?: typeof https.request;
}

/**
 * Issue a GET to api.anthropic.com and resolve once one of:
 *   - response received with statusCode === 200 → kind: 'ok'
 *   - response received with non-2xx           → kind: 'http'
 *   - body overflowed MAX_RESPONSE_BODY        → kind: 'overflow'
 *   - socket error                             → kind: 'network'
 *   - per-activity OR absolute deadline tripped → kind: 'timeout'
 *
 * The absolute deadline is essential for slow-loris tolerance:
 * `req.timeout` is per-activity, so a server that trickles bytes slower
 * than the interval can hold the connection open indefinitely. The
 * setTimeout below destroys the request after `timeoutMs` regardless.
 *
 * Exported for testing (R1 regression test).
 */
export function requestApi(
  urlPath: string,
  accessToken: string,
  opts?: RequestApiOpts,
): Promise<RequestOutcome> {
  return new Promise((resolve) => {
    const timeoutMs = opts?.timeoutMs ?? API_TIMEOUT_MS;
    const requestFn = opts?.httpsRequest ?? https.request;
    let settled = false;
    let deadline: NodeJS.Timeout | undefined;
    const finish = (v: RequestOutcome): void => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      resolve(v);
    };

    const req = requestFn({
      hostname: 'api.anthropic.com',
      path: urlPath,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'claude-quota/0.2',
      },
      minVersion: MIN_TLS_VERSION,
      timeout: timeoutMs,
    }, (res) => {
      void collectBody(req, res).then(({ body, overflowed }) => {
        if (overflowed) { finish({ kind: 'overflow' }); return; }
        if (res.statusCode === 200) { finish({ kind: 'ok', body }); return; }
        finish({ kind: 'http', statusCode: res.statusCode ?? 0, headers: res.headers });
      });
    });

    req.on('error', () => finish({ kind: 'network' }));
    req.on('timeout', () => { req.destroy(); finish({ kind: 'timeout' }); });
    deadline = setTimeout(() => { req.destroy(); finish({ kind: 'timeout' }); }, timeoutMs);
    req.end();
  });
}

async function fetchApi(accessToken: string): Promise<{ data: UsageApiResponse | null; error?: ApiError; retryAfterSec?: number }> {
  const outcome = await requestApi('/api/oauth/usage', accessToken);
  switch (outcome.kind) {
    case 'ok': {
      try { return { data: JSON.parse(outcome.body) as UsageApiResponse }; }
      catch { return { data: null, error: 'parse' }; }
    }
    case 'overflow': return { data: null, error: 'parse' };
    case 'network':  return { data: null, error: 'network' };
    case 'timeout':  return { data: null, error: 'timeout' };
    case 'http': {
      const code = outcome.statusCode;
      const error: ApiError = code === 429 ? 'rate-limited' : `http-${code}`;
      const retryRaw = outcome.headers['retry-after'];
      const retryVal = Array.isArray(retryRaw) ? retryRaw[0] : retryRaw;
      const retryAfterSec = parseRetryAfter(retryVal, Date.now());
      // Surface auth failures distinctly so a revoked or rotated token
      // does not present as a generic "API down". 429 stays quiet —
      // rate-limits are handled with UI backoff, not warnings.
      if (code === 401 || code === 403) warn('usage API auth failed', { code });
      return { data: null, error, retryAfterSec };
    }
  }
}

// ── Parsing ────────────────────────────────────────────────────────────────

/**
 * Clamp API utilization to integer 0-100.
 * The API returns values in the 0-100 range (not 0-1).
 * Exported for testing.
 */
export function clamp(v: number | undefined | null): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  return Math.round(Math.max(0, Math.min(100, v)));
}

/**
 * Parse a `Retry-After` header value (RFC 7231 §7.1.3).
 *
 * Two accepted formats:
 *   - delta-seconds   →   "120"
 *   - HTTP-date       →   "Wed, 21 Oct 2026 07:28:00 GMT"
 *
 * Returns the delay in seconds (rounded to integer, never negative)
 * or undefined for missing/malformed values. Exported for testing.
 */
export function parseRetryAfter(raw: string | undefined, now: number): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  // Integer-seconds form. Reject non-numeric strings explicitly so
  // "Wed, 21 Oct 2026..." doesn't parse as 0 via parseInt's prefix
  // tolerance — it would, since "21" is a valid prefix of "21 Oct".
  if (/^\d+$/.test(trimmed)) {
    const sec = parseInt(trimmed, 10);
    return Number.isFinite(sec) ? sec : undefined;
  }

  // HTTP-date form. Date.parse handles RFC 1123 / RFC 850 / asctime
  // shapes. Convert to seconds-from-now, clamped to ≥ 0 (a date in
  // the past means "you can retry now").
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(0, Math.round((parsed - now) / 1000));
}

/** Exported for testing. */
export function parseDate(s: string | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/** Coerce an API monetary field to a non-negative finite dollar amount, or null when unparseable. */
function parseMinorUnits(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return v / 100;
}

/** Exported for testing. */
export function parseExtraUsage(raw: UsageApiResponse['extra_usage']): ExtraUsageData | null {
  if (raw == null) return null; // API didn't return extra_usage at all
  if (!raw.is_enabled) return { enabled: false };

  // API returns values in cents; convert to dollars. A non-numeric field
  // (e.g. schema drift or MITM-injected garbage) must not produce NaN
  // percentages in the renderer — treat "enabled but unparseable" as if
  // the quota were absent.
  const monthlyLimit = parseMinorUnits(raw.monthly_limit);
  if (monthlyLimit == null || monthlyLimit === 0) return null;

  const usedRaw = raw.used_credits ?? 0;
  const usedCredits = parseMinorUnits(usedRaw) ?? 0;

  return {
    enabled: true,
    monthlyLimit,
    usedCredits,
    creditGrant: null, // filled later by getCreditGrant()
  };
}

// ── Multi-instance coordination ───────────────────────────────────────────

/**
 * Bump the cache timestamp without changing data.
 *
 * Prevents parallel instances from all *spawning a background refresh*
 * at the same time: downstream `readCache` consumers see a fresh
 * timestamp (so age < CACHE_SOFT_TTL_MS, isStale=false) and don't
 * trigger another spawn. Fetch coordination is owned by the
 * .fetch.lock file — this function only suppresses redundant spawns.
 *
 * Exported so the parent process can bump *before* spawning the
 * detached background refresher.
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

/** Cache file writer: plugin dir is created if missing, output is atomic and 0o600. */
function writeCacheFile(filePath: string, content: string): void {
  try {
    fs.mkdirSync(pluginDir(), { recursive: true });
  } catch { /* ignore */ }
  writeFileSecure(filePath, content);
}

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

function getCreditGrantLockPath(): string {
  return path.join(pluginDir(), '.credit-grant.lock');
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
 *
 * Exported for testing.
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

// ── Profile & credit grant caching ────────────────────────────────────────

interface ProfileData {
  orgUUID: string;
  rateLimitTier?: string;
  organizationType?: string;
}

function readProfileCache(now: number): ProfileData | null {
  const raw = readFileSecure(getProfileCachePath(), (reason) => {
    warn('profile cache rejected', { reason });
  });
  if (raw == null) return null;
  try {
    const cache: ProfileCacheFile = JSON.parse(raw);
    if (now - cache.timestamp < PROFILE_CACHE_TTL_MS && cache.orgUUID) {
      // Force re-fetch if cache was written before we started storing tier info
      if (!cache.rateLimitTier) return null;
      return { orgUUID: cache.orgUUID, rateLimitTier: cache.rateLimitTier, organizationType: cache.organizationType };
    }
    return null;
  } catch { return null; }
}

function writeProfileCache(data: ProfileData, timestamp: number): void {
  const cache: ProfileCacheFile = { orgUUID: data.orgUUID, rateLimitTier: data.rateLimitTier, organizationType: data.organizationType, timestamp };
  writeCacheFile(getProfileCachePath(), JSON.stringify(cache));
}

function readCreditGrantCache(now: number): { hit: true; value: number | null } | null {
  try {
    const raw = readJsCache(getCreditGrantCachePath());
    if (!raw) return null;
    const cache: CreditGrantCacheFile = JSON.parse(raw);
    const ttl = cache.creditGrant === null ? CREDIT_GRANT_NULL_TTL_MS : CREDIT_GRANT_CACHE_TTL_MS;
    if (now - cache.timestamp < ttl) {
      return { hit: true, value: cache.creditGrant };
    }
    return null;
  } catch { return null; }
}

function writeCreditGrantCache(creditGrant: number | null, timestamp: number): void {
  const cache: CreditGrantCacheFile = { creditGrant, timestamp };
  writeJsCache(getCreditGrantCachePath(), CACHE_VAR_CREDIT_GRANT, JSON.stringify(cache));
}

// ── Generic HTTPS JSON GET ────────────────────────────────────────────────

async function fetchJson<T>(urlPath: string, accessToken: string): Promise<T | null> {
  const outcome = await requestApi(urlPath, accessToken);
  if (outcome.kind !== 'ok') return null;
  try { return JSON.parse(outcome.body) as T; }
  catch { return null; }
}

// ── Profile + credit grant public API ─────────────────────────────────────

/**
 * Make sure the profile cache is populated before code that depends on
 * it runs. Fast path: profile cache hit returns immediately. Cold path:
 * one /api/oauth/profile fetch then write to the profile cache.
 *
 * This exists so the parent process can sequence a profile-cache warm
 * up *before* getUsage's livePlanName runs in parallel — without it,
 * the first render after a fresh install or a 24-hour profile-TTL
 * expiry shows a plan name derived from the (potentially stale)
 * credentials file instead of the live API tier.
 */
export async function ensureProfileCached(): Promise<void> {
  const now = Date.now();
  if (readProfileCache(now)) return;

  const creds = readCredentials(now);
  if (!creds) return;

  const profile = await fetchJson<ProfileApiResponse>('/api/oauth/profile', creds.accessToken);
  const uuid = profile?.organization?.uuid;
  if (!uuid) return;
  writeProfileCache({
    orgUUID: uuid,
    rateLimitTier: profile.organization?.rate_limit_tier,
    organizationType: profile.organization?.organization_type,
  }, now);
}

/**
 * Fetch the prepaid credit grant balance.
 * Returns credit grant in dollars, or null if unavailable.
 * Uses separate caches for profile (24h TTL) and credit grant (10min TTL).
 */
export async function getCreditGrant(): Promise<number | null> {
  const now = Date.now();

  // Check credit grant cache first (wrapper distinguishes "no grant" from "cache miss")
  const cached = readCreditGrantCache(now);
  if (cached) return cached.value;

  // Cold path: about to hit /api/oauth/profile and/or
  // /api/oauth/organizations/.../overage_credit_grant. Acquire a
  // dedicated lock so N parallel claude-quota processes don't
  // fan out to N profile + N grant calls — the same thundering-
  // herd that the usage-fetch lock guards against.
  const lock = acquireFetchLock(now, getCreditGrantLockPath());
  if (!lock) {
    // Peer is already fetching. Re-check the cache: if its write
    // landed between our miss above and the lock check, serve it.
    const recheck = readCreditGrantCache(now);
    return recheck ? recheck.value : null;
  }

  try {
    // Need credentials for API calls
    const creds = readCredentials(now);
    if (!creds) return null;

    // Get org UUID (from cache or profile API). May have already been
    // populated by ensureProfileCached() running ahead of us in
    // index.ts; cache hit is the common case.
    let profileData = readProfileCache(now);
    if (!profileData) {
      const profile = await fetchJson<ProfileApiResponse>('/api/oauth/profile', creds.accessToken);
      const uuid = profile?.organization?.uuid;
      if (!uuid) return null;
      profileData = {
        orgUUID: uuid,
        rateLimitTier: profile?.organization?.rate_limit_tier,
        organizationType: profile?.organization?.organization_type,
      };
      writeProfileCache(profileData, now);
    }

    // Fetch credit grant
    const grant = await fetchJson<CreditGrantApiResponse>(
      `/api/oauth/organizations/${encodeURIComponent(profileData.orgUUID)}/overage_credit_grant`,
      creds.accessToken,
    );
    if (!grant || !grant.granted || grant.amount_minor_units == null) {
      writeCreditGrantCache(null, now);
      return null;
    }

    // Convert cents to dollars
    const dollars = grant.amount_minor_units / 100;
    writeCreditGrantCache(dollars, now);
    return dollars;
  } finally {
    lock.release();
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

/**
 * Test seam: callers can inject a fake fetcher for integration tests
 * without spinning up an HTTP server. Production callers omit it.
 */
export type FetchApiFn = typeof fetchApi;

export async function getUsage(opts?: { forceRefresh?: boolean; fetcher?: FetchApiFn }): Promise<{ data: UsageData | null; isStale: boolean }> {
  const now = Date.now();

  // Derive plan name from profile cache (live API tier) → credentials (bootstrap fallback).
  // Profile API's organization.rate_limit_tier is the authoritative source; credential
  // rateLimitTier can be stale after plan upgrades until Claude Code refreshes the OAuth token.
  //
  // `skipCreds` is set on the cache-hit hot path: every render that doesn't
  // need a fresh fetch would otherwise pay a Keychain `security` invocation
  // (~50–200 ms) just to re-confirm the plan name we already have. The
  // profile-cache lookup is cheap (a single 0o600 file read), so we still
  // prefer it; we just don't fall back to credentials when the cache hit
  // already carried a plan name.
  const livePlanName = (skipCreds = false): string | null => {
    const profile = readProfileCache(now);
    if (profile?.rateLimitTier || profile?.organizationType) {
      const fromProfile = getPlanName(profile.organizationType ?? '', profile.rateLimitTier);
      if (fromProfile) return fromProfile;
    }
    if (skipCreds) return null;
    const creds = readCredentials(now);
    return creds ? getPlanName(creds.subscriptionType, creds.rateLimitTier) : null;
  };

  // Check cache first — serve cached data regardless of env settings
  if (!opts?.forceRefresh) {
    const cached = readCache(now);
    if (cached) {
      // Re-derive planName from the profile cache only. The cached planName
      // already came from a successful fetch's credentials/profile; falling
      // back to readCredentials here would Keychain-hit on every tick.
      const fresh = livePlanName(/* skipCreds */ true);
      if (fresh) cached.data = { ...cached.data, planName: fresh };
      else if (!cached.data.planName) {
        // Cache somehow predates the planName field — last-resort full lookup.
        const full = livePlanName();
        if (full) cached.data = { ...cached.data, planName: full };
      }
      return cached;
    }
  }

  const none = { data: null, isStale: false } as const;

  // Skip fetching if using a non-Anthropic API endpoint
  const baseUrl = (process.env.ANTHROPIC_BASE_URL ?? process.env.ANTHROPIC_API_BASE_URL ?? '').trim();
  if (baseUrl) {
    try {
      if (new URL(baseUrl).origin !== 'https://api.anthropic.com') return none;
    } catch { return none; }
  }

  // Read credentials
  const creds = readCredentials(now);
  if (!creds) return none;

  const planName = livePlanName();
  if (!planName) return none; // API user

  // Try to acquire the cross-instance fetch lock. If we don't get it,
  // another claude-quota process is already fetching — re-read the
  // cache (it may have just landed) and serve whatever's there. This is
  // the main rate-limit safety valve: with N parallel windows open we
  // emit at most one upstream call instead of N.
  const lock = acquireFetchLock(now);
  if (!lock) {
    const cached = readCache(now);
    if (cached) return cached;
    // No cache and no lock — yield without firing a duplicate request.
    return none;
  }

  // We hold the lock. Bump the cache so parallel instances reading
  // through readCache see a fresh-looking entry and don't pile on with
  // their own background-refresh spawns.
  bumpCacheTimestamp(now);

  let result;
  try {
    result = await (opts?.fetcher ?? fetchApi)(creds.accessToken);
  } finally {
    lock.release();
  }

  if (!result.data) {
    const isRateLimit = result.error === 'rate-limited';
    const failure: UsageData = {
      planName,
      fiveHour: null, fiveHourResetAt: null,
      sevenDay: null, sevenDayResetAt: null,
      sonnet: null, sonnetResetAt: null,
      opus: null, opusResetAt: null,
      extraUsage: null,
      apiUnavailable: true,
      apiError: result.error,
    };

    // Recover last good data and prior backoff count from the cache. Both
    // are preserved across non-429 failures too — without this, a single
    // intermittent 500 between two 429s wiped lastGoodData (so the user
    // saw "no data" instead of last-good values) and reset the rate-limit
    // counter (defeating exponential backoff escalation).
    const { prevCount, lastGoodData } = recoverCacheState(getCachePath());

    if (isRateLimit) {
      const newCount = prevCount + 1;
      writeCache(failure, now, {
        rateLimitedCount: newCount,
        // Prefer the server's Retry-After when present; otherwise derive
        // a jittered backoff so parallel instances coming off the same
        // count don't all retry at exactly the same instant.
        retryAfterUntil: result.retryAfterSec
          ? now + result.retryAfterSec * 1000
          : now + jitteredBackoff(newCount),
        lastGoodData,
      });
      const data = lastGoodData
        ? { ...hydrateDates(lastGoodData), apiError: 'rate-limited' as const }
        : failure;
      return { data, isStale: false };
    }

    // Non-429 failure: keep the prior counter and last-good snapshot intact
    // so a 429 that follows still finds them.
    writeCache(failure, now, { rateLimitedCount: prevCount, lastGoodData });
    return { data: failure, isStale: false };
  }

  // Parse full response
  const usage: UsageData = {
    planName,
    fetchedAt: now,
    fiveHour: clamp(result.data.five_hour?.utilization),
    fiveHourResetAt: parseDate(result.data.five_hour?.resets_at),
    sevenDay: clamp(result.data.seven_day?.utilization),
    sevenDayResetAt: parseDate(result.data.seven_day?.resets_at),
    sonnet: clamp(result.data.seven_day_sonnet?.utilization),
    sonnetResetAt: parseDate(result.data.seven_day_sonnet?.resets_at),
    opus: clamp(result.data.seven_day_opus?.utilization),
    opusResetAt: parseDate(result.data.seven_day_opus?.resets_at),
    extraUsage: parseExtraUsage(result.data.extra_usage),
  };

  writeCache(usage, now, { lastGoodData: usage, rateLimitedCount: 0 });
  return { data: usage, isStale: false };
}
