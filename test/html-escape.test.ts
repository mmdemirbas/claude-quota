import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as vm from 'node:vm';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { escapeHtml } from '../src/html-escape.js';

describe('escapeHtml', () => {
  test('escapes angle brackets', () => {
    assert.equal(escapeHtml('<script>alert(1)</script>'),
      '&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  test('escapes ampersands first (no double-escape)', () => {
    assert.equal(escapeHtml('&lt;'), '&amp;lt;');
  });

  test('escapes both quote types', () => {
    assert.equal(escapeHtml(`"'`), '&quot;&#39;');
  });

  test('handles the canonical XSS attribute-break payload', () => {
    const payload = `" onerror="alert(1)`;
    const escaped = escapeHtml(payload);
    assert.ok(!escaped.includes('"'), 'raw quote survived — attr breakout possible');
    assert.ok(escaped.includes('&quot;'));
  });

  test('handles tag-injection payload without leaking raw < or >', () => {
    const escaped = escapeHtml(`<img src=x onerror="fetch('//evil')">`);
    assert.ok(!escaped.includes('<'), 'raw < survived');
    assert.ok(!escaped.includes('>'), 'raw > survived');
    assert.ok(!escaped.includes('"'), 'raw " survived');
  });

  test('returns empty string for null/undefined', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
  });

  test('coerces non-strings safely', () => {
    assert.equal(escapeHtml(42), '42');
    assert.equal(escapeHtml(true), 'true');
  });

  test('leaves already-safe strings unchanged', () => {
    assert.equal(escapeHtml('Max 20x'), 'Max 20x');
    assert.equal(escapeHtml('Pro'), 'Pro');
  });
});

// ── Integration: dashboard escapes planName end-to-end ─────────────────

describe('dashboard XSS resistance', () => {
  // Extract the two <script> blocks embedded in dashboard.html. The first
  // is the loader (skipped — it pokes network on eval). The second is the
  // renderer we want to exercise.
  function loadDashboardHtml(): string {
    const here = path.dirname(new URL(import.meta.url).pathname);
    // dist-test/test/html-escape.test.js → project root → src/dashboard.ts
    const dashboardTsPath = path.resolve(here, '..', '..', 'src', 'dashboard.ts');
    return fs.readFileSync(dashboardTsPath, 'utf8');
  }

  function extractJsBlock(ts: string): string {
    // Grab the content between `const JS = \`` and the matching closing backtick.
    const marker = 'const JS = `';
    const start = ts.indexOf(marker);
    assert.ok(start >= 0, 'could not find JS block');
    const from = start + marker.length;
    const end = ts.indexOf('`;', from);
    assert.ok(end > from, 'could not find end of JS block');
    // Unescape TS template literal backslash sequences that aren't seen by vm.
    return ts.slice(from, end).replace(/\\`/g, '`').replace(/\\\\/g, '\\');
  }

  function runDashboardWith(planName: string): string {
    const ts = loadDashboardHtml();
    const jsSource = extractJsBlock(ts);

    // Minimal DOM shim — only what renderDashboard touches.
    let capturedHtml = '';
    const fakeApp = {
      set innerHTML(v: string) { capturedHtml = v; },
      get innerHTML() { return capturedHtml; },
    };
    const fakeDocument = {
      getElementById: (_id: string) => fakeApp,
    };
    const fakeData = {
      data: {
        planName,
        fiveHour: 25,
        fiveHourResetAt: new Date(Date.now() + 3600_000).toISOString(),
        sevenDay: null, sevenDayResetAt: null,
        sonnet: null, sonnetResetAt: null,
        opus: null, opusResetAt: null,
        extraUsage: null,
        fetchedAt: Date.now(),
      },
      timestamp: Date.now(),
    };

    const sandbox = {
      DATA: fakeData,
      document: fakeDocument,
      Date, Math, Number, String, Array, Object, JSON,
      console,
    };
    vm.createContext(sandbox);
    vm.runInContext(jsSource + '\nrenderDashboard();', sandbox);
    return capturedHtml;
  }

  test('safe plan names render as-is', () => {
    const html = runDashboardWith('Max 20x');
    assert.ok(html.includes('Max 20x'), 'benign name should appear');
  });

  test('script-tag injection does not land in DOM', () => {
    const payload = '<script>window.pwned=1</script>';
    const html = runDashboardWith(payload);
    assert.ok(!html.includes('<script>window.pwned'),
      `raw <script> tag must not appear in rendered HTML; got: ${html.slice(0, 400)}`);
    assert.ok(html.includes('&lt;script&gt;'),
      'expected escaped form to be present');
  });

  test('img/onerror injection does not land in DOM', () => {
    const payload = `<img src=x onerror="alert(1)">`;
    const html = runDashboardWith(payload);
    assert.ok(!html.includes('<img src=x'),
      'raw <img> must not appear');
    assert.ok(!html.includes('onerror="alert'),
      'raw onerror handler must not appear');
  });

  test('attribute-breakout payload does not escape its context', () => {
    const payload = `" onmouseover="alert(1)`;
    const html = runDashboardWith(payload);
    assert.ok(!html.includes('onmouseover="alert'),
      'attribute breakout must be neutralized');
  });
});
