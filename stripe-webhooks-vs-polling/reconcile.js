// reconcile.js — the safety net: read Stripe's list of payment_intent.succeeded events and process
// any the receiver never recorded (endpoint down too long, deleted endpoint, a bug that answered 200
// and dropped the work…).
//
//   npm run reconcile                one run, looking back 3 days
//   node reconcile.js --every 3600   hourly
import { parseArgs } from 'node:util';
import { isMain } from './lib/env.js';
import { openDb, makeHelpers } from './lib/db.js';
import { createStripe } from './lib/stripe-client.js';
import { startEvery } from './lib/loop.js';

export async function reconcile({ db, stripe, sinceHours = 72, now = Date.now(), log = console.log }) {
  const { markSeen, processEventOnce } = makeHelpers(db);
  // Look back further than the gap between runs: overlap costs nothing because processed events are
  // skipped. Stripe only lists events from the last 30 days, so more than 720 h is pointless.
  const since = Math.floor(now / 1000) - Math.min(sinceHours, 720) * 3600;
  const recovered = [];
  let checked = 0;

  for await (const event of stripe.events.list({ type: 'payment_intent.succeeded', created: { gte: since }, limit: 100 })) {
    checked++;
    const paymentId = event.data.object.id;
    // The same event-ID table and transaction as the receiver: whichever sees an event first does the
    // work, the other one skips it. So reconcile and webhook retries can never double-process.
    if (processEventOnce(event.id, 'reconcile', () => markSeen(paymentId, 'reconcile'))) {
      recovered.push({ eventId: event.id, paymentId });
      log(`recovered ${event.id} (payment ${paymentId})`);
    }
  }
  log(`reconcile done: ${checked} event(s) checked, ${recovered.length} recovered`);
  return { checked, recovered };
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({ options: { every: { type: 'string' }, 'since-hours': { type: 'string', default: '72' } } });
  const db = openDb();
  const { logApiCall } = makeHelpers(db);
  const stripe = createStripe({ onRequest: () => logApiCall('reconcile') });
  const runOnce = () => reconcile({ db, stripe, sinceHours: Number(values['since-hours']) })
    .catch((err) => console.error(`reconcile failed: ${err.message}`));
  if (values.every) startEvery(Number(values.every) * 1000, runOnce);
  else await runOnce();
}
