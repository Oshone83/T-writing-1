// create-payments.js
// Creates N test PaymentIntents at random 5–30 s gaps and records when each create call returned.
// Usage: node --env-file=.env create-payments.js [count=50] [minGapS=5] [maxGapS=30]
import Stripe from 'stripe';
import { db } from './db.js';

const [count = 50, minGap = 5, maxGap = 30] = process.argv.slice(2).map(Number);

const key = process.env.STRIPE_SECRET_KEY ?? '';
if (!key.startsWith('sk_test_') && !key.startsWith('rk_test_')) {
  console.error('Refusing to run: STRIPE_SECRET_KEY must be a test-mode key (sk_test_…).');
  process.exit(1);
}

const stripe = new Stripe(key);
const insert = db.prepare('INSERT INTO payments (id, created_ms) VALUES (?, ?)');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (let i = 1; i <= count; i++) {
  const pi = await stripe.paymentIntents.create({
    amount: 1000, currency: 'usd', payment_method: 'pm_card_visa', confirm: true,
    automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
  });
  insert.run(pi.id, Date.now()); // payment created
  console.log(`${new Date().toISOString()} ${i}/${count} ${pi.id} ${pi.status}`);

  if (i < count) {
    const gapS = minGap + Math.random() * (maxGap - minGap);
    await sleep(gapS * 1000);
  }
}
