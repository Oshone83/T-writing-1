// poll.js — the "boring way": ask Stripe for PaymentIntents created since the last run.
//
//   node poll.js              one run, for cron:  * * * * * cd /path/to/app && node poll.js >> logs/poll.log 2>&1
//   node poll.js --every 60   same thing in a loop, for machines without cron
import { parseArgs } from 'node:util';
import { runEvery } from './lib/loop.js';
import { isMain } from './lib/env.js';
import { openDb, makeHelpers } from './lib/db.js';
import { createStripe } from './lib/stripe-client.js';

export async function pollOnce({ db, stripe, now = Date.now() }) {
  const { markSeen } = makeHelpers(db);
  const getCursor = db.prepare("SELECT value FROM state WHERE key = 'poll_cursor'");
  const setCursor = db.prepare(
    "INSERT INTO state (key, value) VALUES ('poll_cursor', ?) " +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );

  const cursor = Number(getCursor.get()?.value ?? Math.floor(now / 1000) - 3600);
  let newest = cursor;
  let found = 0;

  // gte, not gt: `created` is whole seconds, so two payments can share the cursor's second.
  // The seen table's primary key absorbs the overlap.
  for await (const pi of stripe.paymentIntents.list({ created: { gte: cursor }, limit: 100 })) {
    // Known limitation, kept on purpose because the article discusses it: a payment created
    // before the cursor that succeeds LATER (3D Secure, bank delay) is never seen again.
    if (pi.status !== 'succeeded') continue;
    if (markSeen(pi.id, 'poll').changes === 1) found++;
    newest = Math.max(newest, pi.created);
  }

  setCursor.run(String(newest));
  return { cursor, newest, found };
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({ options: { every: { type: 'string' } } });
  const db = openDb();
  const { logApiCall } = makeHelpers(db);
  // Count every HTTP call, list pages and SDK retries included.
  const stripe = createStripe({ onRequest: () => logApiCall('poll') });

  const runOnce = async () => {
    try {
      const r = await pollOnce({ db, stripe });
      console.log(`${new Date().toISOString()} poll: ${r.found} new, cursor ${r.cursor} -> ${r.newest}`);
    } catch (err) {
      console.error(`${new Date().toISOString()} poll failed: ${err.message}`);
      process.exitCode = 1;
    }
  };

  // The experiment's interval is 60 s: `node poll.js --every 60` or the cron line in crontab.example.
  if (values.every) await runEvery(values.every, runOnce);
  else await runOnce();
}
