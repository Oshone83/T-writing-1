// poll.js
import Stripe from 'stripe';
import { db, markSeen } from './db.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const logCall = db.prepare("INSERT INTO api_calls (source, at_ms) VALUES ('poll', ?)");
stripe.on('request', () => logCall.run(Date.now())); // count every HTTP call, pages included

const getCursor = db.prepare("SELECT value FROM state WHERE key = 'poll_cursor'");
const setCursor = db.prepare(
  "INSERT INTO state (key, value) VALUES ('poll_cursor', ?) " +
  'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);

const cursor = Number(getCursor.get()?.value ?? Math.floor(Date.now() / 1000) - 3600);
let newest = cursor;

// gte, not gt: `created` is whole seconds, so two payments can share the cursor's second.
// The seen table's primary key absorbs the overlap.
for await (const pi of stripe.paymentIntents.list({ created: { gte: cursor }, limit: 100 })) {
  if (pi.status !== 'succeeded') continue;
  markSeen(pi.id, 'poll');
  newest = Math.max(newest, pi.created);
}

setCursor.run(String(newest));
