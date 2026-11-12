// receiver.js — the webhook version: one Express route.
//
//   node receiver.js        listens on PORT (default 3000), path /webhooks/stripe
import express from 'express';
import Stripe from 'stripe';
import fs from 'node:fs';
import path from 'node:path';
import { isMain, PROJECT_DIR } from './lib/env.js';
import { openDb, makeHelpers } from './lib/db.js';
import { assertWebhookSecret } from './lib/stripe-client.js';

const signatureTime = (header) => {
  const t = /(?:^|,)t=(\d+)/.exec(header ?? '');
  return t ? Number(t[1]) : null;
};

export function createApp({ db, endpointSecret, requestLog, log = console.log }) {
  assertWebhookSecret(endpointSecret);
  const { markSeen, processEventOnce } = makeHelpers(db);
  const recordDelivery = db.prepare(
    `INSERT INTO deliveries (event_id, event_type, payment_id, event_created_s, signature_t, received_ms, duplicate)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  const app = express();
  app.get('/health', (req, res) => res.send('ok'));

  // express.raw, not express.json: the signature is computed over the exact bytes Stripe sent.
  // This route must be registered before any app-wide express.json().
  app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), (req, res) => {
    const receivedMs = Date.now();
    const sigHeader = req.headers['stripe-signature'];

    // For the article only. Don't log full bodies in production: they contain customer data.
    if (requestLog) {
      requestLog.write(JSON.stringify({
        at: new Date(receivedMs).toISOString(), method: req.method, url: req.originalUrl,
        headers: req.headers, body: Buffer.isBuffer(req.body) ? req.body.toString('utf8') : null,
      }) + '\n');
    }

    if (!Buffer.isBuffer(req.body) || !sigHeader) {
      return res.status(400).send('Expected a raw JSON body with a Stripe-Signature header');
    }

    let event;
    try {
      event = Stripe.webhooks.constructEvent(req.body, sigHeader, endpointSecret);
    } catch (err) {
      log(`${new Date(receivedMs).toISOString()} signature check failed: ${err.message}`);
      return res.status(400).send(`Signature check failed: ${err.message}`);
    }

    const obj = event.data?.object ?? {};
    const isPayment = event.type === 'payment_intent.succeeded';
    let isNew;
    try {
      isNew = processEventOnce(event.id, 'webhook', () => {
        if (isPayment) markSeen(obj.id, 'webhook', receivedMs); // real work would go on a queue here
      });
    } catch (err) {
      // Nothing was committed, so a 500 makes Stripe retry and the retry can succeed.
      log(`${new Date().toISOString()} failed to record ${event.id}: ${err.message}`);
      return res.sendStatus(500);
    }
    recordDelivery.run(event.id, event.type, obj.id ?? null, event.created, signatureTime(sigHeader), receivedMs, isNew ? 0 : 1);

    log(`${new Date(receivedMs).toISOString()} ${isNew ? 'new      ' : 'duplicate'} ${event.id} ${event.type} ${obj.id ?? ''}`);
    res.sendStatus(200);
  });

  return app;
}

// Exported for the unit tests.
export const _internal = { signatureTime };

if (isMain(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const db = openDb();
  fs.mkdirSync(path.join(PROJECT_DIR, 'logs'), { recursive: true });
  const requestLog = fs.createWriteStream(path.join(PROJECT_DIR, 'logs', 'webhook-requests.jsonl'), { flags: 'a' });
  const app = createApp({ db, endpointSecret: process.env.STRIPE_WEBHOOK_SECRET, requestLog });
  const server = app.listen(port, (err) => {
    if (err) throw err;
    const run = db.prepare('INSERT INTO receiver_runs (started_ms) VALUES (?)').run(Date.now());
    console.log(`${new Date().toISOString()} listening on ${port}, POST /webhooks/stripe`);
    const stop = (sig) => {
      db.prepare('UPDATE receiver_runs SET stopped_ms = ? WHERE rowid = ?').run(Date.now(), run.lastInsertRowid);
      console.log(`${new Date().toISOString()} ${sig}: receiver stopped`);
      server.close();
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}
