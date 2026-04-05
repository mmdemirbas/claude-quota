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
    validDim(parseInt(process.env['COLUMNS'] ?? '', 10)) ??
    120;

  const rows =
    validDim(stdin?.rows) ??
    validDim((process.stderr as NodeJS.WriteStream).rows) ??
    validDim(parseInt(process.env['LINES'] ?? '', 10)) ??
    3;

  return { columns, rows: Math.min(rows, 3) };
}

function validDim(n: unknown): number | null {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}
