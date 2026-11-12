import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshDir, run } from './helpers.js';
import { median, percentile, summarize, perHour } from '../stats.js';

test('median and nearest-rank percentile', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
  const v = Array.from({ length: 20 }, (_, i) => i + 1);
  assert.equal(percentile(v, 95), 19);
  assert.equal(percentile(v, 100), 20);
  assert.equal(percentile([7], 95), 7);
  assert.deepEqual(summarize([5, 1, 9]), { n: 3, median: 5, p95: 9, max: 9, min: 1 });
  assert.deepEqual(perHour([0, 10, 3_600_000]), [{ hourStartMs: 0, count: 2 }, { hourStartMs: 3_600_000, count: 1 }]);
});

test('analyze.js and chart.js read the shared database', async (t) => {
  const { dir, db } = freshDir(t);
  const d = db();
  const t0 = Date.UTC(2026, 10, 10, 14, 0, 0);
  const pay = d.prepare('INSERT INTO payments VALUES (?, ?)');
  const seen = d.prepare('INSERT INTO seen VALUES (?, ?, ?)');
  [[1, 30_000, 1_200], [2, 10_000, -50], [3, 50_000, 900]].forEach(([n, pollDelay, hookDelay]) => {
    const created = t0 + n * 20_000;
    pay.run(`pi_${n}`, created);
    seen.run(`pi_${n}`, 'poll', created + pollDelay);
    seen.run(`pi_${n}`, 'webhook', created + hookDelay);
  });
  pay.run('pi_4', t0 + 100_000);
  seen.run('pi_4', 'poll', t0 + 120_000); // webhook never saw it
  const call = d.prepare("INSERT INTO api_calls VALUES ('poll', ?)");
  for (let i = 0; i < 60; i++) call.run(t0 - 3_600_000 + i * 60_000); // quiet hour
  for (let i = 0; i < 60; i++) call.run(t0 + i * 60_000);

  const out = await run('analyze.js', { cwd: dir, args: ['--csv', 'delays.csv'] });
  assert.match(out, /poll\s+4\s+25\.00\s+50\.00\s+50\.00\s+10\.00/);
  assert.match(out, /webhook\s+3\s+0\.90\s+1\.20\s+1\.20\s+-0\.05/);
  assert.match(out, /before the create call returned/);
  assert.match(out, /webhook\s+pi_4/);
  assert.match(out, /2026-11-10T13:00Z\s+60\s+quiet/);
  assert.match(out, /2026-11-10T14:00Z\s+60\s+test payments created/);
  assert.equal(readFileSync(join(dir, 'delays.csv'), 'utf8').trim().split('\n').length, 8);

  await run('chart.js', { cwd: dir });
  assert.ok(existsSync(join(dir, 'chart.html')));
  assert.match(readFileSync(join(dir, 'chart.html'), 'utf8'), /<svg class="chart"/);
});
