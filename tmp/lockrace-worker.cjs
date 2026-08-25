const path = require('path');
(async () => {
  const repo = process.argv[2], lockPath = process.argv[3], startAt = Number(process.argv[4]);
  const { acquireFetchLock } = await import(path.resolve(repo, 'packages/core/dist/lock.js'));
  while (Date.now() < startAt) { /* barrier: hit the lock in the same millisecond */ }
  const lock = acquireFetchLock(Date.now(), lockPath);
  process.stdout.write(lock === null ? 'LOST\n' : 'WON\n');
})();
