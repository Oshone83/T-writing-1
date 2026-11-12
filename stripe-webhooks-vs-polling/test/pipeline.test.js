// End-to-end: create payments -> poll + webhook -> outage + retries -> lost event -> reconcile -> analyze.
// Runs against test/support/fake-stripe.js, with the real Stripe SDK on the client side.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { openDb, makeHelpers } from '../lib/db.js';
import { createStripe } from '../lib/stripe-client.js';
import { createPayments } from '../create-payments.js';
import { pollOnce } from '../poll.js';
import { reconcile } from '../reconcile.js';
import { forgetEvent } from '../simulate-lost-event.js';
import { snapshotPending } from '../snapshot-pending.js';
import { createApp } from '../receiver.js';
import { analyze, renderChart, renderSummary } from '../analyze.js';
import { createFakeStripe } from './support/fake-stripe.js';
import net from 'node:net';

const secret = 'whsec_pipeline_test';
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });

test('full pipeline against a fake Stripe', { timeout: 60_000 }, async () => {
  const port = await freePort();
  const fake = createFakeStripe({ webhookUrl: `http://127.0.0.1:${port}/webhooks/stripe`, webhookSecret: secret, retryDelaysMs: [500, 1000, 1500] });
  process.env.STRIPE_API_BASE = await fake.start();
  after(() => { delete process.env.STRIPE_API_BASE; return fake.stop(); });

  const db = openDb(':memory:');
  const { logApiCall } = makeHelpers(db);
  // One client per source, like the real scripts, so API calls are attributed correctly.
  const client = (source) => createStripe({ key: 'sk_test_pipeline', onRequest: () => logApiCall(source) });
  const stripe = client('poll');
  const creator = client('create');
  const reconciler = client('reconcile');
  const snapshotter = client('snapshot');
  const app = createApp({ db, endpointSecret: secret, log: () => {} });
  const startReceiver = () => new Promise((r) => { const s = app.listen(port, '127.0.0.1', () => r(s)); });
  let receiver = await startReceiver();
  db.prepare('INSERT INTO receiver_runs (started_ms) VALUES (?)').run(Date.now());

  // Side by side: 6 payments, poll once after them.
  const created = await createPayments({ db, stripe: creator, count: 6, minGapMs: 20, maxGapMs: 60, phase: 'side-by-side', log: () => {} });
  assert.deepEqual(created, { ok: 6, failed: 0 });
  await sleep(300);
  const p1 = await pollOnce({ db, stripe });
  assert.equal(p1.found, 6);
  assert.equal((await pollOnce({ db, stripe })).found, 0, 'second poll finds nothing new');

  // Outage: stop receiver, create 3 payments, first attempts fail, restart, retries land.
  await new Promise((r) => receiver.close(r));
  db.prepare('UPDATE receiver_runs SET stopped_ms = ?').run(Date.now());
  await createPayments({ db, stripe: creator, count: 3, minGapMs: 10, maxGapMs: 20, phase: 'outage', log: () => {} });
  await sleep(700); // first attempts + first retries fail
  const pendingDuringOutage = await snapshotPending({ db, stripe: snapshotter, log: () => {} });
  assert.equal(pendingDuringOutage.length, 3, 'Stripe-side view: 3 events undelivered during the outage');
  receiver = await startReceiver();
  db.prepare('INSERT INTO receiver_runs (started_ms) VALUES (?)').run(Date.now());
  await sleep(2500);
  after(() => new Promise((r) => receiver.close(r)));

  const failed = fake.attempts.filter((a) => !a.result.startsWith('2'));
  assert.ok(failed.length >= 3, `expected failed attempts during the outage, got ${failed.length}`);

  // A duplicate on purpose: the event-ID table must turn it into a no-op.
  await fake.redeliver(fake.events[0].id);

  assert.equal((await snapshotPending({ db, stripe: snapshotter, log: () => {} })).length, 0, 'nothing pending after retries');

  // Measured payments can't be forgotten (C1).
  assert.throws(() => forgetEvent(db, fake.events.at(-1).id), /refusing: .* 'outage' payment/);
  assert.throws(() => forgetEvent(db, fake.events[0].id), /refusing: .* 'side-by-side' payment/);
  assert.throws(() => forgetEvent(db), /no delivered 'lost-event' payment yet/);

  // Lost event on its own payment: forget it, reconcile must bring it back, a second run does nothing.
  await createPayments({ db, stripe: creator, count: 1, minGapMs: 0, maxGapMs: 0, phase: 'lost-event', log: () => {} });
  await sleep(300);
  const lost = forgetEvent(db);
  const rec = await reconcile({ db, stripe: reconciler, sinceHours: 1, log: () => {} });
  assert.deepEqual(rec.recovered.map((r) => r.eventId), [lost.event_id]);
  assert.equal((await reconcile({ db, stripe: reconciler, sinceHours: 1, log: () => {} })).recovered.length, 0, 'second reconcile is a no-op');

  const manualAttemptsCsv = `# comment\nevent_id,attempted_at_utc,result,next_retry_at_utc,notes\n${fake.events[6].id},2026-01-01T00:00:00Z,502,,\n${fake.events[6].id},2026-01-01T00:05:00Z,200,,\n`;
  const r = analyze(db, { codeFiles: { 'poll.js': 'a\nb\n', 'receiver.js': 'c\n' }, manualAttemptsCsv });
  assert.equal(r.sideBySide.payments, 6);
  assert.equal(r.sideBySide.poll.n, 6);
  assert.equal(r.sideBySide.webhook.n, 6);
  assert.deepEqual(r.sideBySide.missedByWebhook, []);
  assert.equal(r.deliveries.duplicates, 1);
  assert.equal(r.outage.payments.length, 3);
  assert.ok(r.outage.allEventuallyKnown);
  // Outage measurements are untouched by the lost-event demo: every one was delivered by a webhook retry.
  assert.ok(r.outage.allDeliveredByWebhook);
  assert.ok(r.outage.payments.every((p) => p.app_knew_via === 'webhook'));
  assert.equal(r.outage.payments[0].dashboard_failed_attempts, 1, 'one non-2xx row in the Dashboard CSV');
  assert.ok(r.outage.payments.every((p) => p.stripe_reported_pending_first), 'each outage event was seen pending');
  assert.equal(r.dashboard.failed_attempts, 1);
  assert.equal(r.pendingSnapshots.runs, 2);
  assert.equal(r.pendingSnapshots.max_pending, 3);
  assert.equal(r.lostEvent.length, 1);
  assert.ok(r.lostEvent[0].recovered && r.lostEvent[0].delivered_by_webhook_at);
  assert.equal(r.reconcile.events_recovered, 1);
  assert.deepEqual(r.reconcile.payments.map((p) => p.phase), ['lost-event']);
  // API calls attributed per source.
  assert.equal(r.apiCalls.totals.poll, 2);
  assert.equal(r.apiCalls.totals.create, 10);
  assert.equal(r.apiCalls.totals.reconcile, 2);
  assert.equal(r.apiCalls.totals.snapshot, 2);
  // Webhook "app knows" is the SQLite write, at or after the request arrived (C6).
  assert.ok(r.sideBySide.perPayment.every((p) => p.webhook.seen_ms >= p.webhook_arrival_ms));
  assert.ok(r.sideBySide.receiverWriteLag.max < 1000);
  assert.equal(r.outage.windows.length, 1);
  assert.ok(r.outage.payments.every((p) => p.webhook_deliveries >= 1));
  assert.ok(r.apiCalls.byHour.reduce((a, h) => a + h.poll_calls, 0) > 0, 'API calls were counted');
  assert.equal(r.code['poll.js'], 2);

  const svg = renderChart(r.sideBySide.perPayment, { label: 'test' });
  assert.match(svg, /<svg[\s\S]*<circle class="poll"[\s\S]*<rect class="webhook"/);
  assert.match(renderSummary(r, { label: 'SIMULATED' }), /Median delay/);
});
