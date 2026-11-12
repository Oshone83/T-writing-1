// simulate-loss.js: makes the app "forget" one delivered event, so reconcile.js has something to recover.
// Usage: node --env-file=.env simulate-loss.js [evt_…]   (defaults to the newest delivered payment_intent.succeeded)
import Stripe from 'stripe';
import { db } from './db.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const known = db.prepare('SELECT 1 FROM processed_events WHERE event_id = ?');

let event;
if (process.argv[2]) {
  event = await stripe.events.retrieve(process.argv[2]);
} else {
  for await (const ev of stripe.events.list({ type: 'payment_intent.succeeded', limit: 100 })) {
    if (known.get(ev.id)) { event = ev; break; }
  }
}
if (!event) {
  console.error('No delivered payment_intent.succeeded event found in processed_events.');
  process.exit(1);
}

const pi = event.data.object.id;
const tx = db.transaction(() => ({
  events: db.prepare('DELETE FROM processed_events WHERE event_id = ?').run(event.id).changes,
  // Keep the poller's row so the delay comparison for this payment survives.
  seen: db.prepare("DELETE FROM seen WHERE id = ? AND method IN ('webhook', 'reconcile')").run(pi).changes,
}));
const removed = tx();
console.log(`Forgot ${event.id} (${pi}): ${removed.events} processed_events row, ${removed.seen} seen row(s).`);
console.log('Now run: node --env-file=.env reconcile.js');
