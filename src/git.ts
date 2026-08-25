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
    // `rev-parse` fails on an unborn HEAD, so a freshly-initialised repository
    // showed no branch at all. `--show-current` answers there.
    try {
      branch = runGit(cwd, ['branch', '--show-current']);
    } catch {
      return null;
    }
  }
  if (!branch) return null;

  /*
   * Dirtiness by exit code, not by reading a listing.
   *
   * `status --porcelain -uno` prints one line per modified file, and runGit
   * caps output at 64 KB. About nine hundred modified files with long paths
   * exceeds that, execFileSync throws ENOBUFS, the catch below swallows it, and
   * a thoroughly dirty repository renders as clean — measured at 87 300 bytes
   * on a repo with every tracked file modified. The bigger the change, the more
   * likely the indicator is wrong, which is precisely backwards.
   *
   * `diff --quiet HEAD` answers the same question with no output at all: exit 1
   * means there are changes. Size cannot affect it.
   */
  let isDirty = false;
  try {
    runGit(cwd, ['diff', '--quiet', 'HEAD', '--']);
  } catch (e) {
    // Exit status 1 is the answer, not a failure. Anything else — a broken
    // repo, a timeout — leaves the branch visible and claims nothing.
    const status = (e as { status?: unknown }).status;
    if (status === 1) isDirty = true;
  }

  return { branch, isDirty };
}
