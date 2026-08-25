import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureDashboardHtml } from '../src/dashboard.js';
import { dashboardHtmlPath } from '../src/paths.js';

/**
 * What ensureDashboardHtml owes its caller: after it returns, the file on disk
 * is this build's dashboard, at mode 0600.
 *
 * It runs on every statusline tick, so it is written to do as little as
 * possible — and the shortcut it took was wrong in a way no test could see
 * without constructing the collision deliberately.
 */
describe('ensureDashboardHtml', () => {
  let tmp: string;
  let saved: string | undefined;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-quota-dash-'));
    saved = process.env['CLAUDE_CONFIG_DIR'];
    process.env['CLAUDE_CONFIG_DIR'] = tmp;
  });

  after(() => {
    if (saved === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
    else process.env['CLAUDE_CONFIG_DIR'] = saved;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(() => {
    try { fs.rmSync(dashboardHtmlPath(), { force: true }); } catch { /* ignore */ }
  });

  test('writes the dashboard when none is there, at mode 0600', () => {
    ensureDashboardHtml();
    const p = dashboardHtmlPath();
    assert.ok(fs.existsSync(p), 'dashboard.html must exist');
    assert.equal(fs.statSync(p).mode & 0o777, 0o600);
    assert.match(fs.readFileSync(p, 'utf8'), /<!DOCTYPE html>/i);
  });

  test('leaves an identical file alone', () => {
    ensureDashboardHtml();
    const p = dashboardHtmlPath();
    const before = fs.statSync(p);
    ensureDashboardHtml();
    const after = fs.statSync(p);
    assert.equal(after.ino, before.ino,
      'an unchanged file must not be rewritten — this runs on every tick');
  });

  test('replaces a file that differs without differing in length', () => {
    /*
     * The case the size check could not see. Two builds of this plugin whose
     * HTML differs by a colour hex, a comparison operator, or a rename of the
     * same length have identical byte counts — so after an upgrade the old
     * dashboard stayed on disk permanently, with nothing anywhere reporting
     * that the page was from the previous build.
     */
    ensureDashboardHtml();
    const p = dashboardHtmlPath();
    const current = fs.readFileSync(p, 'utf8');

    const marker = '#0e0e12';
    assert.ok(current.includes(marker), 'precondition: the token to alter is present');
    const stale = current.replace(marker, '#0e0e13'); // same length, different build
    assert.equal(stale.length, current.length, 'precondition: the sizes must collide');
    fs.writeFileSync(p, stale, { mode: 0o600 });
    fs.chmodSync(p, 0o600);

    ensureDashboardHtml();
    assert.equal(fs.readFileSync(p, 'utf8'), current,
      'a same-length file from another build must be replaced');
  });

  test('replaces a world-readable copy even when the content matches', () => {
    // The dashboard's JS is re-read from disk on every poll, so a permissive
    // file is an execution path, not an untidiness.
    ensureDashboardHtml();
    const p = dashboardHtmlPath();
    fs.chmodSync(p, 0o644);
    ensureDashboardHtml();
    assert.equal(fs.statSync(p).mode & 0o777, 0o600);
  });
});
