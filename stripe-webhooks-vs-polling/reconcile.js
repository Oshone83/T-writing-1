// reconcile.js — the catch-up poll I kept. Reads Stripe's events list and processes any
// payment_intent.succeeded event my receiver never recorded.
//
//   node reconcile.js                    look back 3 days (default)
//   node reconcile.js --since-hours 1
//   node reconcile.js --every 3600       hourly loop, for machines without cron (e.g. Codespaces)
//   cron: 0 * * * * cd /path/to/app && node reconcile.js >> logs/reconcile.log 2>&1
import { parseArgs } from 'node:util';
import { isMain } from './lib/env.js';
import { runEvery } from './lib/loop.js';
import { openDb, makeHelpers } from './lib/db.js';
import { createStripe, assertTestKey } from './lib/stripe-client.js';

export async function reconcile({ db, stripe, sinceHours = 72, now = Date.now(), log = console.log }) {
  const { markSeen, processEventOnce } = makeHelpers(db);
  // Look back further than the gap between runs. Overlap is free: seen events are skipped.
  // Stripe keeps events for 30 days, so anything over 720 h is pointless.
  const since = Math.floor(now / 1000) - Math.min(sinceHours, 720) * 3600;
  const recovered = [];
  let checked = 0;

  for await (const event of stripe.events.list({
    type: 'payment_intent.succeeded',
    created: { gte: since },
    limit: 100,
  })) {
    checked++;
    const paymentId = event.data.object.id;
    // Same event-ID table as the receiver, and the same transaction: whichever path sees the
    // event first does the work; the other one is a no-op.
    if (processEventOnce(event.id, 'reconcile', () => markSeen(paymentId, 'reconcile'))) {
      recovered.push({ eventId: event.id, paymentId });
      log(`recovered ${event.id} ${paymentId}`);
    }
  }
  log(`done, ${checked} events checked, ${recovered.length} recovered`);
  return { checked, recovered };
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({ options: { 'since-hours': { type: 'string', default: '72' }, every: { type: 'string' } } });
  assertTestKey(process.env.STRIPE_SECRET_KEY); // refuse bad keys before creating payments.db
  const db = openDb();
  const { logApiCall } = makeHelpers(db);
  const stripe = createStripe({ onRequest: () => logApiCall('reconcile') });
  const runOnce = async () => {
    console.log(`${new Date().toISOString()} reconcile start`);
    try {
      await reconcile({ db, stripe, sinceHours: Number(values['since-hours']) });
    } catch (err) {
      console.error(`${new Date().toISOString()} reconcile failed: ${err.message}`);
      process.exitCode = 1;
    }
  };
  if (values.every) await runEvery(values.every, runOnce);
  else await runOnce();
}
