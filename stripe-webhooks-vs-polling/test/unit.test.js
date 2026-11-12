import { test } from 'node:test';
import assert from 'node:assert/strict';
import { percentile, median, summarize, countInversions, countCodeLines } from '../lib/stats.js';
import { openDb, makeHelpers } from '../lib/db.js';
import { assertTestKey, createStripe } from '../lib/stripe-client.js';

test('nearest-rank percentile returns a value that occurred', () => {
  const v = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
  assert.equal(percentile(v, 0.95), 95);
  assert.equal(percentile(v, 1), 100);
  assert.equal(percentile([5, 1, 3], 0.5), 3);
  assert.equal(percentile([], 0.5), null);
});

test('median handles odd, even and unsorted input', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
  assert.deepEqual(summarize([2, 4]).max, 4);
});

test('countInversions counts out-of-order pairs', () => {
  assert.equal(countInversions([0, 1, 2, 3]), 0);
  assert.equal(countInversions([1, 0, 2]), 1);
  assert.equal(countInversions([3, 2, 1, 0]), 6);
});

test('countCodeLines skips blanks and // comments', () => {
  assert.equal(countCodeLines('// c\n\nconst a = 1;\n  // x\nfoo();\n'), 2);
});

test('markSeen is idempotent per (payment, method)', () => {
  const db = openDb(':memory:');
  const { markSeen } = makeHelpers(db);
  assert.equal(markSeen('pi_1', 'poll', 1).changes, 1);
  assert.equal(markSeen('pi_1', 'poll', 2).changes, 0);
  assert.equal(markSeen('pi_1', 'webhook', 3).changes, 1);
  assert.equal(db.prepare("SELECT seen_ms FROM seen WHERE id='pi_1' AND method='poll'").get().seen_ms, 1);
});

test('processEventOnce runs work once per event ID', () => {
  const db = openDb(':memory:');
  const { processEventOnce } = makeHelpers(db);
  let runs = 0;
  assert.equal(processEventOnce('evt_1', 'webhook', () => runs++), true);
  assert.equal(processEventOnce('evt_1', 'reconcile', () => runs++), false);
  assert.equal(runs, 1);
});

test('processEventOnce does not remember an event whose work threw (retry can succeed)', () => {
  const db = openDb(':memory:');
  const { processEventOnce } = makeHelpers(db);
  assert.throws(() => processEventOnce('evt_2', 'webhook', () => { throw new Error('boom'); }), /boom/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM processed_events').get().n, 0);
  let ran = false;
  assert.equal(processEventOnce('evt_2', 'webhook', () => { ran = true; }), true);
  assert.ok(ran);
});

test('Stripe client refuses live and missing keys', () => {
  assert.throws(() => assertTestKey(undefined), /not set/);
  assert.throws(() => assertTestKey('sk_live_abc'), /TEST-mode/);
  assert.throws(() => createStripe({ key: 'rk_live_abc' }), /TEST-mode/);
  assert.doesNotThrow(() => assertTestKey('sk_test_abc'));
});
