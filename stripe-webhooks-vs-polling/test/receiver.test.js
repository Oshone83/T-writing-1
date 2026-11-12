// Webhook receiver tests. Signatures are produced by the Stripe SDK's own test helper,
// so these exercise the real constructEvent verification code.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import { openDb } from '../lib/db.js';
import { createApp, _internal } from '../receiver.js';

const secret = 'whsec_test_secret_for_unit_tests';
let db, server, url;

beforeEach(async () => {
  db = openDb(':memory:');
  const app = createApp({ db, endpointSecret: secret, log: () => {} });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  url = `http://127.0.0.1:${server.address().port}/webhooks/stripe`;
});
afterEach(() => new Promise((r) => server.close(r)));

const event = (id, piId, type = 'payment_intent.succeeded') => ({
  id, object: 'event', type, created: Math.floor(Date.now() / 1000), data: { object: { id: piId, object: 'payment_intent' } },
});
const post = (body, sig, contentType = 'application/json') =>
  fetch(url, { method: 'POST', headers: { 'content-type': contentType, ...(sig ? { 'stripe-signature': sig } : {}) }, body });
const sign = (payload, opts = {}) => Stripe.webhooks.generateTestHeaderString({ payload, secret, ...opts });

test('valid signature: 200, payment marked seen by webhook, delivery logged', async () => {
  const payload = JSON.stringify(event('evt_a', 'pi_a'));
  const res = await post(payload, sign(payload));
  assert.equal(res.status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM seen WHERE id='pi_a' AND method='webhook'").get().n, 1);
  const d = db.prepare('SELECT * FROM deliveries').get();
  assert.equal(d.event_id, 'evt_a');
  assert.equal(d.duplicate, 0);
  assert.ok(d.signature_t > 0);
});

test('duplicate delivery of the same event ID is a no-op that still returns 200', async () => {
  const payload = JSON.stringify(event('evt_b', 'pi_b'));
  assert.equal((await post(payload, sign(payload))).status, 200);
  assert.equal((await post(payload, sign(payload))).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM processed_events').get().n, 1);
  assert.deepEqual(db.prepare('SELECT duplicate FROM deliveries ORDER BY rowid').all().map((r) => r.duplicate), [0, 1]);
});

test('wrong secret, tampered body, missing header and stale timestamp are rejected with 400', async () => {
  const payload = JSON.stringify(event('evt_c', 'pi_c'));
  const wrong = Stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_other' });
  assert.equal((await post(payload, wrong)).status, 400);
  assert.equal((await post(payload.replace('pi_c', 'pi_x'), sign(payload))).status, 400);
  assert.equal((await post(payload)).status, 400);
  // Re-serialising (what express.json() + JSON.stringify would do) changes the bytes:
  const pretty = JSON.stringify(event('evt_c', 'pi_c'), null, 2); // what Stripe signed
  assert.equal((await post(JSON.stringify(JSON.parse(pretty)), sign(pretty))).status, 400);
  const old = sign(payload, { timestamp: Math.floor(Date.now() / 1000) - 600 }); // > 300 s tolerance
  assert.equal((await post(payload, old)).status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM processed_events').get().n, 0);
});

test('other event types are remembered but do not mark a payment seen', async () => {
  const payload = JSON.stringify(event('evt_d', 'pi_d', 'payment_intent.created'));
  assert.equal((await post(payload, sign(payload))).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM seen').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM processed_events').get().n, 1);
});

test('signatureTime parses t= from the header', () => {
  assert.equal(_internal.signatureTime('t=1700000000,v1=abc,v0=def'), 1700000000);
  assert.equal(_internal.signatureTime('v1=abc'), null);
});

test('createApp refuses to start without a whsec_ secret', () => {
  assert.throws(() => createApp({ db, endpointSecret: undefined }), /STRIPE_WEBHOOK_SECRET/);
});

test('work that fails returns 500 and is not marked processed, so a retry can succeed', async () => {
  const payload = JSON.stringify(event('evt_f', 'pi_f'));
  db.exec('ALTER TABLE seen RENAME TO seen_gone'); // make the write fail
  assert.equal((await post(payload, sign(payload))).status, 500);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM processed_events').get().n, 0);
  db.exec('ALTER TABLE seen_gone RENAME TO seen');
  assert.equal((await post(payload, sign(payload))).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM seen WHERE id = 'pi_f'").get().n, 1);
});

test('charset in Content-Type (what Stripe sends) still gets the raw body', async () => {
  const payload = JSON.stringify(event('evt_g', 'pi_g'));
  assert.equal((await post(payload, sign(payload), 'application/json; charset=utf-8')).status, 200);
});
