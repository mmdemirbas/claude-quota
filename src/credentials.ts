import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const KEYCHAIN_TIMEOUT_MS = 3000;

export interface Credentials {
  accessToken: string;
  subscriptionType: string;
  rateLimitTier?: string;
}

interface CredentialsFile {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    subscriptionType?: string;
    rateLimitTier?: string;  // e.g. "default_claude_max_5x"
    expiresAt?: number;
  };
}

function getConfigDir(): string {
  const env = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (env) return env;
  return path.join(os.homedir(), '.claude');
}

function getServiceNames(): string[] {
  const configDir = getConfigDir();
  const defaultDir = path.normalize(path.resolve(path.join(os.homedir(), '.claude')));
  const normalizedConfig = path.normalize(path.resolve(configDir));

  if (normalizedConfig === defaultDir) {
    return [KEYCHAIN_SERVICE];
  }

  // Custom config dir: try hashed name first, legacy as fallback
  const hash = createHash('sha256').update(normalizedConfig).digest('hex').slice(0, 8);
  return [`${KEYCHAIN_SERVICE}-${hash}`, KEYCHAIN_SERVICE];
}

function parseCredentials(data: CredentialsFile, now: number): Credentials | null {
  const token = data.claudeAiOauth?.accessToken;
  if (!token) return null;

  const expiresAt = data.claudeAiOauth?.expiresAt;
  if (expiresAt != null && expiresAt <= now) return null;

  return {
    accessToken: token,
    subscriptionType: data.claudeAiOauth?.subscriptionType ?? '',
    rateLimitTier: data.claudeAiOauth?.rateLimitTier,
  };
}

function readFromKeychain(now: number): Credentials | null {
  if (process.platform !== 'darwin') return null;

  const serviceNames = getServiceNames();
  let accountName: string | null = null;
  try {
    accountName = os.userInfo().username.trim() || null;
  } catch { /* ignore */ }

  // Try with account name first, then without
  const attempts: Array<[string, string | undefined]> = [];
  for (const svc of serviceNames) {
    if (accountName) attempts.push([svc, accountName]);
  }
  for (const svc of serviceNames) {
    attempts.push([svc, undefined]);
  }

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

function readFromFile(now: number): Credentials | null {
  const credPath = path.join(getConfigDir(), '.credentials.json');
  try {
    if (!fs.existsSync(credPath)) return null;
    const data: CredentialsFile = JSON.parse(fs.readFileSync(credPath, 'utf8'));
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
  if (!subscriptionType || lower.includes('api')) return null;
  return subscriptionType.charAt(0).toUpperCase() + subscriptionType.slice(1);
}
