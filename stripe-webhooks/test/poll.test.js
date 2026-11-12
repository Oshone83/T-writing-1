import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDir, fakeStripe, run } from './helpers.js';

const now = Math.floor(Date.now() / 1000);
const pi = (id, created, status = 'succeeded') => ({ id, object: 'payment_intent', created, status });

test('records succeeded PaymentIntents, skips the rest, advances the cursor', async (t) => {
  const { dir, db } = freshDir(t);
  const api = await fakeStripe(t, { paymentIntents: [pi('pi_a', now - 120), pi('pi_b', now - 60), pi('pi_c', now - 30, 'requires_action')] });

  await run('poll.js', { cwd: dir, fakeStripe: api.url });
  const d = db();
  assert.deepEqual(d.prepare("SELECT id FROM seen WHERE method = 'poll' ORDER BY id").all().map((r) => r.id), ['pi_a', 'pi_b']);
  assert.equal(d.prepare("SELECT value FROM state WHERE key = 'poll_cursor'").get().value, String(now - 60));
  assert.equal(d.prepare('SELECT COUNT(*) n FROM api_calls').get().n, 1);
  assert.match(api.requests[0], /created\[gte\]=\d+/);

  // Second run: gte overlap re-lists pi_b, the primary key absorbs it.
  await run('poll.js', { cwd: dir, fakeStripe: api.url });
  assert.equal(d.prepare("SELECT COUNT(*) n FROM seen WHERE method = 'poll'").get().n, 2);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM api_calls').get().n, 2);
});

test('counts every page as an API call', async (t) => {
  const { dir, db } = freshDir(t);
  const many = Array.from({ length: 150 }, (_, i) => pi(`pi_${String(i).padStart(3, '0')}`, now - 1000 + i));
  const api = await fakeStripe(t, { paymentIntents: many });

  await run('poll.js', { cwd: dir, fakeStripe: api.url });
  const d = db();
  assert.equal(d.prepare("SELECT COUNT(*) n FROM seen WHERE method = 'poll'").get().n, 150);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM api_calls').get().n, 2);
});
