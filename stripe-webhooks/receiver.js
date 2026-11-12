// receiver.js
import express from 'express';
import Stripe from 'stripe';
import { db, markSeen } from './db.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET; // whsec_...
const remember = db.prepare('INSERT OR IGNORE INTO processed_events (event_id, received_ms) VALUES (?, ?)');

const app = express();

// express.raw, not express.json: the signature is computed over the exact bytes Stripe sent.
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  // For the article only. Don't log full bodies in production: they contain customer data.
  console.log(new Date().toISOString(), req.method, req.originalUrl, JSON.stringify(req.headers));
  console.log(req.body.toString('utf8'));

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], endpointSecret);
  } catch (err) {
    return res.status(400).send(`Signature check failed: ${err.message}`);
  }

  const isNew = remember.run(event.id, Date.now()).changes === 1;
  if (!isNew) console.log('duplicate', event.id);

  if (isNew && event.type === 'payment_intent.succeeded') {
    markSeen(event.data.object.id, 'webhook'); // real work would go on a queue here
  }
  res.sendStatus(200);
});

app.listen(3000, () => console.log('listening on 3000'));
