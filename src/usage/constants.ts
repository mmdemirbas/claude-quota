/**
 * Magic numbers for the usage subsystem. Centralised so the cost/freshness
 * trade-offs are reviewable in one place rather than scattered across
 * cache, lock, api, and profile modules.
 */

export const CACHE_TTL_MS = 2 * 60_000;           // 2 min hard TTL (force re-fetch)
export const CACHE_SOFT_TTL_MS = 90_000;          // 90s soft TTL (serve stale + background refresh).
                                                  //   Doubled from 45s — background refresh fires
                                                  //   half as often, which roughly halves the per-
                                                  //   user request rate without changing the user-
                                                  //   visible freshness much (the line still rolls
                                                  //   over within the 2 min hard TTL).
export const CACHE_FAILURE_TTL_MS = 15_000;        // 15s for failures
export const CACHE_RATE_LIMITED_BASE_MS = 60_000;   // 60s base for 429 backoff
export const CACHE_RATE_LIMITED_MAX_MS = 10 * 60_000; // cap the dwell at 10 min so an aggressive
                                                      // sustained 429 doesn't hold the line indefinitely.
export const CACHE_RATE_LIMITED_JITTER = 0.2;       // ±20% backoff jitter to keep parallel instances
                                                    //   from re-converging onto the same retry boundary.
export const FETCH_COORDINATION_MS = 20_000;       // 20s — stale-lock reclaim threshold (must exceed API_TIMEOUT_MS so an in-flight fetch's lock isn't stolen by a peer)
export const PROFILE_CACHE_TTL_MS = 24 * 60 * 60_000; // 24h — org UUID rarely changes
export const CREDIT_GRANT_CACHE_TTL_MS = 10 * 60_000; // 10 min — balance changes only on top-up
// "No grant" is a much more stable state — most users never enable extra
// credits, and refetching every 10 min produces ~144 pointless API calls a
// day. Hold the null result for 24 h instead; a freshly-purchased grant
// will surface within a day, which is well inside the user's tolerance.
export const CREDIT_GRANT_NULL_TTL_MS = 24 * 60 * 60_000;
export const API_TIMEOUT_MS = 15_000;

// API-level limits.
export const MAX_RESPONSE_BODY = 1_048_576; // 1 MB body cap before we destroy the request.
export const MIN_TLS_VERSION = 'TLSv1.2' as const;
