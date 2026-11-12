// test/support/fake-stripe.js — a tiny local stand-in for the parts of Stripe this project uses.
// ONLY for automated tests and `npm run demo`. It is not Stripe; numbers from it mean nothing
// about Stripe's real latency or retry schedule.
//
// Implements: POST /v1/payment_intents, GET /v1/payment_intents, GET /v1/events,
// and signed webhook delivery of payment_intent.succeeded with configurable retries.
import http from 'node:http';
import Stripe from 'stripe';

export function createFakeStripe({ webhookUrl, webhookSecret, retryDelaysMs = [1000, 2000, 4000], deliveryDelayMs = 50 } = {}) {
  const paymentIntents = [];
  const events = [];
  const attempts = []; // { event_id, at_ms, result }
  let seq = 0;
  const id = (prefix) => `${prefix}_fake${String(++seq).padStart(6, '0')}`;
  const nowS = () => Math.floor(Date.now() / 1000);
  const timers = new Set();
  const later = (ms, fn) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); };

  async function deliver(event, attempt = 0) {
    const payload = JSON.stringify(event, null, 2);
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: webhookSecret, timestamp: nowS() });
    let result;
    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'stripe-signature': header,
          'user-agent': 'FakeStripe/1.0 (test double, not Stripe)',
        },
        body: payload,
        signal: AbortSignal.timeout(5000),
      });
      result = String(res.status);
    } catch (err) {
      result = `error: ${err.cause?.code ?? err.message}`;
    }
    attempts.push({ event_id: event.id, at_ms: Date.now(), attempt, result });
    const ok = /^2\d\d$/.test(result);
    if (ok) event.pending_webhooks = 0;
    if (!ok && attempt < retryDelaysMs.length) later(retryDelaysMs[attempt], () => deliver(event, attempt + 1));
    return ok;
  }

  function list(items, url, q, filter) {
    const gte = q.get('created[gte]');
    const limit = Math.min(Number(q.get('limit') ?? 10), 100);
    const after = q.get('starting_after');
    let rows = items.filter((x) => (gte == null || x.created >= Number(gte)) && filter(x));
    rows = [...rows].reverse(); // newest first, like Stripe
    if (after) rows = rows.slice(rows.findIndex((x) => x.id === after) + 1);
    return { object: 'list', url, has_more: rows.length > limit, data: rows.slice(0, limit) };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'request-id': id('req') }); res.end(JSON.stringify(body)); };
    if (!/^Bearer (sk|rk)_test_/.test(req.headers.authorization ?? '')) return send(401, { error: { type: 'invalid_request_error', message: 'bad key' } });

    if (req.method === 'POST' && url.pathname === '/v1/payment_intents') {
      for await (const _ of req); // drain body
      const pi = { id: id('pi'), object: 'payment_intent', amount: 1000, currency: 'usd', status: 'succeeded', created: nowS() };
      paymentIntents.push(pi);
      const event = {
        id: id('evt'), object: 'event', api_version: '2026-10-28.endive', created: nowS(),
        type: 'payment_intent.succeeded', data: { object: pi }, livemode: false, pending_webhooks: 1,
      };
      events.push(event);
      if (webhookUrl) later(deliveryDelayMs, () => deliver(event));
      return send(200, pi);
    }
    if (req.method === 'GET' && url.pathname === '/v1/payment_intents') {
      return send(200, list(paymentIntents, '/v1/payment_intents', url.searchParams, () => true));
    }
    if (req.method === 'GET' && url.pathname === '/v1/events') {
      const type = url.searchParams.get('type');
      const ds = url.searchParams.get('delivery_success'); // 'false' = still pending / failed all attempts
      return send(200, list(events, '/v1/events', url.searchParams,
        (e) => (!type || e.type === type) && (ds == null || (ds === 'false') === (e.pending_webhooks > 0))));
    }
    send(404, { error: { message: `fake stripe: no route ${req.method} ${url.pathname}` } });
  });

  return {
    paymentIntents, events, attempts,
    /** Resend an event as a brand-new delivery (to produce a duplicate on purpose). */
    redeliver: (eventId) => deliver(events.find((e) => e.id === eventId), Infinity),
    start: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))),
    stop: () => { for (const t of timers) clearTimeout(t); return new Promise((r) => server.close(() => r())); },
  };
}
