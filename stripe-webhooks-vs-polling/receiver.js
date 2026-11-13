// receiver.js — the webhook version: one Express route that Stripe (or the fake) POSTs events to.
//
//   npm run receiver                       listens on 127.0.0.1:3000, POST /webhooks/stripe
//   LOG_REQUESTS=1 npm run receiver        also prints every raw request (headers + body)
//
// For each request it: 1) checks the signature, 2) skips event IDs it has already processed,
// 3) records the payment, 4) answers 200 quickly. Anything else makes Stripe retry later.
import express from 'express';
import Stripe from 'stripe';
import { isMain } from './lib/env.js';
import { openDb, makeHelpers } from './lib/db.js';
import { assertWebhookSecret } from './lib/stripe-client.js';

export function createApp({ db, endpointSecret, log = console.log, logRequests = false }) {
  assertWebhookSecret(endpointSecret);
  const { markSeen, processEventOnce } = makeHelpers(db);
  const recordDelivery = db.prepare(
    'INSERT INTO deliveries (event_id, event_type, payment_id, received_ms, duplicate) VALUES (?, ?, ?, ?, ?)'
  );

  const app = express();
  app.get('/health', (req, res) => res.send('ok'));

  // express.raw, not express.json: the signature covers the exact bytes that were sent, so we must
  // verify them before anything parses (and possibly re-formats) the JSON.
  app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), (req, res) => {
    const receivedMs = Date.now();
    if (logRequests) {
      // For learning only. Real payloads contain customer data: don't log them in production.
      log(`${req.method} ${req.originalUrl}\n${JSON.stringify(req.headers, null, 2)}\n${req.body?.toString('utf8')}`);
    }

    const signature = req.headers['stripe-signature'];
    if (!Buffer.isBuffer(req.body) || !signature) {
      return res.status(400).send('Expected a raw JSON body with a Stripe-Signature header');
    }

    // 1) Is this really from Stripe, and recent? constructEvent recomputes the HMAC signature with our
    //    whsec_ secret and rejects timestamps older than 5 minutes (replay protection).
    let event;
    try {
      event = Stripe.webhooks.constructEvent(req.body, signature, endpointSecret);
    } catch (err) {
      log(`signature check failed: ${err.message}`);
      return res.status(400).send(`Signature check failed: ${err.message}`);
    }

    // 2) + 3) Record the event ID and do the work in ONE database transaction. A duplicate delivery
    //    (same event ID) is a no-op. If the work fails, nothing is recorded and we answer 500,
    //    so Stripe retries and the retry can succeed.
    const payment = event.data?.object ?? {};
    let isNew;
    try {
      isNew = processEventOnce(event.id, 'webhook', () => {
        if (event.type === 'payment_intent.succeeded') markSeen(payment.id, 'webhook'); // real work: fulfil the order
      });
    } catch (err) {
      log(`failed to process ${event.id}: ${err.message}`);
      return res.sendStatus(500);
    }
    recordDelivery.run(event.id, event.type, payment.id ?? null, receivedMs, isNew ? 0 : 1);
    log(`${isNew ? 'new      ' : 'duplicate'} ${event.id} ${event.type} ${payment.id ?? ''}`);

    // 4) Answer quickly. Slow work belongs on a queue, or Stripe times out and retries.
    res.sendStatus(200);
  });

  return app;
}

if (isMain(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1'; // localhost only: nothing else on your network can reach it
  const app = createApp({
    db: openDb(), endpointSecret: process.env.STRIPE_WEBHOOK_SECRET,
    log: (m) => console.log(`${new Date().toISOString()} ${m}`), logRequests: process.env.LOG_REQUESTS === '1',
  });
  app.listen(port, host, (err) => {
    if (err) throw err;
    console.log(`receiver listening on http://${host}:${port}/webhooks/stripe (Ctrl+C to stop)`);
  });
}
