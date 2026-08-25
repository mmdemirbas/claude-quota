import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getPlanName, parseCredentials, readFromFile, type CredentialsFile } from '../src/credentials.js';

const NOW = 1_700_000_000_000; // fixed reference timestamp (ms)

describe('parseCredentials', () => {
  test('returns null when accessToken is missing', () => {
    assert.equal(parseCredentials({}, NOW), null);
    assert.equal(parseCredentials({ claudeAiOauth: {} }, NOW), null);
  });

  test('returns credentials when token is present and not expired', () => {
    const data: CredentialsFile = {
      claudeAiOauth: {
        accessToken: 'tok',
        subscriptionType: 'claude_max_20',
        expiresAt: NOW + 3_600_000,
      },
    };
    const creds = parseCredentials(data, NOW);
    assert.ok(creds);
    assert.equal(creds.accessToken, 'tok');
    assert.equal(creds.subscriptionType, 'claude_max_20');
  });

  test('returns null when token is numerically expired', () => {
    const data: CredentialsFile = {
      claudeAiOauth: { accessToken: 'tok', expiresAt: NOW - 1 },
    };
    assert.equal(parseCredentials(data, NOW), null);
  });

  // Finding 4: type confusion — string expiresAt produces NaN comparison, bypassing expiry
  test('returns null when expiresAt is a string (type confusion)', () => {
    const data = {
      claudeAiOauth: {
        accessToken: 'tok',
        subscriptionType: 'claude_max_20',
        expiresAt: '2000-01-01T00:00:00Z' as unknown as number, // expired date as string
      },
    } satisfies CredentialsFile;
    assert.equal(parseCredentials(data, NOW), null);
  });

  // Finding 1: CRLF injection — newlines in token must be stripped before use in HTTP headers
  test('strips CR and LF from accessToken', () => {
    const data: CredentialsFile = {
      claudeAiOauth: { accessToken: 'tok\r\nX-Evil: injected', subscriptionType: 'claude_max_20' },
    };
    const creds = parseCredentials(data, NOW);
    assert.ok(creds);
    assert.equal(creds.accessToken, 'tokX-Evil: injected');
    assert.ok(!creds.accessToken.includes('\r'));
    assert.ok(!creds.accessToken.includes('\n'));
  });

  test('returns null when token is empty after stripping CRLF', () => {
    const data: CredentialsFile = {
      claudeAiOauth: { accessToken: '\r\n', subscriptionType: 'claude_max_20' },
    };
    assert.equal(parseCredentials(data, NOW), null);
  });
});

// readFromFile bypasses Keychain, so we can exercise the permission
// guard deterministically without interference from the host's macOS
// Keychain entries. POSIX-only.
const isPosix = process.platform !== 'win32';
describe('readFromFile permission guard', { skip: !isPosix }, () => {
  let tmpDir: string;
  let prevCfg: string | undefined;
  let prevSilent: string | undefined;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-quota-creds-'));
    prevCfg = process.env['CLAUDE_CONFIG_DIR'];
    prevSilent = process.env['CLAUDE_QUOTA_SILENT'];
    process.env['CLAUDE_CONFIG_DIR'] = tmpDir;
    process.env['CLAUDE_QUOTA_SILENT'] = '1';
  });

  after(() => {
    if (prevCfg === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
    else process.env['CLAUDE_CONFIG_DIR'] = prevCfg;
    if (prevSilent === undefined) delete process.env['CLAUDE_QUOTA_SILENT'];
    else process.env['CLAUDE_QUOTA_SILENT'] = prevSilent;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function writeCreds(mode: number, expiresAt: number): void {
    const credPath = path.join(tmpDir, '.credentials.json');
    const body = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'planted-tok',
        subscriptionType: 'claude_max_20',
        expiresAt,
      },
    });
    fs.writeFileSync(credPath, body);
    fs.chmodSync(credPath, mode);
  }

  test('returns credentials when file is 0o600', () => {
    writeCreds(0o600, Date.now() + 3_600_000);
    const result = readFromFile(Date.now());
    assert.ok(result);
    assert.equal(result.accessToken, 'planted-tok');
  });

  test('refuses to read a world-readable credentials file', () => {
    writeCreds(0o644, Date.now() + 3_600_000);
    const result = readFromFile(Date.now());
    assert.equal(result, null, 'permissive credentials file leaked a token');
  });

  test('refuses to read a group-readable credentials file', () => {
    writeCreds(0o640, Date.now() + 3_600_000);
    const result = readFromFile(Date.now());
    assert.equal(result, null);
  });

  test('refuses to read a symlinked credentials file', () => {
    const real = path.join(tmpDir, 'real-creds.json');
    fs.writeFileSync(real, JSON.stringify({
      claudeAiOauth: { accessToken: 'via-link', subscriptionType: 'x', expiresAt: Date.now() + 60_000 },
    }));
    fs.chmodSync(real, 0o600);
    const credPath = path.join(tmpDir, '.credentials.json');
    try { fs.unlinkSync(credPath); } catch { /* ignore */ }
    fs.symlinkSync(real, credPath);

    const result = readFromFile(Date.now());
    assert.equal(result, null, 'symlinked credentials file must not be followed');
  });
});

describe('getPlanName', () => {
  test('recognises Max plan', () => {
    assert.equal(getPlanName('claude_max_20'), 'Max');
    assert.equal(getPlanName('MAX'), 'Max');
  });

  test('recognises Pro plan', () => {
    assert.equal(getPlanName('claude_pro'), 'Pro');
    assert.equal(getPlanName('PRO'), 'Pro');
  });

  test('recognises Team plan', () => {
    assert.equal(getPlanName('claude_team'), 'Team');
  });

  test('returns null for API users', () => {
    assert.equal(getPlanName('api_user'), null);
    assert.equal(getPlanName('api'), null);
    assert.equal(getPlanName('claude_api'), null);
    assert.equal(getPlanName(''), null);
  });

  test('does not false-positive on subscription types containing "api" as substring', () => {
    // 'rapid' contains the substring 'api' but is not an API user
    assert.notEqual(getPlanName('rapid_plan'), null);
  });

  test('capitalises unknown plan types', () => {
    // Unknown subscription types are returned title-cased rather than rejected,
    // so new plan tiers surface in the UI before the code is updated.
    assert.equal(getPlanName('enterprise'), 'Enterprise');
  });
});
