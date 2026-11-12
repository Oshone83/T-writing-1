import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDir, fakeStripe, run } from './helpers.js';

const now = Math.floor(Date.now() / 1000);
const ev = (id, piId, created) => ({
  id, object: 'event', type: 'payment_intent.succeeded', created,
  data: { object: { id: piId, object: 'payment_intent', status: 'succeeded' } },
});

test('recovers only events the receiver never recorded, and is idempotent', async (t) => {
  const { dir, db } = freshDir(t);
  const api = await fakeStripe(t, {
    events: [ev('evt_1', 'pi_1', now - 300), ev('evt_2', 'pi_2', now - 200), ev('evt_3', 'pi_3', now - 100),
      ev('evt_old', 'pi_old', now - 4 * 24 * 3600)], // outside the 3-day look-back
  });
  const d = db();
  d.prepare('INSERT INTO processed_events VALUES (?, ?)').run('evt_2', Date.now()); // the webhook already had it

  const out = await run('reconcile.js', { cwd: dir, fakeStripe: api.url });
  assert.match(out, /recovered evt_3 pi_3/);
  assert.match(out, /recovered evt_1 pi_1/);
  assert.match(out, /done, 2 recovered/);
  assert.deepEqual(d.prepare("SELECT id FROM seen WHERE method = 'reconcile' ORDER BY id").all().map((r) => r.id), ['pi_1', 'pi_3']);
  assert.match(api.requests[0], /type=payment_intent.succeeded/);

  assert.match(await run('reconcile.js', { cwd: dir, fakeStripe: api.url }), /done, 0 recovered/);
});
