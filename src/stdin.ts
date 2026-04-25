import type { StdinData } from './types.js';

/** Upper bound on stdin payload size. Claude Code's JSON fits easily in a
 * few KB; anything beyond ~1 MB is either a bug or an attempt to push the
 * plugin into an OOM during render. Bytes past this cap are dropped and
 * the final payload is rejected as malformed. Exported for testing. */
export const STDIN_MAX_BYTES = 1_048_576;
const STDIN_TIMEOUT_MS = 2000;

/**
 * Parse a completed stdin payload. Exposed so the size-cap and JSON
 * validation can be tested without spinning up a child process.
 */
export function parseStdinPayload(raw: string): StdinData | null {
  if (raw.length > STDIN_MAX_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(raw.trim());
    return isStdinShape(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Read and parse JSON from stdin (Claude Code pipes context data). */
export async function readStdin(): Promise<StdinData | null> {
  if (process.stdin.isTTY) return null;

  return new Promise((resolve) => {
    const chunks: string[] = [];
    let size = 0;
    let overflowed = false;
    let settled = false;

    process.stdin.setEncoding('utf8');

    const finish = (value: StdinData | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Detach listeners so a late 'data' event cannot land after resolve.
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      process.stdin.removeListener('error', onError);
      resolve(value);
    };

    const onData = (chunk: string): void => {
      if (overflowed) return;
      size += chunk.length;
      if (size > STDIN_MAX_BYTES) {
        overflowed = true;
        // Drop the payload — an oversized body is either a bug or hostile.
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    };

    const onEnd = (): void => {
      if (overflowed) { finish(null); return; }
      finish(parseStdinPayload(chunks.join('')));
    };

    const onError = (): void => finish(null);

    const timer = setTimeout(() => finish(null), STDIN_TIMEOUT_MS);

    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.on('error', onError);
  });
}

/**
 * Minimal shape guard for the stdin payload. Keeps JSON.parse results as
 * `unknown` until we've at least confirmed we got an object — the
 * per-field getters below already tolerate missing keys.
 */
function isStdinShape(x: unknown): x is StdinData {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

export function getModelName(stdin: StdinData): string {
  // Trust nothing from stdin: a non-string display_name (object, number,
  // boolean) would later crash extractFamily's `.replace` / `.toLowerCase`.
  const v = stdin.model?.display_name;
  return typeof v === 'string' && v.length > 0 ? v : 'Claude';
}

export function getContextPercent(stdin: StdinData): number {
  const usage = stdin.context_window?.current_usage;
  const size = stdin.context_window?.context_window_size;
  if (!usage || !size || !Number.isFinite(size) || size <= 0) return 0;

  const total =
    safeNum(usage.input_tokens) +
    safeNum(usage.cache_creation_input_tokens) +
    safeNum(usage.cache_read_input_tokens) +
    safeNum(usage.output_tokens);

  const pct = Math.round((total / size) * 100);
  // Clamp both sides: negative inputs from hostile/buggy stdin would otherwise
  // render as a negative percentage in the bar.
  return Math.max(0, Math.min(100, pct));
}

/** Coerce an arbitrary token count to a non-negative finite number. */
function safeNum(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/** Reads effort level from whichever field name Claude Code uses in the current version.
 * Returns null for any non-string value — Claude Code on Windows has been
 * observed sending an object here, which crashed `effort.toLowerCase()`. */
export function getEffortLevel(stdin: StdinData): string | null {
  const v = stdin.effort_level ?? stdin.effortLevel ?? stdin.effort;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Hard cap on the visible width of a project name in the statusline.
 * Long project names would otherwise push line 1 layout into compact
 * tier (or hard-truncate the line) at terminal widths where it shouldn't.
 *
 * Exported for testing.
 */
export const PROJECT_NAME_MAX = 24;

export function getProjectName(stdin: StdinData): string | null {
  if (!stdin.cwd) return null;
  const segments = stdin.cwd.split(/[/\\]/).filter(Boolean);
  if (segments.length === 0) return null;
  const name = segments[segments.length - 1];
  if (name.length <= PROJECT_NAME_MAX) return name;
  // 23 chars + 1-char ellipsis = exactly PROJECT_NAME_MAX visible width.
  return name.slice(0, PROJECT_NAME_MAX - 1) + '…';
}
