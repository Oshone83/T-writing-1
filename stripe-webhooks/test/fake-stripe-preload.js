// Loaded with `node --import` in tests only: points the Stripe SDK at a local fake API
// (FAKE_STRIPE_URL) so poll.js and reconcile.js run unchanged without a real key or network.
import Stripe from 'stripe';

const url = new URL(process.env.FAKE_STRIPE_URL);
const original = Stripe.prototype.getApiField;
Stripe.prototype.getApiField = function (key) {
  if (key === 'host') return url.hostname;
  if (key === 'port') return url.port;
  if (key === 'protocol') return url.protocol.replace(':', '');
  return original.call(this, key);
};
