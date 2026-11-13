// analyze.js — turns payments.db into the article's numbers, raw-timestamp CSVs and a chart.
//
//   node analyze.js                      writes results/summary.md, article-values.md, summary.json,
//                                        delays.csv, outage.csv, lost-event.csv, api-calls-by-hour.csv,
//                                        delay-chart.svg and (after a real delivery) raw-request.txt
//   node analyze.js --quiet-from 2026-11-20T09:00:00Z --quiet-to 2026-11-20T10:00:00Z
//   node analyze.js --out some/dir --label "SIMULATED"
//
// Definitions (same for both methods):
//   created_ms  Date.now() right after the create call returned a succeeded PaymentIntent
//   seen_ms     Date.now() when the poller / receiver wrote the payment ID to SQLite ("app knows")
//   delay       seen_ms - created_ms. Percentiles are nearest-rank (always a delay that happened).
// All times are UTC.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { isMain, PROJECT_DIR, DATA_DIR } from './lib/env.js';
import { renderArticleValues, SCREENSHOTS } from './lib/article.js';
import { findGenuine, formatSample } from './scripts/sample-request.js';
import { openDb } from './lib/db.js';
import { summarize, countInversions, countCodeLines } from './lib/stats.js';

const HOUR = 3600_000;
const iso = (ms) => (ms == null ? '' : new Date(ms).toISOString());
const sec = (ms) => (ms == null ? null : Math.round(ms) / 1000);
const fmt = (ms, d = 1) => (ms == null ? 'n/a' : (ms / 1000).toFixed(d));

export const MANUAL_ATTEMPTS_FILE = path.join('manual', 'dashboard-delivery-attempts.csv');

// Minimal CSV reader for the hand-filled Dashboard file: skips blank lines and lines starting with #.
export function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
  if (!lines.length) return [];
  const split = (line) => {
    const out = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"') q = true; else if (c === ',') { out.push(cur.trim()); cur = ''; } else cur += c;
    }
    out.push(cur.trim());
    return out;
  };
  const head = split(lines[0]);
  return lines.slice(1).map((l) => Object.fromEntries(split(l).map((v, i) => [head[i], v])));
}

