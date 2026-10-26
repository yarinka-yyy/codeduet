import { setTimeout } from 'node:timers/promises';
console.log('FOREGROUND_STARTED_003');
await setTimeout(75_000);
console.log('FOREGROUND_FINISHED_003');
