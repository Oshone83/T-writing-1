// create-payments.js — creates N test PaymentIntents at random 5–30 s gaps and records
// the moment each create call returned ("payment created").
//
//   node create-payments.js --count 100 --phase side-by-side
//   node create-payments.js --count 5   --phase outage
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { isMain } from './lib/env.js';
import { openDb, makeHelpers } from './lib/db.js';
import { createStripe } from './lib/stripe-client.js';

export async function createPayments({ db, stripe, count, minGapMs, maxGapMs, phase, log = console.log, signal }) {
  const insert = db.prepare(
    'INSERT INTO payments (id, created_ms, stripe_created_s, phase) VALUES (?, ?, ?, ?)'
  );
  let ok = 0;
  let failed = 0;
  for (let i = 0; i < count && !signal?.aborted; i++) {
    try {
      const pi = await stripe.paymentIntents.create({
        amount: 1000,
        currency: 'usd',
        payment_method: 'pm_card_visa', // Stripe's test card; only exists in test mode
        confirm: true,
        automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
        metadata: { experiment: 'webhook-vs-polling', phase },
      });
      const createdMs = Date.now(); // payment created: the create call has returned
      if (pi.status !== 'succeeded') {
        log(`#${i + 1} ${pi.id} status=${pi.status} (not succeeded, not counted)`);
        failed++;
      } else {
        insert.run(pi.id, createdMs, pi.created, phase);
        ok++;
        log(`#${i + 1} ${pi.id} succeeded at ${new Date(createdMs).toISOString()}`);
      }
    } catch (err) {
      failed++;
      log(`#${i + 1} create failed: ${err.type ?? ''} ${err.message}`);
      if (err.type === 'StripeAuthenticationError') throw err; // no point retrying a bad key
    }
    if (i < count - 1) {
      const gap = minGapMs + Math.random() * (maxGapMs - minGapMs);
      await sleep(gap, undefined, { signal }).catch(() => {});
    }
  }
  return { ok, failed };
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      count: { type: 'string', default: '100' },
      phase: { type: 'string', default: 'side-by-side' },
      'min-gap': { type: 'string', default: '5' },
      'max-gap': { type: 'string', default: '30' },
    },
  });
  const db = openDb();
  const { logApiCall } = makeHelpers(db);
  const stripe = createStripe({ onRequest: () => logApiCall('create') });
  const ac = new AbortController();
  process.on('SIGINT', () => { console.log('\nstopping after the current payment…'); ac.abort(); });

  const result = await createPayments({
    db, stripe,
    count: Number(values.count),
    phase: values.phase,
    minGapMs: Number(values['min-gap']) * 1000,
    maxGapMs: Number(values['max-gap']) * 1000,
    signal: ac.signal,
  });
  console.log(`done: ${result.ok} succeeded, ${result.failed} failed (phase=${values.phase})`);
}
