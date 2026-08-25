import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { readFileSecure } from './secure-fs.js';
import { warn } from './log.js';
import { configDir } from './paths.js';

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const KEYCHAIN_TIMEOUT_MS = 3000;

export interface Credentials {
  accessToken: string;
  subscriptionType: string;
  rateLimitTier?: string;
}

/** Exported for testing. */
export interface CredentialsFile {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    subscriptionType?: string;
    rateLimitTier?: string;  // e.g. "default_claude_max_5x"
    expiresAt?: number;
  };
}

/**
 * The keychain service name for this config directory, and only this one.
 *
 * Claude Code stores the default directory's credential under the bare service
 * name and every other directory's under `<service>-<8 hex of sha256(path)>`.
 * The mapping is one-to-one, and this function keeps it that way.
 *
 * It used to fall back to the bare name when a custom directory's hashed entry
 * was missing, on the theory that an older Claude Code might not have written
 * one yet. That fallback silently crosses accounts. `CLAUDE_CONFIG_DIR` is how
 * a second account is configured, so the case where the hashed entry is absent
 * is exactly the case where the bare entry belongs to *the other account* — and
 * the caller would then fetch one account's usage, label it with the other's
 * config, and (since the shared cache is keyed by config directory) write it
 * into the other account's cache file. Two accounts' numbers in one file, with
 * nothing on screen saying so.
 *
 * Failing closed is the right trade: no quota shown beats another account's
 * quota shown. A user who genuinely has no hashed entry can point
 * `.credentials.json` at the config directory, which `readFromFile` reads and
 * which cannot be ambiguous about whose it is.
 */
function getServiceName(): string {
  const defaultDir = path.normalize(path.resolve(path.join(os.homedir(), '.claude')));
  const normalizedConfig = path.normalize(path.resolve(configDir()));

  if (normalizedConfig === defaultDir) return KEYCHAIN_SERVICE;

  const hash = createHash('sha256').update(normalizedConfig).digest('hex').slice(0, 8);
  return `${KEYCHAIN_SERVICE}-${hash}`;
}

/** Exported for testing: the one service name this config directory may use. */
export function keychainServiceName(): string {
  return getServiceName();
}

/** Exported for testing. */
export function parseCredentials(data: CredentialsFile, now: number): Credentials | null {
  // Strip CRLF to prevent HTTP header injection if the token is ever used in an Authorization header
  const token = data.claudeAiOauth?.accessToken?.replace(/[\r\n]/g, '');
  if (!token) return null;

  const expiresAt = data.claudeAiOauth?.expiresAt;
  // Guard against type confusion: a non-numeric expiresAt (e.g. a date string) would produce
  // NaN in the <= comparison and silently bypass expiry. Treat non-numbers as expired.
  if (expiresAt != null && (typeof expiresAt !== 'number' || expiresAt <= now)) return null;

  return {
    accessToken: token,
    subscriptionType: data.claudeAiOauth?.subscriptionType ?? '',
    rateLimitTier: data.claudeAiOauth?.rateLimitTier,
  };
}

function readFromKeychain(now: number): Credentials | null {
  if (process.platform !== 'darwin') return null;

  const service = getServiceName();
  let accountName: string | null = null;
  try {
    accountName = os.userInfo().username.trim() || null;
  } catch { /* ignore */ }

  // One service, tried with the account name and then without. Both attempts
  // address the same keychain item; the account name is an extra qualifier that
  // some Claude Code versions set and others do not.
  const attempts: Array<[string, string | undefined]> = [];
  if (accountName) attempts.push([service, accountName]);
  attempts.push([service, undefined]);

  for (const [service, account] of attempts) {
    try {
      const args = account
        ? ['find-generic-password', '-s', service, '-a', account, '-w']
        : ['find-generic-password', '-s', service, '-w'];

      const raw = execFileSync('/usr/bin/security', args, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: KEYCHAIN_TIMEOUT_MS,
      }).trim();

      if (!raw) continue;
      const data: CredentialsFile = JSON.parse(raw);
      const creds = parseCredentials(data, now);
      if (creds) return creds;
    } catch {
      // Item not found or other error — try next
    }
  }

  return null;
}

/** Exported for testing. Reads `.credentials.json` under the Claude config dir. */
export function readFromFile(now: number): Credentials | null {
  const credPath = path.join(configDir(), '.credentials.json');
  // Refuse to read if perms/ownership would let another local user swap or
  // read the file. A compromised .credentials.json exposes a usable OAuth
  // bearer token — we'd rather fail auth than consume a planted file.
  const raw = readFileSecure(credPath, (reason) => {
    warn('credentials file rejected', { reason });
  });
  if (raw == null) return null;
  try {
    const data: CredentialsFile = JSON.parse(raw);
    return parseCredentials(data, now);
  } catch {
    return null;
  }
}

/** Read OAuth credentials — Keychain first, file fallback */
export function readCredentials(now: number = Date.now()): Credentials | null {
  return readFromKeychain(now) ?? readFromFile(now);
}

/** Derive plan name from subscription type and optional rate-limit tier. */
export function getPlanName(subscriptionType: string, rateLimitTier?: string): string | null {
  const lower = subscriptionType.toLowerCase();
  const tierLower = (rateLimitTier ?? '').toLowerCase();
  // Multiplier is in rateLimitTier (e.g. "default_claude_max_5x" → "5x")
  const multMatch = tierLower.match(/(\d+)x/) ?? lower.match(/(\d+)x/);
  const mult = multMatch ? ` ${multMatch[1]}x` : '';
  if (lower.includes('max') || tierLower.includes('max')) return `Max${mult}`;
  if (lower.includes('pro') || tierLower.includes('pro')) return 'Pro';
  if (lower.includes('team') || tierLower.includes('team')) return 'Team';
  if (!subscriptionType || lower.split(/[\s_-]+/).includes('api')) return null;
  return subscriptionType.charAt(0).toUpperCase() + subscriptionType.slice(1);
}