export function analyze(db, { codeFiles = {}, quietFrom, quietTo, manualAttemptsCsv } = {}) {
  // ---------- side-by-side delays: the article's core query ----------
  const rows = db.prepare(`
    SELECT p.id, p.created_ms, p.stripe_created_s, s.method, s.seen_ms, s.seen_ms - p.created_ms AS delay_ms
    FROM payments p LEFT JOIN seen s ON p.id = s.id AND s.method IN ('poll', 'webhook')
    WHERE p.phase = 'side-by-side'
    ORDER BY p.created_ms`).all();
  const firstArrival = db.prepare(
    "SELECT MIN(received_ms) t FROM deliveries WHERE payment_id = ? AND event_type = 'payment_intent.succeeded'");

  const perPayment = new Map();
  for (const r of rows) {
    if (!perPayment.has(r.id)) {
      perPayment.set(r.id, { id: r.id, created_ms: r.created_ms, stripe_created_s: r.stripe_created_s, webhook_arrival_ms: firstArrival.get(r.id).t });
    }
    if (r.method) perPayment.get(r.id)[r.method] = { seen_ms: r.seen_ms, delay_ms: r.delay_ms };
  }
  const payments = [...perPayment.values()];
  const delays = (m) => payments.filter((p) => p[m]).map((p) => p[m].delay_ms);
  const poll = summarize(delays('poll'));
  const webhook = summarize(delays('webhook'));
  const missedBy = (m) => payments.filter((p) => !p[m]).map((p) => p.id);
  const webhookBeforeCreateReturned = payments.filter((p) => p.webhook && p.webhook.delay_ms < 0).map((p) => p.id);
  // Arrival-to-write time inside the receiver: shows the timestamp change (C6) costs milliseconds.
  const receiverWriteLag = summarize(payments.filter((p) => p.webhook && p.webhook_arrival_ms != null)
    .map((p) => p.webhook.seen_ms - p.webhook_arrival_ms));

  const window = payments.length ? { start_ms: payments[0].created_ms, end_ms: payments.at(-1).created_ms } : null;
  const arrival = payments.filter((p) => p.webhook).sort((a, b) => a.webhook.seen_ms - b.webhook.seen_ms);
  const createdRank = new Map(payments.map((p, i) => [p.id, i]));
  const sideBySideInversions = countInversions(arrival.map((p) => createdRank.get(p.id)));

  // ---------- API calls ----------
  const totals = Object.fromEntries(
    db.prepare('SELECT source, COUNT(*) n FROM api_calls GROUP BY source').all().map((r) => [r.source, r.n]));
  const pollCalls = db.prepare("SELECT at_ms FROM api_calls WHERE source = 'poll' ORDER BY at_ms").all().map((r) => r.at_ms);
  const allPayments = db.prepare('SELECT created_ms, phase FROM payments').all();
  const paymentsIn = (from, to) => allPayments.filter((p) => p.created_ms >= from && p.created_ms < to).length;
  const callsIn = (from, to) => pollCalls.filter((t) => t >= from && t < to).length;

  // Quiet window: explicit, or by default the 60 minutes right before the first side-by-side payment.
  let quiet = null;
  const qFrom = quietFrom ? Date.parse(quietFrom) : window ? window.start_ms - HOUR : null;
  const qTo = quietTo ? Date.parse(quietTo) : window ? window.start_ms : null;
  if (qFrom != null && qTo != null) {
    if (!(qTo > qFrom)) throw new Error('--quiet-to must be after --quiet-from');
    const problems = [];
    if (!pollCalls.length || pollCalls[0] > qFrom + 60_000) problems.push(`the poller was not running at the window start (first poll call ${iso(pollCalls[0]) || 'never'})`);
    if (!pollCalls.length || pollCalls.at(-1) < qTo - 60_000) problems.push('the poller stopped before the window end');
    const pin = paymentsIn(qFrom, qTo);
    if (pin) problems.push(`${pin} payment(s) were created inside the window`);
    const calls = callsIn(qFrom, qTo);
    quiet = {
      from: iso(qFrom), to: iso(qTo), source: quietFrom ? 'explicit --quiet-from/--quiet-to' : '60 min before the first side-by-side payment',
      minutes: (qTo - qFrom) / 60000, calls, per_hour: calls / ((qTo - qFrom) / HOUR), valid: problems.length === 0, problems,
    };
  }

  let duringTest = null;
  if (window) {
    const firstHour = callsIn(window.start_ms, window.start_ms + HOUR);
    const span = window.end_ms - window.start_ms;
    const n = pollCalls.filter((t) => t >= window.start_ms && t <= window.end_ms).length;
    duringTest = {
      first_hour_calls: firstHour, first_hour_complete: (pollCalls.at(-1) ?? 0) >= window.start_ms + HOUR - 60_000,
      window_calls: n, window_minutes: span / 60000, window_per_hour: span > 0 ? n / (span / HOUR) : null,
    };
  }

  // The interval the poller actually ran at (gaps under 2 s are extra pages/retries within one run).
  const runGaps = pollCalls.slice(1).map((t, i) => t - pollCalls[i]).filter((g) => g > 2000);
  const pollInterval = { ...summarize(runGaps), runs: runGaps.length + (pollCalls.length ? 1 : 0) };

  // Per UTC clock hour, for the CSV.
  const byHour = new Map();
  for (const t of pollCalls) { const h = Math.floor(t / HOUR) * HOUR; byHour.set(h, (byHour.get(h) ?? 0) + 1); }
  const hourRows = [...byHour.keys()].sort((a, b) => a - b).map((h, i, all) => ({
    hour_start_utc: iso(h), poll_calls: byHour.get(h), payments_created: paymentsIn(h, h + HOUR),
    full_hour: i > 0 && i < all.length - 1,
  }));

  // ---------- webhook deliveries ----------
  const deliveryTotals = db.prepare(
    'SELECT COUNT(*) total, COALESCE(SUM(duplicate), 0) duplicates, COUNT(DISTINCT event_id) distinct_events FROM deliveries').get();
  // Stripe: "In some cases, two separate Event objects are generated and sent." Event-ID dedupe can't
  // catch those; the per-payment seen table does. Count them so they're visible.
  const samePaymentMultipleEvents = db.prepare(`
    SELECT payment_id, COUNT(DISTINCT event_id) events FROM deliveries
    WHERE event_type = 'payment_intent.succeeded' GROUP BY payment_id HAVING events > 1`).all();
  // constructEvent rejects t= older than 300 s, so a delivery arriving > 300 s after the event was
  // created can only have passed with a fresh signature.
  const lateDeliveries = db.prepare(`
    SELECT COUNT(*) n, MIN(signature_t - event_created_s) min_age_s, MAX(signature_t - event_created_s) max_age_s
    FROM deliveries WHERE received_ms / 1000 - event_created_s > 300`).get();

  // ---------- Dashboard attempts (hand-copied) and Stripe's pending snapshots ----------
  const manualRows = manualAttemptsCsv ? parseCsv(manualAttemptsCsv) : [];
  const isFailure = (r) => !/^2\d\d$/.test(r.result ?? '');
  const manualByEvent = new Map();
  for (const r of manualRows) {
    if (!manualByEvent.has(r.event_id)) manualByEvent.set(r.event_id, []);
    manualByEvent.get(r.event_id).push(r);
  }
  const snapshots = db.prepare('SELECT snapshot_ms, event_id, payment_id, pending_webhooks FROM pending_snapshots ORDER BY snapshot_ms').all();
  const snapshotRuns = snapshots.filter((s) => s.event_id == null);
  const pendingByEvent = new Map();
  for (const s of snapshots.filter((x) => x.event_id)) {
    const e = pendingByEvent.get(s.event_id) ?? { first_ms: s.snapshot_ms, last_ms: s.snapshot_ms, count: 0 };
    e.last_ms = s.snapshot_ms; e.count++;
    pendingByEvent.set(s.event_id, e);
  }

  // ---------- outage phase ----------
  const runs = db.prepare('SELECT started_ms, stopped_ms FROM receiver_runs ORDER BY started_ms').all();
  const outages = [];
  for (let i = 0; i < runs.length - 1; i++) {
    const down = runs[i].stopped_ms;
    const up = runs[i + 1].started_ms;
    outages.push(down
      ? { down_at: iso(down), up_at: iso(up), minutes: (up - down) / 60000 }
      : { down_at: '(unknown: receiver killed without Ctrl+C/SIGTERM)', up_at: iso(up), minutes: null });
  }

  const deliveriesFor = db.prepare(`
    SELECT event_id, received_ms, signature_t, event_created_s, duplicate FROM deliveries
    WHERE payment_id = ? AND event_type = 'payment_intent.succeeded' ORDER BY received_ms`);
  const seenBy = db.prepare('SELECT method, seen_ms FROM seen WHERE id = ? ORDER BY seen_ms');
  const outageRows = db.prepare("SELECT id, created_ms FROM payments WHERE phase = 'outage' ORDER BY created_ms").all().map((p) => {
    const d = deliveriesFor.all(p.id);
    const first = seenBy.all(p.id)[0];
    const eventId = d[0]?.event_id ?? '';
    const manual = manualByEvent.get(eventId) ?? [];
    const pend = pendingByEvent.get(eventId);
    return {
      payment_id: p.id,
      event_id: eventId,
      payment_created: iso(p.created_ms),
      dashboard_failed_attempts: manual.filter(isFailure).length,
      dashboard_failed_attempt_times: manual.filter(isFailure).map((r) => `${r.attempted_at_utc} ${r.result}`).join('; '),
      stripe_reported_pending_first: iso(pend?.first_ms),
      stripe_reported_pending_last: iso(pend?.last_ms),
      first_webhook_delivery: iso(d[0]?.received_ms),
      webhook_delivery_delay_s: d[0] ? sec(d[0].received_ms - p.created_ms) : null,
      webhook_deliveries: d.length,
      duplicate_deliveries: d.filter((x) => x.duplicate).length,
      signature_t_minus_event_created_s: d.map((x) => x.signature_t - x.event_created_s).join(' '),
      app_knew_via: first?.method ?? 'NEVER',
      app_knew_at: iso(first?.seen_ms),
      total_delay_s: first ? sec(first.seen_ms - p.created_ms) : null,
    };
  });
  // The planned outage: the receiver down window during which the first outage payment was created.
  const firstOutageMs = outageRows.length ? Date.parse(outageRows[0].payment_created) : null;
  const planned = firstOutageMs == null ? null : outages.find((w) =>
    w.minutes != null && Date.parse(w.down_at) <= firstOutageMs && Date.parse(w.up_at) >= firstOutageMs) ?? null;
  const delivered = outageRows.filter((r) => r.first_webhook_delivery);
  const outageArrival = [...delivered].sort((a, b) => a.first_webhook_delivery.localeCompare(b.first_webhook_delivery));
  const outageRank = new Map(outageRows.map((r, i) => [r.payment_id, i]));
  const outageInversions = countInversions(outageArrival.map((r) => outageRank.get(r.payment_id)));

  // ---------- lost-event demonstration (its own payments; never the measured ones) ----------
  const reconcileSeen = db.prepare("SELECT seen_ms FROM seen WHERE id = ? AND method = 'reconcile'");
  const lostRows = db.prepare(`
    SELECT l.event_id, l.payment_id, l.forgotten_ms, p.phase FROM simulated_losses l
    LEFT JOIN payments p ON p.id = l.payment_id ORDER BY l.forgotten_ms`).all().map((l) => {
    const rec = reconcileSeen.get(l.payment_id);
    return {
      event_id: l.event_id, payment_id: l.payment_id, phase: l.phase,
      delivered_by_webhook_at: iso(deliveriesFor.all(l.payment_id)[0]?.received_ms),
      forgotten_at: iso(l.forgotten_ms), recovered_by_reconcile_at: iso(rec?.seen_ms), recovered: !!rec,
    };
  });

  // ---------- reconciliation ----------
  const reconcileEvents = db.prepare("SELECT COUNT(*) n FROM processed_events WHERE source = 'reconcile'").get().n;
  const reconcilePayments = db.prepare(`
    SELECT s.id payment_id, s.seen_ms, p.phase FROM seen s LEFT JOIN payments p ON p.id = s.id
    WHERE s.method = 'reconcile' ORDER BY s.seen_ms`).all().map((r) => ({ ...r, seen_at: iso(r.seen_ms) }));

  const phases = Object.fromEntries(db.prepare('SELECT phase, COUNT(*) n FROM payments GROUP BY phase').all().map((r) => [r.phase, r.n]));
  const code = Object.fromEntries(Object.entries(codeFiles).map(([name, src]) => [name, countCodeLines(src)]));

  return {
    phases,
    sideBySide: {
      payments: payments.length,
      window: window && { start: iso(window.start_ms), end: iso(window.end_ms) },
      poll, webhook, receiverWriteLag,
      missedByPoll: missedBy('poll'), missedByWebhook: missedBy('webhook'),
      webhookBeforeCreateReturned, webhookArrivalInversions: sideBySideInversions,
      perPayment: payments,
    },
    apiCalls: { totals, quiet, duringTest, pollInterval, byHour: hourRows },
    deliveries: { ...deliveryTotals, samePaymentMultipleEvents, lateDeliveries },
    dashboard: {
      file_rows: manualRows.length,
      failed_attempts: manualRows.filter(isFailure).length,
      events: manualByEvent.size,
    },
    pendingSnapshots: { runs: snapshotRuns.length, max_pending: Math.max(0, ...snapshotRuns.map((s) => s.pending_webhooks)), first: iso(snapshotRuns[0]?.snapshot_ms), last: iso(snapshotRuns.at(-1)?.snapshot_ms) },
    outage: {
      windows: outages, planned, payments: outageRows,
      allEventuallyKnown: outageRows.every((r) => r.app_knew_via !== 'NEVER'),
      allDeliveredByWebhook: outageRows.every((r) => r.first_webhook_delivery),
      arrivedInCreationOrder: outageInversions === 0, arrivalInversions: outageInversions,
    },
    lostEvent: lostRows,
    reconcile: { events_recovered: reconcileEvents, payments: reconcilePayments },
    code,
  };
}

