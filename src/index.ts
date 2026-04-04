import { readStdin } from './stdin.js';
import { getUsage } from './usage.js';
import { getGitStatus } from './git.js';
import { render } from './render.js';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

async function main(): Promise<void> {
  try {
    const stdin = await readStdin();
    if (!stdin) {
      console.log('[claude-quota] Ready. Restart Claude Code to activate.');
      return;
    }

    const [usage, git] = await Promise.all([
      getUsage(),
      stdin.cwd ? Promise.resolve(getGitStatus(stdin.cwd)) : Promise.resolve(null),
    ]);

    render({ stdin, usage, git });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.log(`[claude-quota] Error: ${msg}`);
  }
}

// Run when executed directly
const scriptPath = fileURLToPath(import.meta.url);
const argvPath = process.argv[1];
const isSame = (a: string, b: string): boolean => {
  try { return realpathSync(a) === realpathSync(b); }
  catch { return a === b; }
};
if (argvPath && isSame(argvPath, scriptPath)) {
  void main();
}

export { main };
