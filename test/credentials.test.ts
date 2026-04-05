import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { getPlanName, parseCredentials, type CredentialsFile } from '../src/credentials.js';

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
