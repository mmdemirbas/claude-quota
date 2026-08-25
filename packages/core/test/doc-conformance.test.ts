import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  API_TIMEOUT_MS,
  CACHE_FAILURE_TTL_MS,
  CACHE_RATE_LIMITED_BASE_MS,
  CACHE_RATE_LIMITED_JITTER,
  CACHE_RATE_LIMITED_MAX_MS,
  CACHE_SOFT_TTL_MS,
  CACHE_TTL_MS,
  FETCH_COORDINATION_MS,
  READINGS_COMPACT_BYTES,
  READINGS_RETENTION_MS,
  RETRY_AFTER_MAX_MS,
} from '../src/constants.js';
import { BUCKET_KEYS, SCHEMA_VERSION } from '../src/types.js';

/**
 * The document is a contract other programs implement, possibly in another
 * language, without reading this code. A number that drifts out of step with it
 * is not a documentation problem — it is a participant fetching on a schedule
 * its peers do not share, which is the redundant traffic the whole arrangement
 * exists to prevent.
 *
 * Constants are cheap to change and the document is easy to forget. This makes
 * forgetting fail the build.
 */

function findDoc(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'docs', 'usage-cache-protocol.md');
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf8');
    dir = path.dirname(dir);
  }
  throw new Error('usage-cache-protocol.md not found above this test');
}

describe('the protocol document matches the implementation', () => {
  const doc = findDoc();

  /** A `| Label | Value | ... |` row's second cell. */
  function tableValue(label: string): string {
    const row = doc.split('\n').find((l) => l.startsWith(`| ${label} `));
    assert.ok(row, `no table row labelled "${label}" in the document`);
    const cell = row.split('|')[2];
    assert.ok(cell, `row "${label}" has no value cell`);
    return cell.trim();
  }

  /** "120 000 ms" / "4 MB" / "30 days" → milliseconds or bytes. */
  function quantity(text: string): number {
    const m = /^([\d\s]+)\s*(ms|MB|days|h|%)$/.exec(text);
    assert.ok(m, `cannot parse a quantity from "${text}"`);
    const n = Number((m[1] ?? '').replace(/\s/g, ''));
    switch (m[2]) {
      case 'ms': return n;
      case 'MB': return n * 1024 * 1024;
      case 'days': return n * 24 * 60 * 60_000;
      case 'h': return n * 60 * 60_000;
      default: return n;
    }
  }

  const cases: Array<[string, number]> = [
    ['Hard TTL', CACHE_TTL_MS],
    ['Soft TTL', CACHE_SOFT_TTL_MS],
    ['Failure TTL', CACHE_FAILURE_TTL_MS],
    ['Lock staleness', FETCH_COORDINATION_MS],
    ['429 base backoff', CACHE_RATE_LIMITED_BASE_MS],
    ['429 max backoff', CACHE_RATE_LIMITED_MAX_MS],
    ['Retry-After cap', RETRY_AFTER_MAX_MS],
    ['Retention', READINGS_RETENTION_MS],
    ['Size cap', READINGS_COMPACT_BYTES],
  ];

  for (const [label, expected] of cases) {
    test(`§ table "${label}" states the implemented value`, () => {
      assert.equal(quantity(tableValue(label)), expected);
    });
  }

  test('§4 the lock staleness stays above the API timeout', () => {
    // Below it, a fetch still in flight has its lock stolen — the document
    // states this constraint, so it is worth failing on rather than trusting.
    assert.ok(FETCH_COORDINATION_MS > API_TIMEOUT_MS);
    assert.match(doc, /must stay above the API timeout/);
  });

  test('§5 the jitter figure is the implemented one', () => {
    assert.equal(CACHE_RATE_LIMITED_JITTER, 0.2);
    assert.match(doc, /\|\s*±20 %\s*\|/);
  });

  test('§7 the documented schema version is the implemented one', () => {
    assert.match(doc, new RegExp(`\`schemaVersion\` is ${SCHEMA_VERSION}\\.`));
    assert.match(doc, new RegExp(`protocol, version ${SCHEMA_VERSION}`));
  });

  test('§2.1 every implemented bucket key is documented, and vice versa', () => {
    const table = doc.slice(doc.indexOf('Bucket keys defined by version 1'));
    const documented = new Set(
      [...table.matchAll(/^\| `(\w+)` \| `(\w+)` \|/gm)].map((m) => m[1] as string),
    );
    assert.deepEqual([...documented].sort(), [...BUCKET_KEYS].sort());
  });

  test('§6 the no-fallback credential rule is stated, since it is a correctness rule', () => {
    assert.match(doc, /MUST NOT fall back from the hashed service name to the bare/);
  });
});
