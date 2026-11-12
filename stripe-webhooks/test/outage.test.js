import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDir, fakeStripe, run } from './helpers.js';

const t0 = Date.UTC(2026, 10, 10, 14, 0, 0);
const ev = (id, piId, ms) => ({
  id, object: 'event', type: 'payment_intent.succeeded', created: Math.floor(ms / 1000), pending_webhooks: 0,
  data: { object: { id: piId, object: 'payment_intent' } },
});

test('outage.js tabulates retried deliveries, order, and anything still missing', async (t) => {
  const { dir, db } = freshDir(t);
  const d = db();
  const api = await fakeStripe(t, {
    events: [ev('evt_a', 'pi_a', t0 + 60_000), ev('evt_b', 'pi_b', t0 + 120_000), ev('evt_c', 'pi_c', t0 + 180_000)],
  });
  d.prepare('INSERT INTO payments VALUES (?, ?)').run('pi_a', t0 + 60_000);
  d.prepare('INSERT INTO payments VALUES (?, ?)').run('pi_b', t0 + 120_000);
  d.prepare('INSERT INTO payments VALUES (?, ?)').run('pi_c', t0 + 180_000);
  d.prepare('INSERT INTO processed_events VALUES (?, ?)').run('evt_a', t0 + 1_500_000);
  d.prepare('INSERT INTO processed_events VALUES (?, ?)').run('evt_b', t0 + 1_400_000); // arrived before evt_a
  d.prepare('INSERT INTO seen VALUES (?, ?, ?)').run('pi_a', 'webhook', t0 + 1_500_000);

  const out = await run('outage.js', { cwd: dir, fakeStripe: api.url, args: [new Date(t0).toISOString(), new Date(t0 + 600_000).toISOString()] });
  assert.match(out, /3 payment\(s\) created/);
  assert.match(out, /evt_a\s+14:01:00.000\s+14:25:00.000\s+24 min 0 s/);
  assert.match(out, /Delivered in creation order: NO/);
  assert.match(out, /Not yet recorded by the app: 1/);
});

test('simulate-loss.js forgets the newest delivered event so reconcile.js recovers it', async (t) => {
  const { dir, db } = freshDir(t);
  const d = db();
  const now = Date.now();
  const api = await fakeStripe(t, { events: [ev('evt_old', 'pi_old', now - 60_000), ev('evt_new', 'pi_new', now - 10_000)] });
  for (const [e, p] of [['evt_old', 'pi_old'], ['evt_new', 'pi_new']]) {
    d.prepare('INSERT INTO processed_events VALUES (?, ?)').run(e, now);
    d.prepare('INSERT INTO seen VALUES (?, ?, ?)').run(p, 'webhook', now);
    d.prepare('INSERT INTO seen VALUES (?, ?, ?)').run(p, 'poll', now);
  }

  assert.match(await run('simulate-loss.js', { cwd: dir, fakeStripe: api.url }), /Forgot evt_new \(pi_new\): 1 processed_events row, 1 seen row/);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM seen WHERE id = 'pi_new' AND method = 'poll'").get().n, 1);
  const out = await run('reconcile.js', { cwd: dir, fakeStripe: api.url });
  assert.match(out, /recovered evt_new pi_new/);
  assert.match(out, /done, 1 recovered/);
});
