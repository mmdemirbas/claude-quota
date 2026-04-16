import { execFileSync } from 'node:child_process';
import type { GitStatus } from './types.js';

/**
 * Read the current branch and dirty-bit for `cwd`.
 *
 * Hardening notes. The plugin receives `cwd` from Claude Code, which in
 * turn gets it from the shell invoking Claude. We treat it as untrusted
 * input: a hostile `.git/config` in `cwd` can otherwise steer `git` into
 * running arbitrary commands via `core.fsmonitor`, `core.hooksPath`,
 * `core.sshCommand`, or `core.pager`. Each is disabled explicitly at the
 * command line so in-tree config cannot turn a read-only status into a
 * code execution primitive.
 *
 * Environment hardening is complementary: we prevent git from prompting
 * the terminal, from taking optional locks that could fail in read-only
 * dirs, and from loading a pager.
 */

/** Command-line overrides defeating the known in-tree-config code-exec paths. */
const SAFE_GIT_CONFIG: readonly string[] = [
  '-c', 'core.fsmonitor=false',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.sshCommand=false',
  '-c', 'core.pager=cat',
  '-c', 'core.editor=false',
  '-c', 'protocol.file.allow=user',
];

/** Extra environment scoping for every git invocation. */
const SAFE_GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_PAGER: 'cat',
  PAGER: 'cat',
};

const GIT_TIMEOUT_MS = 2000;

function runGit(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...SAFE_GIT_CONFIG, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: GIT_TIMEOUT_MS,
    env: SAFE_GIT_ENV,
    maxBuffer: 64 * 1024,
  }).trim();
}

export function getGitStatus(cwd: string): GitStatus | null {
  let branch: string;
  try {
    branch = runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  } catch {
    return null;
  }
  if (!branch) return null;

  let isDirty = false;
  try {
    const status = runGit(cwd, ['status', '--porcelain', '-uno']);
    isDirty = status.length > 0;
  } catch { /* status failed; assume clean rather than hiding the branch */ }

  return { branch, isDirty };
}
