// Runs the whole demo (all five scenarios) with faster timings and requires every check to pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDemo } from '../demo.js';

test('demo: every scenario behaves as the article describes', { timeout: 60_000 }, async () => {
  const { checks } = await runDemo({
    log: () => {},
    timings: { pollEveryMs: 1000, retryDelaysMs: [300, 600, 900], payments: 5, minGapMs: 100, maxGapMs: 400, outageMs: 700 },
  });
  const failed = checks.filter((c) => !c.ok).map((c) => c.text);
  assert.deepEqual(failed, []);
  assert.equal(checks.length, 14);
});
