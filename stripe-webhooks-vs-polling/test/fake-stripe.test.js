// The fake Stripe must behave like the parts of Stripe we rely on, or the demo proves nothing.
// These tests use the official Stripe SDK as the client, exactly as the app does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import Stripe from 'stripe';
import { createFakeStripe } from '../fake-stripe.js';
import { createStripe } from '../lib/stripe-client.js';

const secret = 'whsec_fake_stripe_tests';

// A tiny webhook target that verifies each signature and answers with status(n) for the n-th request.
async function target(status = () => 200) {
  const got = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    got.push(Stripe.webhooks.constructEvent(body, req.headers['stripe-signature'], secret)); // throws if badly signed
    res.writeHead(status(got.length)); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { got, url: `http://127.0.0.1:${server.address().port}/hook`, close: () => new Promise((r) => server.close(r)) };
}

test('the API needs a test-mode key; pm_card_visa succeeds and can be listed', async () => {
  const fake = createFakeStripe({ webhookSecret: secret });
  const apiBase = await fake.start();
  try {
    const res = await fetch(`${apiBase}/v1/payment_intents`, { headers: { authorization: 'Bearer sk_live_nope' } });
    assert.equal(res.status, 401);
    const stripe = createStripe({ key: 'sk_test_x', apiBase });
    const pi = await stripe.paymentIntents.create({ amount: 1000, currency: 'usd', payment_method: 'pm_card_visa', confirm: true });
    assert.equal(pi.status, 'succeeded');
    const listed = [];
    for await (const p of stripe.paymentIntents.list({ created: { gte: pi.created }, limit: 1 })) listed.push(p.id);
    assert.deepEqual(listed, [pi.id]);
  } finally { await fake.stop(); }
});

test('signed webhook per success; a 3-D Secure payment emits only when it succeeds', async () => {
  const t = await target();
  const fake = createFakeStripe({ webhookUrl: t.url, webhookSecret: secret, deliveryDelayMs: 0 });
  const apiBase = await fake.start();
  const stripe = createStripe({ key: 'sk_test_x', apiBase });
  try {
    const pi = await stripe.paymentIntents.create({ amount: 500, currency: 'usd', payment_method: 'pm_card_threeDSecure2Required', confirm: true });
    assert.equal(pi.status, 'requires_action');
    await sleep(100);
    assert.equal(t.got.length, 0, 'no event before it succeeds');
    const res = await fetch(`${apiBase}/_sim/payment_intents/${pi.id}/succeed`, { method: 'POST' });
    assert.equal(res.status, 200);
    await sleep(100);
    assert.equal(t.got.length, 1);
    assert.equal(t.got[0].type, 'payment_intent.succeeded');
    assert.equal(t.got[0].data.object.id, pi.id);
  } finally { await fake.stop(); await t.close(); }
});

test('failed deliveries are retried on schedule, re-signed, then given up', async () => {
  const t = await target(() => 500); // always fails
  const fake = createFakeStripe({ webhookUrl: t.url, webhookSecret: secret, deliveryDelayMs: 0, retryDelaysMs: [50, 50] });
  const stripe = createStripe({ key: 'sk_test_x', apiBase: await fake.start() });
  try {
    await stripe.paymentIntents.create({ amount: 500, currency: 'usd', payment_method: 'pm_card_visa', confirm: true });
    await sleep(400);
    assert.deepEqual(fake.attempts.map((a) => [a.attempt, a.result]), [[0, 'HTTP 500'], [1, 'HTTP 500'], [2, 'HTTP 500']]);
    assert.equal(t.got.length, 3, 'first attempt + 2 retries, each passed signature verification');
    assert.equal(new Set(t.got.map((e) => e.id)).size, 1, 'retries reuse the same event ID');
    // The events list can still find it: undelivered events are reported with delivery_success=false.
    const undelivered = await stripe.events.list({ delivery_success: false });
    assert.equal(undelivered.data.length, 1);
  } finally { await fake.stop(); await t.close(); }
});

test('resend delivers the same event again (a duplicate)', async () => {
  const t = await target();
  const fake = createFakeStripe({ webhookUrl: t.url, webhookSecret: secret, deliveryDelayMs: 0 });
  const apiBase = await fake.start();
  const stripe = createStripe({ key: 'sk_test_x', apiBase });
  try {
    await stripe.paymentIntents.create({ amount: 500, currency: 'usd', payment_method: 'pm_card_visa', confirm: true });
    await sleep(100);
    const res = await fetch(`${apiBase}/_sim/events/${fake.events[0].id}/resend`, { method: 'POST' });
    assert.deepEqual(await res.json(), { delivered: true });
    assert.deepEqual(t.got.map((e) => e.id), [fake.events[0].id, fake.events[0].id]);
  } finally { await fake.stop(); await t.close(); }
});
