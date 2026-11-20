#!/usr/bin/env node
// Deterministic high-repetition log used by the v0.2 benchmark.
// 40 blocks: 38 identical heartbeat blocks, one block carries C5.
const heartbeat = 'heartbeat ok | interval=250ms | queue=drained | worker=pool-7 | status=healthy | tick=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
for (let block = 1; block <= 40; block += 1) {
  if (block === 26) {
    process.stdout.write(`block ${String(block).padStart(2, '0')} | BACKUP_SLOT=blue-17 | checkpoint C5\n`);
  } else {
    process.stdout.write(`block ${String(block).padStart(2, '0')} | ${heartbeat}\n`);
  }
}
