import { setTimeout } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';

const startedAt = Date.now();
await setTimeout(75_000);
writeFileSync(new URL('.probe-foreground.json', import.meta.url), JSON.stringify({
  pid: process.pid, startedAt, finishedAt: Date.now(), marker: 'FOREGROUND_FINISHED',
}));
console.log('FOREGROUND_FINISHED; no background operations');
