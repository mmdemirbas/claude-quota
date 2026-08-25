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

      /*
       * Removing the listeners is not enough to let the process exit.
       *
       * A readable stream with no 'data' listener still holds the event loop
       * open, so if the parent writes the payload and keeps the pipe open —
       * which it is entitled to do, and a grandchild inheriting the fd does it
       * by accident — the render finished and the process simply stayed alive.
       * One leaked node per statusline tick. Measured: resolved at 2.0 s, still
       * running at 6 s, killed by hand.
       */
      try { process.stdin.pause(); } catch { /* ignore */ }
      try { (process.stdin as NodeJS.ReadStream & { unref?: () => void }).unref?.(); } catch { /* ignore */ }

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

    /*
     * On timeout, parse what arrived before giving up.
     *
     * The deadline exists for a parent that never closes the pipe, and such a
     * parent has usually already written the whole payload — so discarding it
     * threw away a complete, valid body. The visible result was the first-run
     * message, "[claude-quota] Ready. Restart Claude Code to activate.",
     * printed onto the statusline itself on every tick.
     */
    const timer = setTimeout(() => {
      finish(overflowed ? null : parseStdinPayload(chunks.join('')));
    }, STDIN_TIMEOUT_MS);

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

/**
 * Strip anything that would act on the terminal rather than appear in it.
 *
 * stdout *is* the statusline, so a control character in a value taken from
 * stdin is not a display quirk — it is a command. Two were reproduced: a
 * display_name carrying a clear-screen and a set-window-title sequence did
 * both, and a directory name with an embedded newline added a line to a
 * statusline whose height Claude Code controls. Neither value is beyond
 * outside influence — a repository can be cloned into a directory of someone
 * else's choosing.
 *
 * C0, DEL and C1 go; everything printable, including every script and emoji,
 * stays.
 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

function sanitize(value: string): string {
  return value.replace(CONTROL_CHARS, '');
}

/**
 * Cut a string to at most `max` code points, never splitting an astral pair.
 *
 * `slice` counts UTF-16 units, so a name ending in an emoji lost half of one
 * and rendered as U+FFFD.
 */
function cutCodePoints(value: string, max: number): string {
  const points = Array.from(value);
  return points.length <= max ? value : points.slice(0, max).join('');
}

export function getModelName(stdin: StdinData): string {
  // Trust nothing from stdin: a non-string display_name (object, number,
  // boolean) would later crash extractFamily's `.replace` / `.toLowerCase`.
  const v = stdin.model?.display_name;
  if (typeof v !== 'string') return 'Claude';
  const clean = sanitize(v);
  return clean.length > 0 ? clean : 'Claude';
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
  // Trust nothing from stdin: a non-string cwd (e.g. a number on a buggy
  // shim) would crash .split() here. Guarded the same way as model and
  // effort_level above.
  if (typeof stdin.cwd !== 'string' || !stdin.cwd) return null;
  const segments = sanitize(stdin.cwd).split(/[/\\]/).filter(Boolean);
  if (segments.length === 0) return null;
  const name = segments[segments.length - 1];
  if (name === undefined || name.length === 0) return null;
  if (Array.from(name).length <= PROJECT_NAME_MAX) return name;
  // 23 code points + 1-char ellipsis = exactly PROJECT_NAME_MAX visible width.
  return cutCodePoints(name, PROJECT_NAME_MAX - 1) + '…';
}
