import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireFetchLock, isFetchLockHeld } from '../src/lock.js';

/**
 * The protocol's load-bearing assumption, tested with real processes.
 *
 * Every other test in this package runs its "participants" as promises in one
 * process: one event loop, one file descriptor table, one memory space. Those
 * tests prove this implementation's control flow is right. They cannot prove
 * that `O_EXCL` excludes, or that `O_APPEND` does not interleave, because those
 * are kernel guarantees between separate processes and an in-process test never
 * asks the kernel for them.
 *
 * Since the entire point of the shared cache is that separate programs
 * coordinate, that gap is the one worth closing.
 */

const isPosix = process.platform !== 'win32';
const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'race-worker.js');

function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [WORKER, ...args], (err, stdout, stderr) => {
      if (err) reject(new Error(`${err.message}: ${stderr}`));
      else resolve(stdout.trim());
    });
  });
}

describe('cross-process coordination', { skip: !isPosix }, () => {
  let dir: string;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-usage-mp-'));
    assert.ok(fs.existsSync(WORKER), `worker must be compiled: ${WORKER}`);
  });
  after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('§4 exactly one of eight racing processes takes the lock', async () => {
    const lockPath = path.join(dir, 'race-8.lock');
    const results = await Promise.all(
      Array.from({ length: 8 }, () => run(['lock', lockPath])),
    );

    const won = results.filter((r) => r === 'WON').length;
    assert.equal(won, 1, `expected one winner, got ${won}: ${results.join(',')}`);
    assert.equal(results.filter((r) => r === 'LOST').length, 7);
  });

  test('§4 the lock is free again once the winner exits', async () => {
    const lockPath = path.join(dir, 'sequential.lock');
    assert.equal(await run(['lock', lockPath]), 'WON');
    assert.equal(isFetchLockHeld(Date.now(), lockPath), false, 'release must unlink');
    // And a fresh round behaves identically — the file left no residue.
    assert.equal(await run(['lock', lockPath]), 'WON');
  });

  test('§4 a lock held by a live process is not stolen by a peer in this one', async () => {
    const lockPath = path.join(dir, 'held.lock');
    const held = run(['lock', lockPath]);
    // The worker holds for 600 ms; give it time to actually take the lock.
    await new Promise((r) => setTimeout(r, 150));

    assert.equal(isFetchLockHeld(Date.now(), lockPath), true);
    assert.equal(acquireFetchLock(Date.now(), lockPath), null, 'a fresh lock must not be reclaimed');

    assert.equal(await held, 'WON');
  });

  test('§4 a crashed holder\'s lock is reclaimed, not inherited', async () => {
    const lockPath = path.join(dir, 'crashed.lock');
    // Simulate a process killed mid-fetch: the lock file survives it.
    fs.writeFileSync(lockPath, '999999.abcdef0123456789', { mode: 0o600 });
    const ancient = (Date.now() - 120_000) / 1000;
    fs.utimesSync(lockPath, ancient, ancient);

    assert.equal(await run(['lock', lockPath]), 'WON', 'a dead holder must not wedge the cache');
  });

  test('§3 concurrent appends from six processes never interleave a line', async () => {
    const logPath = path.join(dir, 'readings.jsonl');
    fs.writeFileSync(logPath, '', { mode: 0o600 });

    const PROCS = 6;
    const PER_PROC = 60;
    await Promise.all(Array.from({ length: PROCS }, () => run(['append', logPath, String(PER_PROC)])));

    const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter((l) => l !== '');
    assert.equal(lines.length, PROCS * PER_PROC, 'no line may be lost');

    // The real assertion: every line is independently parseable. A torn write
    // shows up here as a JSON error, and a lost O_APPEND offset shows up as two
    // records fused into one line.
    const seen = new Map<number, Set<number>>();
    for (const line of lines) {
      const rec = JSON.parse(line) as { pid: number; i: number };
      if (!seen.has(rec.pid)) seen.set(rec.pid, new Set());
      seen.get(rec.pid)?.add(rec.i);
    }
    assert.equal(seen.size, PROCS, 'every process must be represented');
    for (const [pid, indexes] of seen) {
      assert.equal(indexes.size, PER_PROC, `process ${pid} lost lines`);
    }
  });
});
