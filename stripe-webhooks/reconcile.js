// reconcile.js
import Stripe from 'stripe';
import { db, markSeen } from './db.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const remember = db.prepare('INSERT OR IGNORE INTO processed_events (event_id, received_ms) VALUES (?, ?)');

// Look back further than the gap between runs. Overlap is free: seen events are skipped.
const since = Math.floor(Date.now() / 1000) - 3 * 24 * 3600;
let recovered = 0;

for await (const event of stripe.events.list({
  type: 'payment_intent.succeeded',
  created: { gte: since },
  limit: 100,
})) {
  if (remember.run(event.id, Date.now()).changes === 1) {
    markSeen(event.data.object.id, 'reconcile');
    recovered++;
    console.log('recovered', event.id, event.data.object.id);
  }
}
console.log(`done, ${recovered} recovered`);
