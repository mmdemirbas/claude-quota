import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  dashboardFileUrl, dashboardHtmlPath,
  CACHE_VAR_DATA, CACHE_VAR_CREDIT_GRANT,
  CACHE_FILE_DATA, CACHE_FILE_CREDIT_GRANT,
} from '../src/paths.js';

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

// A2: cache-file ABI between usage.ts and dashboard.ts.
//
// Variable names and file names are pinned so that a refactor that
// renames one constant (but forgets to update the dashboard JS body,
// which still references DATA / CREDIT_GRANT literally) is caught at
// test time instead of at "user opens the dashboard and sees nothing".
describe('cache-file ABI is pinned', () => {
  test('global variable names match what dashboard.ts JS body reads', () => {
    assert.equal(CACHE_VAR_DATA, 'DATA',
      'DATA is referenced literally by dashboard.ts renderDashboard()');
    assert.equal(CACHE_VAR_CREDIT_GRANT, 'CREDIT_GRANT',
      'CREDIT_GRANT is referenced literally by dashboard.ts renderDashboard()');
  });

  test('cache file basenames are stable', () => {
    assert.equal(CACHE_FILE_DATA, 'data.js');
    assert.equal(CACHE_FILE_CREDIT_GRANT, 'credit-grant.js');
  });

  test('dashboard.ts source actually contains the literal references', () => {
    // The renderer JS body uses these names directly (not via interpolation).
    // If we ever rename the constants, this test catches the drift before
    // the dashboard silently breaks for users.
    const here = path.dirname(new URL(import.meta.url).pathname);
    const src = fs.readFileSync(path.resolve(here, '..', '..', 'src', 'dashboard.ts'), 'utf8');
    assert.ok(src.includes(`!${CACHE_VAR_DATA} || !${CACHE_VAR_DATA}.data`),
      `dashboard.ts must reference ${CACHE_VAR_DATA} in renderDashboard()`);
    assert.ok(src.includes(`typeof ${CACHE_VAR_CREDIT_GRANT} !== 'undefined'`),
      `dashboard.ts must reference ${CACHE_VAR_CREDIT_GRANT} in renderDashboard()`);
  });
});
