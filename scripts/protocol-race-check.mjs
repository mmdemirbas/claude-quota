#!/usr/bin/env node
//
// Live check of the coordination claim in docs/usage-cache-protocol.md §4:
// two participants racing from a cold cache produce exactly one upstream
// request. Unit tests cover the lock in isolation; this exercises two real
// processes against the real endpoint, which is the only way to see the
// O_EXCL race actually resolve.
//
// Run from a directory where @mmdemirbas/claude-usage resolves, with
// `claude-quota` on PATH:
//
//   rm -f ~/.claude/usage/usage.json ~/.claude/plugins/claude-quota/data.js
//   node scripts/protocol-race-check.mjs      # expect appended: 1
//   node scripts/protocol-race-check.mjs      # expect appended: 0, source: cache
//
// Costs one API call on the cold run. Do not run it in a loop.
import { getUsage, readReadings } from '@mmdemirbas/claude-usage';
import { execFile } from 'node:child_process';

const before = readReadings().length;

// Participant A: the ajans side, in this process.
const a = getUsage();
// Participant B: the statusline binary, as a separate process.
const b = new Promise((resolve) => {
  const child = execFile('claude-quota', [], (_err, stdout) => resolve(stdout ?? ''));
  child.stdin.end(JSON.stringify({ model: { display_name: 'x' }, cwd: process.cwd() }));
});

const [ra] = await Promise.all([a, b]);
const after = readReadings();

console.log(JSON.stringify({
  ajans_source: ra.source,
  ajans_sevenDay: ra.data?.sevenDay ?? null,
  readings_before: before,
  readings_after: after.length,
  appended: after.length - before,
  newest_fetchedAt: after.at(-1)?.fetchedAt ?? null,
}, null, 1));