// ---------- outputs ----------

const csv = (rows) => {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v));
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
};

export function renderChart(perPayment, { label = '' } = {}) {
  const W = 900, H = 440, m = { l: 64, r: 24, t: 72, b: 56 };
  const pts = perPayment.flatMap((p) => ['poll', 'webhook'].filter((k) => p[k]).map((k) => ({
    method: k, id: p.id, x: p.created_ms, y: p[k].delay_ms / 1000,
  })));
  const x0 = Math.min(...perPayment.map((p) => p.created_ms));
  const xMax = Math.max(1, (Math.max(...perPayment.map((p) => p.created_ms)) - x0) / 60000);
  const yMaxRaw = Math.max(1, ...pts.map((p) => p.y));
  const yStep = yMaxRaw > 40 ? 10 : yMaxRaw > 10 ? 5 : 1;
  const yMax = Math.ceil(yMaxRaw / yStep) * yStep;
  const yMin = Math.min(0, Math.floor(Math.min(...pts.map((p) => p.y))));
  const sx = (t) => m.l + ((t - x0) / 60000 / xMax) * (W - m.l - m.r);
  const sy = (v) => H - m.b - ((v - yMin) / (yMax - yMin)) * (H - m.t - m.b);

  const xStep = xMax > 60 ? 10 : xMax > 20 ? 5 : xMax > 5 ? 1 : 0.5;
  const xt = []; for (let v = 0; v <= xMax + 1e-9; v += xStep) xt.push(v);
  const yt = []; for (let v = yMin; v <= yMax + 1e-9; v += yStep) yt.push(v);

  const dot = (p) => {
    const cx = sx(p.x).toFixed(1), cy = sy(p.y).toFixed(1);
    const tip = `<title>${p.method === 'poll' ? 'Polling' : 'Webhook'} · ${p.id}\ncreated ${iso(p.x)}\ndelay ${p.y.toFixed(2)} s</title>`;
    return p.method === 'poll'
      ? `<circle class="poll" cx="${cx}" cy="${cy}" r="4.5">${tip}</circle>`
      : `<rect class="webhook" x="${(cx - 4).toFixed(1)}" y="${(cy - 4).toFixed(1)}" width="8" height="8" rx="1.5">${tip}</rect>`;
  };

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="system-ui, -apple-system, Segoe UI, sans-serif" role="img" aria-labelledby="t d">
<title id="t">Delay from payment created to app knows, per payment</title>
<desc id="d">One mark per payment and method. Circles: polling every 60 s. Squares: webhook.</desc>
<style>
  svg { --surface:#fcfcfb; --ink:#0b0b0b; --ink2:#52514e; --grid:#e4e3df; --poll:#2a78d6; --webhook:#eb6834; }
  @media (prefers-color-scheme: dark) { svg { --surface:#1a1a19; --ink:#f0efec; --ink2:#c3c2b7; --grid:#3a3936; --poll:#3987e5; --webhook:#d95926; } }
  .bg { fill: var(--surface); } .title { fill: var(--ink); font-size: 17px; font-weight: 600; }
  .sub, .tick, .axis-label, .legend { fill: var(--ink2); font-size: 12px; }
  .grid { stroke: var(--grid); stroke-width: 1; } .zero { stroke: var(--ink2); stroke-width: 1; }
  .poll { fill: var(--poll); stroke: var(--surface); stroke-width: 2; }
  .webhook { fill: var(--webhook); stroke: var(--surface); stroke-width: 2; }
  circle:hover, rect:hover { stroke: var(--ink); }
</style>
<rect class="bg" width="${W}" height="${H}"/>
<text class="title" x="${m.l}" y="28">Delay from payment created to app knows, per payment</text>
<text class="sub" x="${m.l}" y="48">${perPayment.length} payments · delay = app knows − create call returned${label ? ' · ' + label : ''}</text>
<g transform="translate(${W - m.r - 230}, 40)">
  <circle class="poll" cx="6" cy="0" r="4.5"/><text class="legend" x="16" y="4">Polling</text>
  <rect class="webhook" x="80" y="-4" width="8" height="8" rx="1.5"/><text class="legend" x="94" y="4">Webhook</text>
</g>
${yt.map((v) => `<line class="${v === 0 ? 'zero' : 'grid'}" x1="${m.l}" x2="${W - m.r}" y1="${sy(v).toFixed(1)}" y2="${sy(v).toFixed(1)}"/><text class="tick" x="${m.l - 8}" y="${(sy(v) + 4).toFixed(1)}" text-anchor="end">${v}</text>`).join('\n')}
${xt.map((v) => `<text class="tick" x="${sx(x0 + v * 60000).toFixed(1)}" y="${H - m.b + 18}" text-anchor="middle">${v}</text>`).join('\n')}
<text class="axis-label" x="${(m.l + W - m.r) / 2}" y="${H - 14}" text-anchor="middle">Minutes since the first payment was created</text>
<text class="axis-label" transform="translate(18 ${(m.t + H - m.b) / 2}) rotate(-90)" text-anchor="middle">Delay (s)</text>
${pts.filter((p) => p.method === 'poll').map(dot).join('\n')}
${pts.filter((p) => p.method === 'webhook').map(dot).join('\n')}
</svg>
`;
}

export function renderSummary(r, { label = '', versions = {}, dbName = 'payments.db' } = {}) {
  const s = r.sideBySide;
  const a = r.apiCalls;
  const q = a.quiet;
  const quietCell = !q ? 'n/a (no side-by-side payments yet, and no --quiet-from/--quiet-to)'
    : q.valid ? `${q.per_hour.toFixed(1)} (${q.calls} calls, ${q.from} → ${q.to})`
    : `NOT VALID: ${q.problems.join('; ')} (${q.calls} calls in ${q.from} → ${q.to})`;
  const dt = a.duringTest;
  const duringCell = !dt ? 'n/a'
    : `${dt.first_hour_calls} in the 60 min from the first payment${dt.first_hour_complete ? '' : ' (INCOMPLETE: poller stopped before the hour ended)'}`;
  const ratio = s.poll.median != null && s.webhook.median > 0 ? (s.poll.median / s.webhook.median).toFixed(1) : 'n/a';
  const t = a.totals;
  const o = r.outage;
  const yesNo = (v, empty) => (empty ? 'n/a' : v ? 'yes' : 'NO');

  const outageTable = o.payments.length
    ? ['| Event | Payment created | Failed attempts (Dashboard) | First webhook delivery | Webhook delay | App knew via | Total delay |',
       '|---|---|---|---|---|---|---|',
       ...o.payments.map((p) => `| ${p.event_id || '(none)'} | ${p.payment_created} | ${r.dashboard.file_rows ? p.dashboard_failed_attempts + (p.dashboard_failed_attempt_times ? ` (${p.dashboard_failed_attempt_times})` : '') : 'not recorded'} | ${p.first_webhook_delivery || '-'} | ${p.webhook_delivery_delay_s == null ? '-' : p.webhook_delivery_delay_s.toFixed(1) + ' s'} | ${p.app_knew_via} | ${p.total_delay_s == null ? '-' : p.total_delay_s.toFixed(1) + ' s'} |`)].join('\n')
    : '_No outage-phase payments recorded yet._';

  const lostTable = r.lostEvent.length
    ? ['| Event | Payment | Delivered by webhook at | Forgotten at | Recovered by reconcile at |', '|---|---|---|---|---|',
       ...r.lostEvent.map((l) => `| ${l.event_id} | ${l.payment_id} | ${l.delivered_by_webhook_at || '-'} | ${l.forgotten_at} | ${l.recovered_by_reconcile_at || 'NOT YET'} |`)].join('\n')
    : '_No lost-event demonstration recorded yet._';

  return `${label ? `> **${label}**\n\n` : ''}# Results

Generated ${new Date().toISOString()} from ${dbName}. All times UTC. Delay = the moment the poller or
receiver wrote the payment ID to SQLite − the moment the create call returned (same machine clock).
Percentiles are nearest-rank. Payments by phase: ${Object.entries(r.phases).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}.

## At a glance (side-by-side phase)

| | Polling (every 60 s in the real run) | Webhook |
|---|---|---|
| Payments measured | ${s.poll.n} of ${s.payments} | ${s.webhook.n} of ${s.payments} |
| Median delay | ${fmt(s.poll.median)} s | ${fmt(s.webhook.median, 2)} s |
| 95th percentile delay | ${fmt(s.poll.p95)} s | ${fmt(s.webhook.p95, 2)} s |
| Worst delay | ${fmt(s.poll.max)} s | ${fmt(s.webhook.max, 2)} s |
| Best delay | ${fmt(s.poll.min)} s | ${fmt(s.webhook.min, 2)} s |
| Stripe API calls / hour, quiet hour | ${quietCell} | 0 |
| Stripe API calls / hour, during the test | ${duringCell} | 0 |
| Code lines (non-blank, non-comment) | ${r.code['poll.js'] ?? 'n/a'} (poll.js) | ${r.code['receiver.js'] ?? 'n/a'} (receiver.js) |

Median ratio, polling / webhook: **${ratio}×**. Test window: ${s.window ? `${s.window.start} → ${s.window.end}` : 'n/a'}.

- Payments the poller never saw: ${s.missedByPoll.length ? s.missedByPoll.join(', ') : 'none'}
- Payments the webhook never delivered: ${s.missedByWebhook.length ? s.missedByWebhook.join(', ') : 'none'}
- Webhooks written before the create call returned (negative delay): ${s.webhookBeforeCreateReturned.length}${s.webhookBeforeCreateReturned.length ? ` (${s.webhookBeforeCreateReturned.join(', ')})` : ''}
- Webhook arrival-order inversions vs creation order: ${s.webhookArrivalInversions}
- Receiver time from request arrival to SQLite write: median ${fmt(s.receiverWriteLag.median, 3)} s, worst ${fmt(s.receiverWriteLag.max, 3)} s
- Poll interval actually used: ${a.pollInterval.median == null ? 'n/a' : `median ${fmt(a.pollInterval.median)} s over ${a.pollInterval.runs} runs`}${a.pollInterval.median != null && Math.abs(a.pollInterval.median - 60_000) > 5_000 ? ' (NOT the experiment\'s 60 s)' : ''}

## Stripe API requests (every HTTP attempt, list pages and SDK retries included)

| Source | Requests |
|---|---|
| poll.js, total | ${t.poll ?? 0} |
| poll.js, during the side-by-side payment window | ${dt ? `${dt.window_calls} in ${dt.window_minutes.toFixed(1)} min` : 'n/a'} |
| reconcile.js, total | ${t.reconcile ?? 0} |
| snapshot-pending.js, total | ${t.snapshot ?? 0} |
| create-payments.js, total | ${t.create ?? 0} |

Per-UTC-hour poll counts are in api-calls-by-hour.csv.

## Webhook deliveries (all phases)

- Signed deliveries received: ${r.deliveries.total} for ${r.deliveries.distinct_events} distinct events
- Same event ID delivered again (turned into a no-op by the event-ID table): ${r.deliveries.duplicates}
- Same payment delivered under two different event IDs (absorbed by the per-payment seen table): ${r.deliveries.samePaymentMultipleEvents.length}${r.deliveries.samePaymentMultipleEvents.length ? ` (${r.deliveries.samePaymentMultipleEvents.map((x) => x.payment_id).join(', ')})` : ''}
- Deliveries that arrived more than 300 s after the event was created: ${r.deliveries.lateDeliveries.n}${r.deliveries.lateDeliveries.n ? `. All passed constructEvent's 300 s tolerance, so each carried a fresh signature; their \`t=\` was ${r.deliveries.lateDeliveries.min_age_s}–${r.deliveries.lateDeliveries.max_age_s} s after the event's \`created\`` : ''}
- Failed delivery attempts copied from the Dashboard (${MANUAL_ATTEMPTS_FILE}): ${r.dashboard.file_rows ? `${r.dashboard.failed_attempts} failed of ${r.dashboard.file_rows} recorded, for ${r.dashboard.events} event(s)` : 'none recorded (the receiver cannot see attempts that never reached it)'}
- Stripe's own pending view (snapshot-pending.js): ${r.pendingSnapshots.runs ? `${r.pendingSnapshots.runs} snapshots ${r.pendingSnapshots.first} → ${r.pendingSnapshots.last}, at most ${r.pendingSnapshots.max_pending} event(s) undelivered at once` : 'no snapshots taken'}

## Outage

Receiver down windows (from receiver_runs; ignore any that weren't the planned outage):
${o.windows.length ? o.windows.map((w) => `- down ${w.down_at} → up ${w.up_at}${w.minutes == null ? '' : ` (${w.minutes.toFixed(1)} min)`}`).join('\n') : '- none recorded'}

${outageTable}

- Every outage payment was eventually delivered by a webhook retry: **${yesNo(o.allDeliveredByWebhook, !o.payments.length)}**
- Every outage payment eventually reached the app (any path): **${yesNo(o.allEventuallyKnown, !o.payments.length)}**
- Retried events arrived in creation order: ${!o.payments.length ? 'n/a' : o.arrivedInCreationOrder ? 'yes' : `no (${o.arrivalInversions} inversions)`}

## Reconciliation

- Events recovered by reconcile.js (all runs): ${r.reconcile.events_recovered}
- Payments whose first record came from reconcile: ${r.reconcile.payments.length ? r.reconcile.payments.map((p) => `${p.payment_id} (${p.phase ?? 'not an experiment payment'}, ${p.seen_at})`).join(', ') : 'none'}

### Lost-event demonstration (dedicated payment, separate from the measurements above)

${lostTable}

## Versions

${Object.entries(versions).map(([k, v]) => `- ${k} ${v}`).join('\n')}

Files: article-values.md (every article placeholder), delays.csv (raw per-payment timestamps), outage.csv, lost-event.csv, api-calls-by-hour.csv, delay-chart.svg, summary.json, raw-request.txt (after a real delivery).
`;
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      out: { type: 'string', default: path.join(DATA_DIR, 'results') },
      label: { type: 'string', default: '' },
      'quiet-from': { type: 'string' },
      'quiet-to': { type: 'string' },
      'manual-attempts': { type: 'string', default: path.join(DATA_DIR, MANUAL_ATTEMPTS_FILE) },
      'tunnel-tool': { type: 'string' },
    },
  });
  if (!!values['quiet-from'] !== !!values['quiet-to']) throw new Error('give both --quiet-from and --quiet-to, or neither');
  const db = openDb();
  const read = (f) => fs.readFileSync(path.join(PROJECT_DIR, f), 'utf8');

  // Never let simulated data into the real results folder: fake Stripe IDs contain "_fake".
  const fakeIds = db.prepare("SELECT COUNT(*) n FROM payments WHERE id LIKE '%\\_fake%' ESCAPE '\\'").get().n;
  if (fakeIds && path.resolve(values.out) === path.join(PROJECT_DIR, 'results')) {
    throw new Error(`${path.basename(db.name)} contains ${fakeIds} simulated (fake Stripe) payments; refusing to write them to results/. Use --out.`);
  }
  const manualPath = values['manual-attempts'];
  const result = analyze(db, {
    codeFiles: { 'poll.js': read('poll.js'), 'receiver.js': read('receiver.js') },
    quietFrom: values['quiet-from'], quietTo: values['quiet-to'],
    manualAttemptsCsv: fs.existsSync(manualPath) ? fs.readFileSync(manualPath, 'utf8') : '',
  });

  // Read installed versions straight from node_modules (stripe's "exports" hides package.json).
  const versions = { node: process.version };
  for (const p of ['stripe', 'express', 'better-sqlite3']) {
    versions[p] = JSON.parse(read(path.join('node_modules', p, 'package.json'))).version;
  }

  fs.mkdirSync(values.out, { recursive: true });
  const out = (f, s) => fs.writeFileSync(path.join(values.out, f), s);
  out('summary.json', JSON.stringify({ label: values.label || undefined, versions, ...result }, null, 2));
  out('summary.md', renderSummary(result, { label: values.label, versions, dbName: path.basename(db.name) }));
  out('delays.csv', csv(result.sideBySide.perPayment.map((p) => ({
    payment_id: p.id, created_iso: iso(p.created_ms), created_ms: p.created_ms, stripe_created_s: p.stripe_created_s,
    poll_seen_ms: p.poll?.seen_ms, poll_delay_s: sec(p.poll?.delay_ms),
    webhook_arrival_ms: p.webhook_arrival_ms, webhook_seen_ms: p.webhook?.seen_ms, webhook_delay_s: sec(p.webhook?.delay_ms),
  }))));
  out('outage.csv', csv(result.outage.payments));
  out('lost-event.csv', csv(result.lostEvent));
  out('api-calls-by-hour.csv', csv(result.apiCalls.byHour));

  // Inputs for the article-values page that live outside the database.
  const optional = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
  const tunnelTxt = optional(path.join(DATA_DIR, 'logs', 'tunnel-latency.txt'));
  const tunnelLatency = tunnelTxt && /median via tunnel:\s*([\d.]+)s[\s\S]*median via localhost:\s*([\d.]+)s[\s\S]*adds about:\s*([-\d.]+)s/.exec(tunnelTxt);
  const requestLog = optional(process.env.REQUEST_LOG_PATH || path.join(DATA_DIR, 'logs', 'webhook-requests.jsonl'));
  const genuine = requestLog ? findGenuine(requestLog.split('\n')) : null;
  const rawRequest = genuine ? formatSample(genuine) : null;
  if (rawRequest) out('raw-request.txt', rawRequest + '\n');
  const shotDir = path.join(DATA_DIR, 'evidence', 'screenshots');
  const shotFiles = fs.existsSync(shotDir) ? fs.readdirSync(shotDir) : [];
  const screenshots = Object.fromEntries(SCREENSHOTS.map(([name]) => [name, shotFiles.find((f) => f.startsWith(name + '.'))]).filter(([, f]) => f));
  const toolTxt = optional(path.join(DATA_DIR, 'logs', 'tunnel-tool.txt'));
  out('article-values.md', renderArticleValues(result, {
    versions, rawRequest, screenshots, label: values.label,
    dashboardRows: parseCsv(optional(manualPath) ?? ''),
    tunnelTool: values['tunnel-tool'] ?? toolTxt?.trim() ?? undefined,
    tunnelLatency: tunnelLatency ? `via public URL ${tunnelLatency[1]} s, via localhost ${tunnelLatency[2]} s, so the public URL adds about ${tunnelLatency[3]} s` : undefined,
  }));
  if (result.sideBySide.perPayment.length) out('delay-chart.svg', renderChart(result.sideBySide.perPayment, { label: values.label }));

  process.stdout.write(fs.readFileSync(path.join(values.out, 'summary.md'), 'utf8'));
  console.log(`\nwrote ${values.out}`);
}
