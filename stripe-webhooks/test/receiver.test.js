import test from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import { freshDir, startBackground, waitFor } from './helpers.js';

const secret = 'whsec_test_secret';
const stripe = new Stripe('sk_test_fake');
const URL_ = 'http://127.0.0.1:3000/webhooks/stripe';

const send = (payload, header) =>
  fetch(URL_, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': header }, body: payload });
const signed = (obj) => {
  const payload = JSON.stringify(obj);
  return [payload, stripe.webhooks.generateTestHeaderString({ payload, secret })];
};

test('verifies signatures, records events once, ignores other types', async (t) => {
  const { dir, db } = freshDir(t);
  const rx = startBackground('receiver.js', { cwd: dir, env: { STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: secret } });
  t.after(() => rx.child.kill());
  await waitFor(() => rx.output().includes('listening on 3000'));

  const event = { id: 'evt_1', object: 'event', type: 'payment_intent.succeeded', data: { object: { id: 'pi_1' } } };
  let res = await send(...signed(event));
  assert.equal(res.status, 200);

  // A retry reuses the event ID and gets a fresh signature: accepted, but a no-op.
  res = await send(...signed(event));
  assert.equal(res.status, 200);
  await waitFor(() => rx.output().includes('duplicate evt_1'));

  // Tampered body with the old signature fails.
  const [payload, header] = signed({ ...event, id: 'evt_2' });
  res = await send(payload.replace('pi_1', 'pi_X'), header);
  assert.equal(res.status, 400);
  assert.match(await res.text(), /Signature check failed/);

  // Other event types are remembered but don't mark a payment as seen.
  res = await send(...signed({ id: 'evt_3', object: 'event', type: 'charge.updated', data: { object: { id: 'ch_1' } } }));
  assert.equal(res.status, 200);

  const d = db();
  assert.deepEqual(d.prepare('SELECT event_id FROM processed_events ORDER BY event_id').all().map((r) => r.event_id), ['evt_1', 'evt_3']);
  assert.deepEqual(d.prepare('SELECT id, method FROM seen').all(), [{ id: 'pi_1', method: 'webhook' }]);
});
