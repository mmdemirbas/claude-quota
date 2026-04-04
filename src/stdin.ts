import type { StdinData } from './types.js';

/** Read and parse JSON from stdin (Claude Code pipes context data) */
export async function readStdin(): Promise<StdinData | null> {
  if (process.stdin.isTTY) return null;

  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => { data += chunk; });
    // Timeout after 2s; cleared on normal end to avoid holding the event loop
    const timer = setTimeout(() => resolve(null), 2000);
    process.stdin.on('end', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(data.trim()) as StdinData);
      } catch {
        resolve(null);
      }
    });
  });
}

export function getModelName(stdin: StdinData): string {
  return stdin.model?.display_name ?? 'Claude';
}

export function getContextPercent(stdin: StdinData): number {
  const usage = stdin.context_window?.current_usage;
  const size = stdin.context_window?.context_window_size;
  if (!usage || !size || size === 0) return 0;

  const total =
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.output_tokens ?? 0);

  return Math.min(100, Math.round((total / size) * 100));
}

/** Reads effort level from whichever field name Claude Code uses in the current version. */
export function getEffortLevel(stdin: StdinData): string | null {
  return stdin.effort_level ?? stdin.effortLevel ?? stdin.effort ?? null;
}

export function getProjectName(stdin: StdinData): string | null {
  if (!stdin.cwd) return null;
  const segments = stdin.cwd.split(/[/\\]/).filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : null;
}
