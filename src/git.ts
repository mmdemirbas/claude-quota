import { execFileSync } from 'node:child_process';
import type { GitStatus } from './types.js';

export function getGitStatus(cwd: string): GitStatus | null {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 2000,
    }).trim();

    let isDirty = false;
    try {
      const status = execFileSync('git', ['status', '--porcelain', '-uno'], {
        cwd,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 2000,
      }).trim();
      isDirty = status.length > 0;
    } catch { /* git status failed; assume clean */ }

    return { branch, isDirty };
  } catch {
    return null;
  }
}
