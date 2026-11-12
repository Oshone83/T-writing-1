// snapshot-pending.js — records Stripe's own view of undelivered events during the outage.
//
// Uses the List Events API with delivery_success=false, which Stripe documents as returning
// "events with deliveries that are still pending or have failed all delivery attempts to at least
// one of your endpoints" (docs.stripe.com/webhooks/process-undelivered-events), plus each event's
// pending_webhooks count. It cannot see individual attempts or status codes: those are only in
// the Dashboard (record them in manual/dashboard-delivery-attempts.csv).
//
//   node snapshot-pending.js                 one snapshot
//   node snapshot-pending.js --every 300     every 5 minutes until Ctrl+C (run during the outage)
import { parseArgs } from 'node:util';
import { isMain } from './lib/env.js';
import { openDb, makeHelpers } from './lib/db.js';
import { createStripe } from './lib/stripe-client.js';
import { runEvery } from './lib/loop.js';

export async function snapshotPending({ db, stripe, sinceHours = 24, now = Date.now(), log = console.log }) {
  const insert = db.prepare(
    'INSERT INTO pending_snapshots (snapshot_ms, event_id, payment_id, pending_webhooks) VALUES (?, ?, ?, ?)'
  );
  const since = Math.floor(now / 1000) - sinceHours * 3600;
  const pending = [];
  for await (const event of stripe.events.list({
    type: 'payment_intent.succeeded', delivery_success: false, created: { gte: since }, limit: 100,
  })) {
    pending.push({ eventId: event.id, paymentId: event.data?.object?.id ?? null, pendingWebhooks: event.pending_webhooks ?? null });
  }
  const at = Date.now();
  db.transaction(() => { for (const p of pending) insert.run(at, p.eventId, p.paymentId, p.pendingWebhooks); })();
  // A marker row, so an empty snapshot ("nothing pending") is recorded too.
  insert.run(at, null, null, pending.length);
  log(`${new Date(at).toISOString()} ${pending.length} payment_intent.succeeded event(s) not yet delivered` +
    (pending.length ? ': ' + pending.map((p) => `${p.eventId}(${p.pendingWebhooks})`).join(' ') : ''));
  return pending;
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({ options: { every: { type: 'string' }, 'since-hours': { type: 'string', default: '24' } } });
  const db = openDb();
  const { logApiCall } = makeHelpers(db);
  const stripe = createStripe({ onRequest: () => logApiCall('snapshot') });
  const runOnce = async () => {
    try { await snapshotPending({ db, stripe, sinceHours: Number(values['since-hours']) }); }
    catch (err) { console.error(`${new Date().toISOString()} snapshot failed: ${err.message}`); process.exitCode = 1; }
  };
  if (values.every) await runEvery(values.every, runOnce);
  else await runOnce();
}
