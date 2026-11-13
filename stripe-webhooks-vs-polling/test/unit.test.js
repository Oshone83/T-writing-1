// Small building blocks: statistics, the database helpers and the test-key guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { median, summarize } from '../lib/stats.js';
import { openDb, makeHelpers } from '../lib/db.js';
import { assertTestKey, assertWebhookSecret, createStripe } from '../lib/stripe-client.js';
import { paymentRows, delaySummary } from '../lib/report.js';
import { startEvery } from '../lib/loop.js';
import { setTimeout as sleep } from 'node:timers/promises';

test('median and summarize', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
  assert.deepEqual(summarize([2, 4, 9]), { n: 3, median: 4, min: 2, max: 9 });
});

test('markSeen records each (payment, method) once and keeps the first time', () => {
  const db = openDb(':memory:');
  const { markSeen } = makeHelpers(db);
  assert.equal(markSeen('pi_1', 'poll', 1).changes, 1);
  assert.equal(markSeen('pi_1', 'poll', 2).changes, 0);
  assert.equal(markSeen('pi_1', 'webhook', 3).changes, 1);
  assert.equal(db.prepare("SELECT seen_ms FROM seen WHERE id = 'pi_1' AND method = 'poll'").get().seen_ms, 1);
});

test('processEventOnce runs the work once per event ID, across sources', () => {
  const db = openDb(':memory:');
  const { processEventOnce } = makeHelpers(db);
  let runs = 0;
  assert.equal(processEventOnce('evt_1', 'webhook', () => runs++), true);
  assert.equal(processEventOnce('evt_1', 'reconcile', () => runs++), false);
  assert.equal(runs, 1);
});

test('if the work throws, the event ID is not recorded, so a retry can still succeed', () => {
  const db = openDb(':memory:');
  const { processEventOnce } = makeHelpers(db);
  assert.throws(() => processEventOnce('evt_2', 'webhook', () => { throw new Error('boom'); }), /boom/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM processed_events').get().n, 0);
  let ran = false;
  assert.equal(processEventOnce('evt_2', 'webhook', () => { ran = true; }), true);
  assert.ok(ran);
});

test('only test-mode keys and whsec_ secrets are accepted', () => {
  assert.throws(() => assertTestKey(undefined), /not set/);
  assert.throws(() => assertTestKey('sk_live_abc'), /TEST-mode/);
  assert.throws(() => createStripe({ key: 'rk_live_abc' }), /TEST-mode/);
  assert.doesNotThrow(() => assertTestKey('sk_test_abc'));
  assert.doesNotThrow(() => assertTestKey('rk_test_abc'));
  assert.throws(() => assertWebhookSecret('abc'), /whsec_/);
});

test('report: delays per method and payments a method never saw', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO payments VALUES ('pi_a', 1000, 'x'), ('pi_b', 2000, 'x')").run();
  db.prepare("INSERT INTO seen VALUES ('pi_a', 'poll', 4000), ('pi_a', 'webhook', 1050), ('pi_b', 'webhook', 2030), ('pi_c', 'webhook', 9000)").run();
  const rows = paymentRows(db, 'x');
  assert.deepEqual(rows.map((r) => r.id), ['pi_a', 'pi_b']);
  const s = delaySummary(rows);
  assert.equal(s.poll.max, 3000);
  assert.equal(s.webhook.median, 40);
  assert.deepEqual(s.missedByPoll, ['pi_b']);
  assert.equal(paymentRows(db).length, 3, 'without a phase, payments only seen (pi_c) are listed too');
});

test('startEvery runs immediately, then on schedule, and stops', async () => {
  let runs = 0;
  const stop = startEvery(100, async () => { runs++; });
  await sleep(250);
  await stop();
  const after = runs;
  await sleep(150);
  assert.ok(after >= 3 && after <= 4, `ran ${after} times`);
  assert.equal(runs, after, 'no runs after stop()');
});
