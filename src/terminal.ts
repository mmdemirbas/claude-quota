import type { StdinData } from './types.js';

export interface TerminalDims {
  columns: number;
  rows: number;
}

/**
 * Resolve terminal dimensions from the best available source.
 *
 * Priority:
 *   1. stdin JSON fields (future Claude Code versions may supply these)
 *   2. process.stderr — stays attached to the TTY even when stdout is piped
 *   3. COLUMNS / LINES environment variables (set by bash/zsh)
 *   4. Safe defaults (120 columns, 3 rows)
 *
 * Rows are capped at 3 because the plugin never emits more than 3 lines.
 */
export function terminalDims(stdin: StdinData | null): TerminalDims {
  const columns =
    validDim(stdin?.columns) ??
    validDim((process.stderr as NodeJS.WriteStream).columns) ??
    envDim('COLUMNS') ??
    120;

  const rows =
    validDim(stdin?.rows) ??
    validDim((process.stderr as NodeJS.WriteStream).rows) ??
    envDim('LINES') ??
    3;

  return { columns, rows: Math.min(rows, 3) };
}

/**
 * Upper bound on accepted terminal dimensions. Any real TTY tops out a
 * couple orders of magnitude below this; larger values reaching the
 * renderer only ever come from a hostile env (e.g. COLUMNS=999999999),
 * where they'd push string allocation in render.ts into the megabytes.
 */
const MAX_DIM = 10_000;

function validDim(n: unknown): number | null {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= MAX_DIM
    ? Math.floor(n)
    : null;
}

/**
 * A dimension from the environment, accepted only in the shape a shell writes.
 *
 * `parseInt` was the wrong reader here: it stops at the first character it
 * does not understand and returns what it has, so `COLUMNS=1e5` parsed as
 * **1** and the statusline rendered into a single column. A value that is not
 * a plain run of digits is not a dimension, and falling through to the default
 * is better than rendering to a number nobody meant.
 */
function envDim(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return null;
  return validDim(Number(raw));
}
