// outage.js: builds the "When the retries came back" table for payments created during an outage.
// Usage: node --env-file=.env outage.js <outage start ISO> <outage end ISO>
//   e.g. node --env-file=.env outage.js 2026-11-10T14:00:00Z 2026-11-10T14:20:00Z
// Failed-attempt times aren't in the API; read them off the endpoint's Event deliveries tab.
import Stripe from 'stripe';
import { db } from './db.js';

const [fromArg, toArg] = process.argv.slice(2);
const fromMs = Date.parse(fromArg);
const toMs = Date.parse(toArg);
if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
  console.error('Usage: node --env-file=.env outage.js <start ISO> <end ISO>');
  process.exit(1);
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const payments = db.prepare('SELECT id, created_ms FROM payments WHERE created_ms BETWEEN ? AND ? ORDER BY created_ms')
  .all(fromMs, toMs);
const received = db.prepare('SELECT received_ms FROM processed_events WHERE event_id = ?');
const seenBy = db.prepare('SELECT method, seen_ms FROM seen WHERE id = ? ORDER BY seen_ms');

// One events.list call covers the window (plus slack, since `created` is whole seconds).
const eventByPayment = new Map();
for await (const ev of stripe.events.list({
  type: 'payment_intent.succeeded',
  created: { gte: Math.floor(fromMs / 1000) - 5, lte: Math.ceil(toMs / 1000) + 5 },
  limit: 100,
})) {
  eventByPayment.set(ev.data.object.id, ev);
}

const fmt = (ms) => (ms == null ? '—' : new Date(ms).toISOString().slice(11, 23));
const dur = (ms) => {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
};

console.log(`${payments.length} payment(s) created between ${fromArg} and ${toArg}\n`);
console.log('event                          payment created  first delivery   total delay   pending_webhooks  seen by');
const deliveredOrder = [];
let lost = 0;
for (const p of payments) {
  const ev = eventByPayment.get(p.id);
  const r = ev ? received.get(ev.id) : undefined;
  const seen = seenBy.all(p.id).map((s) => s.method).join(', ') || 'nobody';
  if (!r) lost++;
  else deliveredOrder.push({ id: p.id, at: r.received_ms });
  console.log(
    `${(ev?.id ?? '(no event found)').padEnd(30)} ${fmt(p.created_ms).padEnd(16)} ${fmt(r?.received_ms).padEnd(16)} ` +
    `${dur(r ? r.received_ms - p.created_ms : null).padEnd(13)} ${String(ev?.pending_webhooks ?? '—').padEnd(17)} ${seen}`
  );
}

const inOrder = deliveredOrder.every((d, i) => i === 0 || d.at >= deliveredOrder[i - 1].at);
console.log(`\nDelivered in creation order: ${deliveredOrder.length ? (inOrder ? 'yes' : 'NO') : 'n/a'}`);
console.log(`Not yet recorded by the app: ${lost}`);
console.log('Duplicates: grep -c "^duplicate" receiver.log');
