/**
 * A single participant, as its own OS process.
 *
 * Spawned by multiprocess.test.ts. In-process tests can only prove that this
 * implementation's async interleaving behaves; they share one file descriptor
 * table and one event loop, so they say nothing about whether `O_EXCL` and
 * `O_APPEND` do their jobs between genuinely separate processes. That is the
 * assumption the whole protocol rests on, so it gets a test with real
 * processes in it.
 *
 *   node race-worker.js lock  <lockPath>              → prints WON or LOST
 *   node race-worker.js append <readingsPath> <n>     → appends n lines
 */
import * as fs from 'node:fs';
import { acquireFetchLock } from '../../src/lock.js';

const [, , mode, target, arg] = process.argv;

if (mode === 'lock') {
  const lock = acquireFetchLock(Date.now(), target);
  if (lock === null) {
    process.stdout.write('LOST\n');
    process.exit(0);
  }
  const held = lock;
  process.stdout.write('WON\n');
  // Hold long enough that every sibling process has certainly tried and failed.
  // Without the hold, a fast winner could release before a slow sibling even
  // reaches the open() and the test would pass without a race happening.
  setTimeout(() => {
    held.release();
    process.exit(0);
  }, 600);
} else if (mode === 'append') {
  // Each line is tagged with this pid so the reader can tell whose is whose,
  // and padded so a line is comfortably larger than a stdio buffer boundary —
  // a short line could survive interleaving by luck rather than by O_APPEND.
  const count = Number(arg);
  for (let i = 0; i < count; i++) {
    const line = JSON.stringify({ pid: process.pid, i, pad: 'x'.repeat(400) });
    fs.appendFileSync(target, `${line}\n`, { flag: 'a' });
  }
  process.exit(0);
} else {
  process.stderr.write(`unknown mode: ${String(mode)}\n`);
  process.exit(2);
}
