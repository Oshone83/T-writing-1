// lib/loop.js — run a job on a fixed-rate schedule, like cron, for machines without cron
// (GitHub Codespaces, Windows). Ctrl+C or SIGTERM stops it.
import { setTimeout as sleep } from 'node:timers/promises';

export async function runEvery(periodSeconds, job) {
  const periodMs = Number(periodSeconds) * 1000;
  if (!(periodMs > 0)) throw new Error(`--every must be a positive number of seconds, got ${periodSeconds}`);
  for (;;) {
    const started = Date.now();
    await job();
    // Fixed rate: the next run starts one period after this one started, not after it finished.
    await sleep(periodMs - ((Date.now() - started) % periodMs));
  }
}
