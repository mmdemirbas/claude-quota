import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';

/**
 * A guard that never fires is worse than no guard: it makes a suite look
 * offline while it quietly spends real quota. Pin that it works.
 */
describe('the test-suite network guard', () => {
  test('refuses a request to the usage API', () => {
    assert.throws(
      () => https.request({ hostname: 'api.anthropic.com', path: '/api/oauth/usage' }),
      /Blocked network call to api\.anthropic\.com/,
    );
  });

  test('leaves loopback alone', () => {
    const req = https.request({ hostname: '127.0.0.1', port: 1, path: '/' });
    req.on('error', () => undefined);
    req.destroy();
    assert.ok(req);
  });
});
