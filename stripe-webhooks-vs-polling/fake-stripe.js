// fake-stripe.js — a small local stand-in for the parts of Stripe this project uses.
//
// It is a SIMULATION. It speaks the same HTTP API shapes as Stripe for the few calls we make, and it
// signs webhooks with the same scheme (the Stripe SDK's own signing helper), so the real receiver
// code runs unchanged. Its timings are made up: real Stripe retries over hours or days, not seconds.
//
// What it does:
//   POST /v1/payment_intents             create a payment. pm_card_visa succeeds at once;
//                                        pm_card_threeDSecure2Required waits for "3-D Secure"
//   GET  /v1/payment_intents             list payments (newest first, created[gte] filter, paging)
//   GET  /v1/events                      list events (type, created[gte], delivery_success filters)
//   POST /_sim/payment_intents/:id/succeed   simulation only: the customer finishes 3-D Secure
//   POST /_sim/events/:id/resend         simulation only: deliver an event again (a duplicate)
// Every payment_intent.succeeded event is POSTed to the webhook URL, retried on failure, then given up.
//
// Run on its own:  npm run fake-stripe   (settings come from .env, see .env.example)
import http from 'node:http';
import Stripe from 'stripe';
import { isMain } from './lib/env.js';

export function createFakeStripe({
  webhookUrl,                         // where to POST events, e.g. http://127.0.0.1:3000/webhooks/stripe
  webhookSecret,                      // whsec_…, must match the receiver's STRIPE_WEBHOOK_SECRET
  retryDelaysMs = [10_000, 30_000, 60_000], // wait before retry 1, 2, 3; then give up
  deliveryDelayMs = 20,               // pause between an event happening and its first delivery
  log = () => {},
} = {}) {
  const paymentIntents = [];
  const events = [];
  const attempts = []; // every delivery attempt: { event_id, attempt, at_ms, result }
  const timers = new Set();
  let seq = 0;
  const newId = (prefix) => `${prefix}_sim_${String(++seq).padStart(6, '0')}`;
  const nowS = () => Math.floor(Date.now() / 1000);
  const later = (ms, fn) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); };

  // One delivery attempt: a signed POST, exactly like Stripe's.
  async function deliver(event, attempt) {
    const payload = JSON.stringify(event, null, 2);
    // Stripe signs every attempt afresh, with the current time as t=.
    const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: webhookSecret, timestamp: nowS() });
    let result;
    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'stripe-signature': signature,
          'user-agent': 'FakeStripe/1.0 (local simulation)',
        },
        body: payload,
        signal: AbortSignal.timeout(5000),
      });
      result = `HTTP ${res.status}`;
    } catch (err) {
      result = err.cause?.code === 'ECONNREFUSED' ? 'connection refused' : `error: ${err.cause?.code ?? err.message}`;
    }
    const ok = /^HTTP 2\d\d$/.test(result);
    attempts.push({ event_id: event.id, attempt, at_ms: Date.now(), result });

    const label = attempt === 'resend' ? 'resend' : attempt === 0 ? 'first attempt' : `retry ${attempt}`;
    if (ok) {
      event.pending_webhooks = 0;
      log(`${event.id} ${label}: ${result}`);
    } else if (typeof attempt === 'number' && attempt < retryDelaysMs.length) {
      log(`${event.id} ${label}: ${result}; next retry in ${retryDelaysMs[attempt] / 1000} s`);
      later(retryDelaysMs[attempt], () => deliver(event, attempt + 1));
    } else {
      log(`${event.id} ${label}: ${result}; no retries left, giving up`);
    }
    return ok;
  }

  function emitSucceeded(pi) {
    const event = {
      id: newId('evt'), object: 'event', type: 'payment_intent.succeeded', created: nowS(),
      livemode: false, pending_webhooks: webhookUrl ? 1 : 0, data: { object: { ...pi } },
    };
    events.push(event);
    if (webhookUrl) later(deliveryDelayMs, () => deliver(event, 0));
    return event;
  }

  function list(items, url, q, filter) {
    const gte = q.get('created[gte]');
    const limit = Math.min(Number(q.get('limit') ?? 10), 100);
    const after = q.get('starting_after');
    let rows = items.filter((x) => (gte == null || x.created >= Number(gte)) && filter(x)).reverse(); // newest first
    if (after) rows = rows.slice(rows.findIndex((x) => x.id === after) + 1);
    return { object: 'list', url, has_more: rows.length > limit, data: rows.slice(0, limit) };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    let body = '';
    for await (const chunk of req) body += chunk;

    // Simulation-only controls (no API key needed, they don't exist on real Stripe).
    let m;
    if (req.method === 'POST' && (m = url.pathname.match(/^\/_sim\/payment_intents\/([^/]+)\/succeed$/))) {
      const pi = paymentIntents.find((p) => p.id === m[1]);
      if (!pi) return send(404, { error: { message: `no payment ${m[1]}` } });
      if (pi.status === 'succeeded') return send(409, { error: { message: `${pi.id} already succeeded` } });
      pi.status = 'succeeded';
      emitSucceeded(pi);
      return send(200, pi);
    }
    if (req.method === 'POST' && (m = url.pathname.match(/^\/_sim\/events\/([^/]+)\/resend$/))) {
      const event = events.find((e) => e.id === m[1]);
      if (!event) return send(404, { error: { message: `no event ${m[1]}` } });
      return send(200, { delivered: await deliver(event, 'resend') });
    }

    // The Stripe API itself: needs a test-mode key, like the real one.
    if (!/^Bearer (sk|rk)_test_/.test(req.headers.authorization ?? '')) {
      return send(401, { error: { type: 'invalid_request_error', message: 'Invalid API Key provided' } });
    }
    if (req.method === 'POST' && url.pathname === '/v1/payment_intents') {
      const params = new URLSearchParams(body);
      const needs3ds = params.get('payment_method') === 'pm_card_threeDSecure2Required';
      const pi = {
        id: newId('pi'), object: 'payment_intent', amount: Number(params.get('amount') ?? 0),
        currency: params.get('currency') ?? 'usd', created: nowS(), livemode: false,
        status: needs3ds ? 'requires_action' : 'succeeded',
      };
      paymentIntents.push(pi);
      if (!needs3ds) emitSucceeded(pi);
      return send(200, pi);
    }
    if (req.method === 'GET' && url.pathname === '/v1/payment_intents') {
      return send(200, list(paymentIntents, '/v1/payment_intents', url.searchParams, () => true));
    }
    if (req.method === 'GET' && url.pathname === '/v1/events') {
      const type = url.searchParams.get('type');
      const ds = url.searchParams.get('delivery_success'); // 'false' = not yet delivered / given up
      return send(200, list(events, '/v1/events', url.searchParams,
        (e) => (!type || e.type === type) && (ds == null || (ds === 'false') === (e.pending_webhooks > 0))));
    }
    send(404, { error: { message: `fake Stripe has no route ${req.method} ${url.pathname}` } });
  });

  return {
    paymentIntents, events, attempts,
    /** Start listening; resolves to the base URL, e.g. http://127.0.0.1:12111 */
    start: (port = 0) => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    }),
    stop: () => { for (const t of timers) clearTimeout(t); timers.clear(); return new Promise((r) => server.close(() => r())); },
    succeed: (piId) => { const pi = paymentIntents.find((p) => p.id === piId); pi.status = 'succeeded'; return emitSucceeded(pi); },
    resend: (eventId) => deliver(events.find((e) => e.id === eventId), 'resend'),
  };
}

if (isMain(import.meta.url)) {
  const base = new URL(process.env.STRIPE_API_BASE || 'http://127.0.0.1:12111');
  const retrySeconds = (process.env.FAKE_STRIPE_RETRY_SECONDS || '10,30,60').split(',').map(Number);
  const webhookUrl = process.env.FAKE_STRIPE_WEBHOOK_URL || `http://127.0.0.1:${process.env.PORT || 3000}/webhooks/stripe`;
  if (!process.env.STRIPE_WEBHOOK_SECRET) throw new Error('STRIPE_WEBHOOK_SECRET is not set. Run: cp .env.example .env');
  const fake = createFakeStripe({
    webhookUrl, webhookSecret: process.env.STRIPE_WEBHOOK_SECRET, retryDelaysMs: retrySeconds.map((s) => s * 1000),
    log: (m) => console.log(`${new Date().toISOString()} ${m}`),
  });
  const at = await fake.start(Number(base.port));
  console.log(`fake Stripe (SIMULATION) listening on ${at}`);
  console.log(`webhooks go to ${webhookUrl}; on failure it waits ${retrySeconds.join(', ')} s between attempts, then gives up`);
}
