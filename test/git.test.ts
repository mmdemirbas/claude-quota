import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getGitStatus } from '../src/git.js';

// Require a working `git` binary on PATH. Skip the suite when absent so
// CI on minimal images doesn't fail spuriously.
let gitAvailable = false;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore', timeout: 2000 });
  gitAvailable = true;
} catch { /* git not installed */ }

describe('getGitStatus', { skip: !gitAvailable }, () => {
  let root: string;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-quota-git-'));
  });
  after(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function initRepo(name: string): string {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    // Local identity so commits don't fail on a machine without global config.
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
    return dir;
  }

  function commit(dir: string, file: string, body: string): void {
    fs.writeFileSync(path.join(dir, file), body);
    execFileSync('git', ['add', file], { cwd: dir });
    execFileSync('git', ['commit', '-qm', `add ${file}`], { cwd: dir });
  }

  test('returns branch and clean flag for a fresh repo with a commit', () => {
    const dir = initRepo('clean-repo');
    commit(dir, 'README.md', 'hello');

    const result = getGitStatus(dir);
    assert.deepEqual(result, { branch: 'main', isDirty: false });
  });

  test('reports dirty when working tree has uncommitted tracked changes', () => {
    const dir = initRepo('dirty-repo');
    commit(dir, 'f.txt', 'v1');
    fs.writeFileSync(path.join(dir, 'f.txt'), 'v2');

    const result = getGitStatus(dir);
    assert.ok(result);
    assert.equal(result.branch, 'main');
    assert.equal(result.isDirty, true);
  });

  test('ignores untracked files (-uno) — matches statusline convention', () => {
    const dir = initRepo('untracked');
    commit(dir, 'kept.txt', 'x');
    fs.writeFileSync(path.join(dir, 'new-untracked.txt'), 'ignored');

    const result = getGitStatus(dir);
    assert.equal(result?.isDirty, false, 'untracked files should not count as dirty');
  });

  test('returns null for a non-git directory', () => {
    const dir = path.join(root, 'not-a-repo');
    fs.mkdirSync(dir);
    assert.equal(getGitStatus(dir), null);
  });

  test('returns null for a nonexistent cwd', () => {
    assert.equal(getGitStatus(path.join(root, 'does-not-exist')), null);
  });

  // ── Hardening: in-tree .git/config must not steer git into code exec ──

  test('in-tree core.fsmonitor is blocked (cannot execute attacker command)', () => {
    const dir = initRepo('fsmonitor-attack');
    commit(dir, 'f.txt', 'x');

    // Plant a malicious fsmonitor that would create a marker file if executed.
    const marker = path.join(root, 'fsmonitor-marker');
    const script = path.join(root, 'fsmonitor.sh');
    fs.writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\n`);
    fs.chmodSync(script, 0o755);
    fs.appendFileSync(path.join(dir, '.git', 'config'),
      `\n[core]\n\tfsmonitor = ${script}\n`);

    getGitStatus(dir);

    assert.ok(!fs.existsSync(marker),
      'core.fsmonitor should be disabled via -c override; marker proves it ran');
  });

  test('in-tree core.hooksPath is blocked (post-commit-like hook cannot fire)', () => {
    const dir = initRepo('hookspath-attack');
    commit(dir, 'f.txt', 'x');

    const marker = path.join(root, 'hook-marker');
    const hookDir = path.join(root, 'evil-hooks');
    fs.mkdirSync(hookDir, { recursive: true });
    // post-index-change fires on `git status`; if hooksPath were honored this
    // would run and leave a marker behind.
    const hook = path.join(hookDir, 'post-index-change');
    fs.writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\n`);
    fs.chmodSync(hook, 0o755);
    fs.appendFileSync(path.join(dir, '.git', 'config'),
      `\n[core]\n\thooksPath = ${hookDir}\n`);

    fs.writeFileSync(path.join(dir, 'f.txt'), 'y'); // make status meaningful
    getGitStatus(dir);

    assert.ok(!fs.existsSync(marker),
      'core.hooksPath should be redirected to /dev/null; marker proves a hook ran');
  });

  test('in-tree core.pager is blocked (attacker cannot hijack stdout piping)', () => {
    const dir = initRepo('pager-attack');
    commit(dir, 'f.txt', 'x');

    const marker = path.join(root, 'pager-marker');
    const script = path.join(root, 'pager.sh');
    fs.writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\ncat\n`);
    fs.chmodSync(script, 0o755);
    fs.appendFileSync(path.join(dir, '.git', 'config'),
      `\n[core]\n\tpager = ${script}\n`);

    getGitStatus(dir);

    assert.ok(!fs.existsSync(marker),
      'core.pager should be set to cat via -c override');
  });

  test('detached HEAD reports "HEAD" as the branch name rather than null', () => {
    const dir = initRepo('detached');
    commit(dir, 'f.txt', 'a');
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    commit(dir, 'g.txt', 'b');
    execFileSync('git', ['checkout', '-q', sha], { cwd: dir });

    const result = getGitStatus(dir);
    assert.ok(result);
    assert.equal(result.branch, 'HEAD');
  });
});
