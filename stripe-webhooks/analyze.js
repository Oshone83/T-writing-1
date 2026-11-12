// analyze.js: turns the seen/payments/api_calls rows into the numbers in the article's table.
// Usage: node analyze.js [--csv delays.csv]
import { writeFileSync } from 'node:fs';
import { db } from './db.js';
import { summarize, perHour, seconds } from './stats.js';

const METHODS = ['poll', 'webhook'];

const rows = db.prepare(`
  SELECT s.id, s.method, p.created_ms, s.seen_ms, s.seen_ms - p.created_ms AS delay_ms
  FROM seen s JOIN payments p ON p.id = s.id
  WHERE s.method IN ('poll', 'webhook')
  ORDER BY p.created_ms
`).all();

const payments = db.prepare('SELECT id, created_ms FROM payments ORDER BY created_ms').all();
console.log(`Payments created: ${payments.length}\n`);

console.log('Delay, payment created → app knows (seconds)');
console.log('method    n     median   p95      worst    best');
const stats = {};
for (const m of METHODS) {
  const s = (stats[m] = summarize(rows.filter((r) => r.method === m).map((r) => r.delay_ms)));
  console.log(
    `${m.padEnd(9)} ${String(s.n).padEnd(5)} ${seconds(s.median).padEnd(8)} ${seconds(s.p95).padEnd(8)} ` +
    `${seconds(s.max).padEnd(8)} ${seconds(s.min)}`
  );
}
if (stats.poll.median && stats.webhook.median > 0) {
  console.log(`\nWebhook is ${(stats.poll.median / stats.webhook.median).toFixed(1)}× faster at the median.`);
}

const early = rows.filter((r) => r.delay_ms < 0);
if (early.length) {
  console.log(`\n${early.length} sighting(s) landed before the create call returned (negative delay):`);
  for (const r of early) console.log(`  ${r.method} ${r.id} ${seconds(r.delay_ms)} s`);
}

console.log('\nPayments a method never saw:');
let missing = 0;
for (const m of METHODS) {
  const seenIds = new Set(rows.filter((r) => r.method === m).map((r) => r.id));
  for (const p of payments) {
    if (!seenIds.has(p.id)) {
      missing++;
      console.log(`  ${m.padEnd(8)} ${p.id} (created ${new Date(p.created_ms).toISOString()})`);
    }
  }
}
if (!missing) console.log('  none');

const createdHours = new Set(payments.map((p) => Math.floor(p.created_ms / 3_600_000) * 3_600_000));
const calls = db.prepare("SELECT at_ms FROM api_calls WHERE source = 'poll'").all().map((r) => r.at_ms);
console.log('\nPoller API calls per clock hour (partial hours at either end count low):');
const hours = perHour(calls);
if (!hours.length) console.log('  none recorded');
for (const { hourStartMs, count } of hours) {
  const label = createdHours.has(hourStartMs) ? 'test payments created' : 'quiet';
  console.log(`  ${new Date(hourStartMs).toISOString().slice(0, 13)}:00Z  ${String(count).padStart(5)}  ${label}`);
}

const csvIdx = process.argv.indexOf('--csv');
if (csvIdx !== -1) {
  const file = process.argv[csvIdx + 1] ?? 'delays.csv';
  const lines = ['payment_id,method,created_ms,seen_ms,delay_ms', ...rows.map((r) =>
    [r.id, r.method, r.created_ms, r.seen_ms, r.delay_ms].join(','))];
  writeFileSync(file, lines.join('\n') + '\n');
  console.log(`\nWrote ${rows.length} rows to ${file}`);
}
