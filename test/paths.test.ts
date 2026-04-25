import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { dashboardFileUrl, dashboardHtmlPath } from '../src/paths.js';

describe('dashboardFileUrl', () => {
  test('produces a parseable file:// URL', () => {
    const url = dashboardFileUrl();
    assert.ok(url.startsWith('file://'), `expected file:// scheme, got "${url}"`);
    // Round-trip through URL: must not throw.
    assert.doesNotThrow(() => new URL(url));
  });

  test('decoded pathname round-trips back to the on-disk path', () => {
    // Whatever dashboardHtmlPath returns, the URL pathname must map
    // back to it once percent-decoded — otherwise terminals will open
    // a different file (or fail to open anything).
    const url = new URL(dashboardFileUrl());
    assert.equal(decodeURIComponent(url.pathname), dashboardHtmlPath());
  });
});
