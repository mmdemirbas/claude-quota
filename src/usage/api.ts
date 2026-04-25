import * as https from 'node:https';
import { StringDecoder } from 'node:string_decoder';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { ApiError, UsageApiResponse } from '../types.js';
import { warn } from '../log.js';
import { API_TIMEOUT_MS, MAX_RESPONSE_BODY, MIN_TLS_VERSION } from './constants.js';
import { parseRetryAfter } from './parse.js';

// ── TLS TRUST MODEL ────────────────────────────────────────────────────────
//
// Calls to api.anthropic.com rely on Node's default HTTPS validation
// against the system certificate store. We do NOT pin Anthropic's
// certificate: Anthropic rotates its leaf cert and does not publish a
// pin set, so any hardcoded hash would eventually cause a hard outage.
//
// Implications the user should know:
//   - Anyone with the ability to install a trusted CA on the machine
//     (root/admin, or a corporate MDM profile) can MITM our API calls
//     and inject arbitrary usage data or redirect the OAuth token.
//   - Node's minimum TLS version is pinned in constants.ts; downgrade
//     attacks to SSLv3/TLSv1.0 are refused.
//
// Mitigations that already exist elsewhere:
//   - The dashboard escapes user-controlled fields so an injected
//     planName cannot execute script (see dashboard.ts _esc).
//   - Cache files are 0o600 so a MITM'd response still cannot be
//     read by other local users from disk (see secure-fs.ts).

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
 * status-code semantics).
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

export async function fetchApi(accessToken: string): Promise<{ data: UsageApiResponse | null; error?: ApiError; retryAfterSec?: number }> {
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

export async function fetchJson<T>(urlPath: string, accessToken: string): Promise<T | null> {
  const outcome = await requestApi(urlPath, accessToken);
  if (outcome.kind !== 'ok') return null;
  try { return JSON.parse(outcome.body) as T; }
  catch { return null; }
}
