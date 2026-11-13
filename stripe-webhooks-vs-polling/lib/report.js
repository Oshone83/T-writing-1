// lib/report.js — turns the database into the numbers the demo and `npm run report` print.
// Delay = when a method recorded the payment (seen_ms) − when the payment succeeded (created_ms).
import { summarize } from './stats.js';

// One row per payment the app knows about, with when each method found it (null = never).
export function paymentRows(db, phase) {
  return db.prepare(`
    WITH ids AS (SELECT id FROM payments UNION SELECT id FROM seen)
    SELECT ids.id, p.phase, p.created_ms,
      (SELECT seen_ms FROM seen WHERE id = ids.id AND method = 'poll') AS poll_ms,
      (SELECT seen_ms FROM seen WHERE id = ids.id AND method = 'webhook') AS webhook_ms,
      (SELECT seen_ms FROM seen WHERE id = ids.id AND method = 'reconcile') AS reconcile_ms
    FROM ids LEFT JOIN payments p ON p.id = ids.id
    WHERE (? IS NULL OR p.phase = ?)
    ORDER BY COALESCE(p.created_ms, 0), ids.id`).all(phase ?? null, phase ?? null);
}

export function delaySummary(rows) {
  const delays = (key) => rows.filter((r) => r.created_ms != null && r[key] != null).map((r) => r[key] - r.created_ms);
  return {
    payments: rows.length,
    poll: summarize(delays('poll_ms')),
    webhook: summarize(delays('webhook_ms')),
    reconcile: summarize(delays('reconcile_ms')),
    missedByPoll: rows.filter((r) => r.poll_ms == null).map((r) => r.id),
    missedByWebhook: rows.filter((r) => r.webhook_ms == null).map((r) => r.id),
  };
}

export const apiCallCounts = (db) =>
  Object.fromEntries(db.prepare('SELECT source, COUNT(*) n FROM api_calls GROUP BY source').all().map((r) => [r.source, r.n]));

export const deliveryCounts = (db) =>
  db.prepare('SELECT COUNT(*) total, COALESCE(SUM(duplicate), 0) duplicates, COUNT(DISTINCT event_id) events FROM deliveries').get();

const sec = (ms) => (ms == null ? '-' : `${(ms / 1000).toFixed(2)} s`);

export function formatReport(db, phase) {
  const rows = paymentRows(db, phase);
  const s = delaySummary(rows);
  const lines = [`Payments${phase ? ` (phase ${phase})` : ''}: ${rows.length}`, ''];
  lines.push('payment              poll delay   webhook delay   reconcile delay');
  for (const r of rows) {
    const d = (k) => (r[k] == null ? 'never' : r.created_ms == null ? 'yes' : sec(r[k] - r.created_ms));
    lines.push(`${r.id.padEnd(20)} ${d('poll_ms').padStart(10)}   ${d('webhook_ms').padStart(13)}   ${d('reconcile_ms').padStart(15)}`);
  }
  if (rows.some((r) => r.created_ms == null)) {
    lines.push('("yes" = found, but no start time was recorded, e.g. a 3-D Secure payment that succeeded later)');
  }
  lines.push('', `median delay   poll ${sec(s.poll.median)}   webhook ${sec(s.webhook.median)}`);
  lines.push(`max delay      poll ${sec(s.poll.max)}   webhook ${sec(s.webhook.max)}`);
  const calls = apiCallCounts(db);
  lines.push(`API requests   ${Object.entries(calls).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
  const d = deliveryCounts(db);
  lines.push(`webhook deliveries ${d.total} for ${d.events} event(s), ${d.duplicates} duplicate(s) ignored`);
  return lines.join('\n');
}
