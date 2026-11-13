// poll.js — the polling version: ask Stripe "anything new?" on a timer.
//
//   npm run poll                     poll every 10 s until Ctrl+C
//   node poll.js --every 60          the classic once-a-minute cron job
//   node poll.js --once              a single poll (what one cron run does)
//
// Each run lists the PaymentIntents created since the last run (the "cursor"), records the succeeded
// ones, and moves the cursor forward.
import { parseArgs } from 'node:util';
import { isMain } from './lib/env.js';
import { openDb, makeHelpers } from './lib/db.js';
import { createStripe } from './lib/stripe-client.js';
import { startEvery } from './lib/loop.js';

export async function pollOnce({ db, stripe, now = Date.now() }) {
  const { markSeen } = makeHelpers(db);
  const getCursor = db.prepare("SELECT value FROM state WHERE key = 'poll_cursor'");
  const setCursor = db.prepare(
    "INSERT INTO state (key, value) VALUES ('poll_cursor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );

  // The cursor is a Stripe `created` timestamp (whole seconds). First run: look back one hour.
  const cursor = Number(getCursor.get()?.value ?? Math.floor(now / 1000) - 3600);
  let newest = cursor;
  let found = 0;

  // gte, not gt: two payments can share a second, so we re-read the cursor's second each time.
  // The seen table's primary key makes re-reading harmless. The SDK fetches further pages automatically.
  for await (const pi of stripe.paymentIntents.list({ created: { gte: cursor }, limit: 100 })) {
    // KNOWN FLAW (demonstrated by `npm run demo`, scenario 2): a payment that is not yet succeeded is
    // skipped, and once a newer payment moves the cursor past its `created` time, it is never listed
    // again, even after it succeeds. Polling the events list instead (reconcile.js) avoids this.
    if (pi.status !== 'succeeded') continue;
    if (markSeen(pi.id, 'poll').changes === 1) found++;
    newest = Math.max(newest, pi.created);
  }

  setCursor.run(String(newest));
  return { cursor, newest, found };
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({ options: { every: { type: 'string', default: '10' }, once: { type: 'boolean' } } });
  const db = openDb();
  const { logApiCall } = makeHelpers(db);
  const stripe = createStripe({ onRequest: () => logApiCall('poll') }); // count every HTTP request

  const runOnce = async () => {
    try {
      const r = await pollOnce({ db, stripe });
      console.log(`${new Date().toISOString()} poll: ${r.found} new payment(s), cursor ${r.cursor} -> ${r.newest}`);
    } catch (err) {
      console.error(`${new Date().toISOString()} poll failed: ${err.message}`);
    }
  };

  if (values.once) await runOnce();
  else {
    console.log(`polling every ${values.every} s (Ctrl+C to stop)`);
    startEvery(Number(values.every) * 1000, runOnce);
  }
}
