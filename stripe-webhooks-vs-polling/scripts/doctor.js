// scripts/doctor.js — checks keys and Stripe access for ./exp doctor. Never prints a key's value.
import { isMain } from '../lib/env.js';
import { openDb, makeHelpers } from '../lib/db.js';
import { createStripe } from '../lib/stripe-client.js';

const ok = (m) => console.log(`✓ ${m}`);
const bad = (m) => console.log(`✗ ${m}`);

export function describeKey(key) {
  if (!key) return { ok: false, text: 'STRIPE_SECRET_KEY not set (Codespaces secret, or ./exp set-api-key)' };
  if (/replace_me/.test(key)) return { ok: false, text: 'STRIPE_SECRET_KEY is the .env.example placeholder' };
  if (/^(sk|rk)_live_/.test(key)) return { ok: false, text: 'STRIPE_SECRET_KEY is a LIVE key: refused. Use a test-mode key' };
  if (/^(sk|rk)_test_/.test(key)) return { ok: true, text: `STRIPE_SECRET_KEY is a test-mode ${key.startsWith('rk_') ? 'restricted' : 'secret'} key` };
  return { ok: false, text: 'STRIPE_SECRET_KEY does not look like a Stripe key (expected sk_test_… or rk_test_…)' };
}
export function describeSecret(secret) {
  if (!secret) return { ok: false, text: 'STRIPE_WEBHOOK_SECRET not set (./exp set-webhook-secret)' };
  if (/replace_me/.test(secret)) return { ok: false, text: 'STRIPE_WEBHOOK_SECRET is the .env.example placeholder' };
  if (!secret.startsWith('whsec_')) return { ok: false, text: 'STRIPE_WEBHOOK_SECRET should start with whsec_' };
  return { ok: true, text: 'STRIPE_WEBHOOK_SECRET is set' };
}

if (isMain(import.meta.url)) {
  const [major] = process.versions.node.split('.').map(Number);
  (major >= 22 ? ok : bad)(`Node ${process.version}${major >= 22 ? '' : ' (need 22 or later)'}`);
  const k = describeKey(process.env.STRIPE_SECRET_KEY);
  (k.ok ? ok : bad)(k.text);
  const w = describeSecret(process.env.STRIPE_WEBHOOK_SECRET);
  (w.ok ? ok : bad)(w.text);
  if (k.ok) {
    const db = openDb();
    const { logApiCall } = makeHelpers(db);
    try {
      const stripe = createStripe({ onRequest: () => logApiCall('doctor') });
      await stripe.events.list({ limit: 1 });
      ok('Stripe API reachable with this key (events: read works)');
      await stripe.paymentIntents.list({ limit: 1 });
      ok('PaymentIntents can be listed (the poller will work)');
    } catch (err) {
      bad(`Stripe API call failed: ${err.type ?? ''} ${err.statusCode ?? ''} ${err.message}`);
    }
  }
}
