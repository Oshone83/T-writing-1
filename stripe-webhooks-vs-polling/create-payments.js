// create-payments.js — creates test payments, and records the moment each one succeeded.
//
//   npm run pay                                   3 payments, 1–3 s apart
//   node create-payments.js --count 10 --min-gap 5 --max-gap 30
//   node create-payments.js --payment-method pm_card_threeDSecure2Required   needs 3-D Secure first
//
// Uses Stripe's test PaymentMethod pm_card_visa: in test mode it succeeds immediately, no card number.
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { isMain } from './lib/env.js';
import { openDb, makeHelpers } from './lib/db.js';
import { createStripe } from './lib/stripe-client.js';

export async function createPayment({ db, stripe, phase = 'manual', paymentMethod = 'pm_card_visa' }) {
  const pi = await stripe.paymentIntents.create({
    amount: 1000,
    currency: 'usd',
    payment_method: paymentMethod,
    confirm: true,
    automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
  });
  // "Payment created" = the moment the create call returned a succeeded payment. Delays are measured
  // from here. A payment still waiting for 3-D Secure isn't paid yet, so it isn't recorded.
  if (pi.status === 'succeeded') {
    db.prepare('INSERT INTO payments (id, created_ms, phase) VALUES (?, ?, ?)').run(pi.id, Date.now(), phase);
  }
  return pi;
}

export async function createPayments({ db, stripe, count, minGapMs, maxGapMs, phase, log = console.log }) {
  const created = [];
  for (let i = 0; i < count; i++) {
    const pi = await createPayment({ db, stripe, phase });
    created.push(pi);
    log(`payment ${i + 1}/${count}: ${pi.id} ${pi.status}`);
    if (i < count - 1) await sleep(minGapMs + Math.random() * (maxGapMs - minGapMs));
  }
  return created;
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      count: { type: 'string', default: '3' },
      'min-gap': { type: 'string', default: '1' },
      'max-gap': { type: 'string', default: '3' },
      'payment-method': { type: 'string', default: 'pm_card_visa' },
      phase: { type: 'string', default: 'manual' },
    },
  });
  const db = openDb();
  const { logApiCall } = makeHelpers(db);
  const stripe = createStripe({ onRequest: () => logApiCall('create') });
  if (values['payment-method'] !== 'pm_card_visa') {
    const pi = await createPayment({ db, stripe, phase: values.phase, paymentMethod: values['payment-method'] });
    console.log(`${pi.id} ${pi.status}`);
  } else {
    await createPayments({
      db, stripe, phase: values.phase, count: Number(values.count),
      minGapMs: Number(values['min-gap']) * 1000, maxGapMs: Number(values['max-gap']) * 1000,
    });
  }
}
