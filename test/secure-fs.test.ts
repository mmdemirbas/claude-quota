import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkFileSafe, readFileSecure, writeFileSecure } from '../src/secure-fs.js';

// POSIX-only behaviour: if the host lacks uid/chmod semantics (Windows CI),
// skip the suite rather than fake it.
const isPosix = process.platform !== 'win32' && typeof (process as NodeJS.Process & { getuid?: () => number }).getuid === 'function';

describe('secure-fs', { skip: !isPosix }, () => {
  let dir: string;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-quota-secfs-'));
  });
  after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(() => {
    for (const entry of fs.readdirSync(dir)) {
      fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
    }
  });

  // ── writeFileSecure ────────────────────────────────────────────────

  describe('writeFileSecure', () => {
    test('creates a new file with mode 0o600', () => {
      const p = path.join(dir, 'new.json');
      writeFileSecure(p, 'hello');
      const stat = fs.statSync(p);
      assert.equal(stat.mode & 0o777, 0o600);
      assert.equal(fs.readFileSync(p, 'utf8'), 'hello');
    });

    test('hardens an existing 0644 file on overwrite', () => {
      const p = path.join(dir, 'old.json');
      fs.writeFileSync(p, 'loose', { mode: 0o644 });
      fs.chmodSync(p, 0o644); // enforce despite umask
      assert.equal(fs.statSync(p).mode & 0o777, 0o644);

      writeFileSecure(p, 'tight');

      assert.equal(fs.statSync(p).mode & 0o777, 0o600);
      assert.equal(fs.readFileSync(p, 'utf8'), 'tight');
    });

    test('severs a pre-existing symlink rather than writing through it', () => {
      const real = path.join(dir, 'real.txt');
      fs.writeFileSync(real, 'outside');
      const link = path.join(dir, 'link');
      fs.symlinkSync(real, link);

      writeFileSecure(link, 'inside');

      // link should now be a regular file, not a symlink
      assert.ok(!fs.lstatSync(link).isSymbolicLink(), 'symlink was not severed');
      assert.equal(fs.readFileSync(link, 'utf8'), 'inside');
      // symlink target must be untouched
      assert.equal(fs.readFileSync(real, 'utf8'), 'outside');
    });

    test('does not leave .tmp files behind on success', () => {
      const p = path.join(dir, 'ok.json');
      writeFileSecure(p, '{}');
      const leftover = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
      assert.deepEqual(leftover, []);
    });
  });

  // ── checkFileSafe ──────────────────────────────────────────────────

  describe('checkFileSafe', () => {
    test('accepts a 0o600 file owned by current user', () => {
      const p = path.join(dir, 'safe.json');
      fs.writeFileSync(p, 'ok');
      fs.chmodSync(p, 0o600);
      const result = checkFileSafe(p);
      assert.deepEqual(result, { ok: true });
    });

    test('reports missing files distinctly', () => {
      const p = path.join(dir, 'nope.json');
      const result = checkFileSafe(p);
      assert.deepEqual(result, { ok: false, reason: 'missing' });
    });

    test('rejects world-readable mode', () => {
      const p = path.join(dir, 'loose.json');
      fs.writeFileSync(p, 'leak');
      fs.chmodSync(p, 0o644);
      const result = checkFileSafe(p);
      assert.deepEqual(result, { ok: false, reason: 'permissive-mode' });
    });

    test('rejects group-readable mode', () => {
      const p = path.join(dir, 'group.json');
      fs.writeFileSync(p, 'leak');
      fs.chmodSync(p, 0o640);
      const result = checkFileSafe(p);
      assert.deepEqual(result, { ok: false, reason: 'permissive-mode' });
    });

    test('rejects world-writable mode even when world-read is clear', () => {
      const p = path.join(dir, 'ww.json');
      fs.writeFileSync(p, 'x');
      fs.chmodSync(p, 0o602);
      const result = checkFileSafe(p);
      assert.deepEqual(result, { ok: false, reason: 'permissive-mode' });
    });

    test('rejects symlinks without following', () => {
      const real = path.join(dir, 'real.txt');
      fs.writeFileSync(real, 'x');
      fs.chmodSync(real, 0o600);
      const link = path.join(dir, 'link');
      fs.symlinkSync(real, link);
      const result = checkFileSafe(link);
      assert.deepEqual(result, { ok: false, reason: 'symlink' });
    });
  });

  // ── readFileSecure ─────────────────────────────────────────────────

  describe('readFileSecure', () => {
    test('returns content for a safe file', () => {
      const p = path.join(dir, 'safe.json');
      fs.writeFileSync(p, 'payload');
      fs.chmodSync(p, 0o600);
      const result = readFileSecure(p);
      assert.equal(result, 'payload');
    });

    test('returns null and invokes onReject for permissive files', () => {
      const p = path.join(dir, 'leak.json');
      fs.writeFileSync(p, 'payload');
      fs.chmodSync(p, 0o644);

      const reasons: string[] = [];
      const result = readFileSecure(p, (r) => reasons.push(r));

      assert.equal(result, null);
      assert.deepEqual(reasons, ['permissive-mode']);
    });

    test('returns null silently for missing files (no onReject call)', () => {
      const p = path.join(dir, 'missing.json');
      const reasons: string[] = [];
      const result = readFileSecure(p, (r) => reasons.push(r));
      assert.equal(result, null);
      assert.deepEqual(reasons, []);
    });

    test('returns null and flags symlinks', () => {
      const real = path.join(dir, 'real.json');
      fs.writeFileSync(real, 'payload');
      fs.chmodSync(real, 0o600);
      const link = path.join(dir, 'link.json');
      fs.symlinkSync(real, link);

      const reasons: string[] = [];
      const result = readFileSecure(link, (r) => reasons.push(r));

      assert.equal(result, null);
      assert.deepEqual(reasons, ['symlink']);
    });
  });

  // ── round-trip: write then read ────────────────────────────────────

  test('write then read round-trips and the file is 0o600', () => {
    const p = path.join(dir, 'roundtrip.json');
    writeFileSecure(p, '{"v":1}');
    const result = readFileSecure(p);
    assert.equal(result, '{"v":1}');
    assert.equal(fs.statSync(p).mode & 0o777, 0o600);
  });
});
