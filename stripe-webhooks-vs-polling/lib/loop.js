// lib/loop.js — run a job again and again on a fixed schedule, like cron does.
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Runs `job` now, then every `periodMs`, measured from the start of each run (so a slow run
 * doesn't push the schedule back). Returns stop(), which ends the loop after the current run.
 */
export function startEvery(periodMs, job) {
  if (!(periodMs > 0)) throw new Error(`interval must be a positive number, got ${periodMs}`);
  const ac = new AbortController();
  const done = (async () => {
    while (!ac.signal.aborted) {
      const started = Date.now();
      await job();
      const wait = periodMs - ((Date.now() - started) % periodMs);
      await sleep(wait, undefined, { signal: ac.signal }).catch(() => {});
    }
  })();
  return async () => { ac.abort(); await done; };
}
