import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readEntry, toUsageData, writeFileSecure, type UsageData } from '@mmdemirbas/claude-usage';
import {
  pluginDir,
  CACHE_VAR_DATA, CACHE_FILE_DATA,
  CACHE_VAR_CREDIT_GRANT, CACHE_FILE_CREDIT_GRANT,
} from './paths.js';

/**
 * The dashboard's data files.
 *
 * These are **derived artifacts**, not a cache. The dashboard is a static HTML
 * page that loads its data with a script tag, so it needs `var DATA={…};` at a
 * path it can reference relatively — which is a presentation constraint of
 * this program and nobody else's business. The measurement itself lives in the
 * shared usage directory, and that is the file other tools read.
 *
 * Written after every render, so the page a browser reloads is never older
 * than the last statusline draw.
 */

function writeJsVar(fileName: string, varName: string, value: unknown): void {
  try {
    mkdirSync(pluginDir(), { recursive: true });
  } catch { /* the write below will surface it */ }
  writeFileSecure(join(pluginDir(), fileName), `var ${varName}=${JSON.stringify(value)};`);
}

/**
 * Publish the current reading for the dashboard.
 *
 * The shape is the one the page's renderer has always read — `data`,
 * `lastGoodData`, `timestamp` with flat fields and ISO dates. Keeping it means
 * the protocol change costs the dashboard nothing.
 */
export function writeDashboardData(usage: UsageData | null): void {
  const entry = readEntry();
  if (usage === null && entry === null) return;

  writeJsVar(CACHE_FILE_DATA, CACHE_VAR_DATA, {
    data: usage ?? (entry?.reading ? toUsageData(entry.reading) : null),
    lastGoodData: entry?.lastGood ? toUsageData(entry.lastGood) : undefined,
    timestamp: entry?.timestamp ?? usage?.fetchedAt ?? Date.now(),
    rateLimitedCount: entry?.backoff.rateLimitedCount ?? 0,
  });
}

/** Publish the prepaid credit balance for the dashboard. */
export function writeDashboardCreditGrant(creditGrant: number | null): void {
  writeJsVar(CACHE_FILE_CREDIT_GRANT, CACHE_VAR_CREDIT_GRANT, {
    creditGrant,
    timestamp: Date.now(),
  });
}
