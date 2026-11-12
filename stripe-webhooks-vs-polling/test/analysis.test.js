// analyze.js and scripts/sample-request.js, on hand-built databases with known answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.js';
import { analyze, parseCsv } from '../analyze.js';
import { findGenuine, formatSample, shortenIds, redactSignature } from '../scripts/sample-request.js';

const MIN = 60_000;
const T0 = Date.parse('2026-11-20T10:00:00Z'); // first side-by-side payment

// Poller running every minute from T0-90min to T0+70min; 3 side-by-side payments.
function buildDb({ pollFrom = T0 - 90 * MIN, pollTo = T0 + 70 * MIN, extraPaymentAt } = {}) {
  const db = openDb(':memory:');
  const call = db.prepare("INSERT INTO api_calls (source, at_ms) VALUES ('poll', ?)");
  for (let t = pollFrom; t <= pollTo; t += MIN) call.run(t);
  const pay = db.prepare("INSERT INTO payments (id, created_ms, stripe_created_s, phase) VALUES (?, ?, ?, 'side-by-side')");
  const seen = db.prepare('INSERT INTO seen (id, method, seen_ms) VALUES (?, ?, ?)');
  const del = db.prepare(`INSERT INTO deliveries (event_id, event_type, payment_id, event_created_s, signature_t, received_ms, duplicate)
    VALUES (?, 'payment_intent.succeeded', ?, ?, ?, ?, 0)`);
  [[0, 30_000, 900], [5 * MIN, 10_000, 1100], [10 * MIN, 55_000, 700]].forEach(([dt, pollDelay, whDelay], i) => {
    const c = T0 + dt;
    pay.run(`pi_${i}`, c, Math.floor(c / 1000));
    seen.run(`pi_${i}`, 'poll', c + pollDelay);
    seen.run(`pi_${i}`, 'webhook', c + whDelay);
    del.run(`evt_${i}`, `pi_${i}`, Math.floor(c / 1000), Math.floor(c / 1000), c + whDelay - 2);
  });
  if (extraPaymentAt) db.prepare("INSERT INTO payments VALUES ('pi_smoke', ?, 0, 'smoke')").run(extraPaymentAt); // e.g. a smoke test
  return db;
}

test('delays: median, nearest-rank p95 and max per method', () => {
  const r = analyze(buildDb());
  assert.deepEqual([r.sideBySide.poll.median, r.sideBySide.poll.p95, r.sideBySide.poll.max], [30_000, 55_000, 55_000]);
  assert.deepEqual([r.sideBySide.webhook.median, r.sideBySide.webhook.max], [900, 1100]);
  assert.equal(r.sideBySide.receiverWriteLag.max, 2);
});

test('quiet window defaults to the 60 min before the first payment', () => {
  const q = analyze(buildDb()).apiCalls.quiet;
  assert.equal(q.valid, true);
  assert.equal(q.calls, 60);
  assert.equal(q.per_hour, 60);
  assert.equal(q.from, '2026-11-20T09:00:00.000Z');
});

test('quiet window is flagged when the poller started too late or a payment fell inside it', () => {
  assert.match(analyze(buildDb({ pollFrom: T0 - 30 * MIN })).apiCalls.quiet.problems.join(), /not running at the window start/);
  assert.match(analyze(buildDb({ extraPaymentAt: T0 - 20 * MIN })).apiCalls.quiet.problems.join(), /1 payment\(s\) were created inside/);
});

test('explicit --quiet-from/--quiet-to window', () => {
  const q = analyze(buildDb(), { quietFrom: '2026-11-20T08:45:00Z', quietTo: '2026-11-20T09:15:00Z' }).apiCalls.quiet;
  assert.equal(q.valid, true);
  assert.equal(q.calls, 30);
  assert.equal(q.per_hour, 60);
  assert.throws(() => analyze(buildDb(), { quietFrom: '2026-11-20T09:15:00Z', quietTo: '2026-11-20T08:45:00Z' }), /after/);
});

test('during-test count covers the 60 min from the first payment and says when incomplete', () => {
  assert.equal(analyze(buildDb()).apiCalls.duringTest.first_hour_calls, 60);
  assert.equal(analyze(buildDb()).apiCalls.duringTest.first_hour_complete, true);
  assert.equal(analyze(buildDb({ pollTo: T0 + 20 * MIN })).apiCalls.duringTest.first_hour_complete, false);
});

test('same payment under two event IDs is counted', () => {
  const db = buildDb();
  db.prepare(`INSERT INTO deliveries VALUES ('evt_0b', 'payment_intent.succeeded', 'pi_0', 0, 0, 0, 0)`).run();
  assert.deepEqual(analyze(db).deliveries.samePaymentMultipleEvents.map((x) => x.payment_id), ['pi_0']);
});

test('parseCsv skips comments and handles quoted commas', () => {
  const rows = parseCsv('# note\nevent_id,attempted_at_utc,result,next_retry_at_utc,notes\n\nevt_1,2026-01-01T00:00:00Z,502,,"bad gateway, tunnel up"\n');
  assert.deepEqual(rows, [{ event_id: 'evt_1', attempted_at_utc: '2026-01-01T00:00:00Z', result: '502', next_retry_at_utc: '', notes: 'bad gateway, tunnel up' }]);
  assert.deepEqual(parseCsv('# only comments\n'), []);
});

test('sample-request picks the first genuine Stripe request and redacts it', () => {
  const line = (ua, sig = 't=1,v1=abcdef0123456789abcdef') => JSON.stringify({
    at: 'x', method: 'POST', url: '/webhooks/stripe',
    headers: { 'user-agent': ua, 'content-type': 'application/json; charset=utf-8', ...(sig ? { 'stripe-signature': sig } : {}) },
    body: '{\n  "id": "evt_1QabcdefGHIJ",\n  "data": { "object": { "id": "pi_3Qxyz123456789" } }\n}',
  });
  const lines = [line('curl/8.5.0', null), line('FakeStripe/1.0 (test double, not Stripe)'), line('Stripe/1.0 (+https://stripe.com/docs/webhooks)')];
  const r = findGenuine(lines);
  assert.match(r.headers['user-agent'], /^Stripe\//);
  const out = formatSample(r);
  assert.match(out, /Stripe-Signature: t=1,v1=abcdef01…/);
  assert.match(out, /evt_1Qab…/);
  assert.match(out, /pi_3Qxy…/);
  assert.doesNotMatch(out, /0123456789abcdef|GHIJ|123456789/);
  assert.equal(findGenuine([line('FakeStripe/1.0')]), null);
  assert.equal(shortenIds('pi_12'), 'pi_12');
  assert.equal(redactSignature('t=5,v1=0123456789ab'), 't=5,v1=01234567…');
});
