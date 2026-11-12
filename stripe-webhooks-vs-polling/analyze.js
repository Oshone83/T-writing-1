// analyze.js — turns payments.db into the article's numbers, raw-timestamp CSVs and a chart.
//
//   node analyze.js                      writes results/summary.md, summary.json, delays.csv,
//                                        outage.csv, api-calls-by-hour.csv, delay-chart.svg
//   node analyze.js --out some/dir --label "SIMULATED"
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { isMain, PROJECT_DIR } from './lib/env.js';
import { openDb } from './lib/db.js';
import { summarize, countInversions, countCodeLines } from './lib/stats.js';

const HOUR = 3600_000;
const iso = (ms) => (ms == null ? '' : new Date(ms).toISOString());
const sec = (ms) => (ms == null ? null : Math.round(ms) / 1000);
const fmt = (ms, d = 1) => (ms == null ? 'n/a' : (ms / 1000).toFixed(d));

export function analyze(db, { codeFiles = {} } = {}) {
  // ---------- side-by-side delays: the article's core query ----------
  const rows = db.prepare(`
    SELECT p.id, p.created_ms, p.stripe_created_s, s.method, s.seen_ms, s.seen_ms - p.created_ms AS delay_ms
    FROM payments p LEFT JOIN seen s ON p.id = s.id AND s.method IN ('poll', 'webhook')
    WHERE p.phase = 'side-by-side'
    ORDER BY p.created_ms`).all();

  const perPayment = new Map();
  for (const r of rows) {
    if (!perPayment.has(r.id)) perPayment.set(r.id, { id: r.id, created_ms: r.created_ms, stripe_created_s: r.stripe_created_s });
    if (r.method) perPayment.get(r.id)[r.method] = { seen_ms: r.seen_ms, delay_ms: r.delay_ms };
  }
  const payments = [...perPayment.values()];
  const delays = (m) => payments.filter((p) => p[m]).map((p) => p[m].delay_ms);
  const poll = summarize(delays('poll'));
  const webhook = summarize(delays('webhook'));
  const missedBy = (m) => payments.filter((p) => !p[m]).map((p) => p.id);
  const webhookBeforeCreateReturned = payments.filter((p) => p.webhook && p.webhook.delay_ms < 0).map((p) => p.id);

  const window = payments.length
    ? { start_ms: payments[0].created_ms, end_ms: payments.at(-1).created_ms }
    : null;

  // Webhook arrival order vs creation order (side-by-side phase).
  const arrival = payments.filter((p) => p.webhook).sort((a, b) => a.webhook.seen_ms - b.webhook.seen_ms);
  const createdRank = new Map(payments.map((p, i) => [p.id, i]));
  const sideBySideInversions = countInversions(arrival.map((p) => createdRank.get(p.id)));

  // ---------- API calls ----------
  const calls = db.prepare("SELECT source, at_ms FROM api_calls WHERE source = 'poll' ORDER BY at_ms").all();
  const allPaymentTimes = db.prepare('SELECT created_ms FROM payments').all().map((r) => r.created_ms);
  const byHour = new Map();
  for (const c of calls) {
    const h = Math.floor(c.at_ms / HOUR) * HOUR;
    byHour.set(h, (byHour.get(h) ?? 0) + 1);
  }
  const hours = [...byHour.keys()].sort((a, b) => a - b);
  // A "full" hour is one the poller covered from start to end: not the first or last bucket.
  const hourRows = hours.map((h, i) => {
    const paymentsInHour = allPaymentTimes.filter((t) => t >= h && t < h + HOUR).length;
    return { hour_start: iso(h), poll_calls: byHour.get(h), payments_created: paymentsInHour, full_hour: i > 0 && i < hours.length - 1 };
  });
  const quietHours = hourRows.filter((r) => r.full_hour && r.payments_created === 0);
  let duringTest = null;
  if (window && window.end_ms > window.start_ms) {
    const n = calls.filter((c) => c.at_ms >= window.start_ms && c.at_ms <= window.end_ms).length;
    // Two views: the rate over the payment window, and the plain count in the 60 min after the first payment.
    const firstHour = calls.filter((c) => c.at_ms >= window.start_ms && c.at_ms < window.start_ms + HOUR).length;
    const lastCall = calls.at(-1)?.at_ms ?? 0;
    duringTest = {
      calls: n, minutes: (window.end_ms - window.start_ms) / 60000, per_hour: n / ((window.end_ms - window.start_ms) / HOUR),
      first_hour_calls: firstHour, first_hour_complete: lastCall >= window.start_ms + HOUR,
    };
  }
  const reconcileCalls = db.prepare("SELECT COUNT(*) n FROM api_calls WHERE source = 'reconcile'").get().n;

  // ---------- webhook deliveries, duplicates ----------
  const deliveryTotals = db.prepare(`
    SELECT COUNT(*) total, SUM(duplicate) duplicates, COUNT(DISTINCT event_id) distinct_events
    FROM deliveries`).get();
  // Every row in deliveries passed constructEvent, whose default tolerance is 300 s. A delivery that
  // arrived > 300 s after the event was created can only have passed if its t= is fresh, i.e. the
  // retry was re-signed. The t= minus created spread shows it directly too.
  const lateDeliveries = db.prepare(`
    SELECT COUNT(*) n, MIN(signature_t - event_created_s) min_age_s, MAX(signature_t - event_created_s) max_age_s
    FROM deliveries WHERE received_ms / 1000 - event_created_s > 300`).get();

  // ---------- outage phase ----------
  const runs = db.prepare('SELECT started_ms, stopped_ms FROM receiver_runs ORDER BY started_ms').all();
  const outages = [];
  for (let i = 0; i < runs.length - 1; i++) {
    const down = runs[i].stopped_ms;
    const up = runs[i + 1].started_ms;
    if (down) outages.push({ down_at: iso(down), up_at: iso(up), minutes: (up - down) / 60000 });
    else outages.push({ down_at: '(unknown: receiver killed without SIGINT/SIGTERM)', up_at: iso(up), minutes: null });
  }

  const outagePayments = db.prepare("SELECT id, created_ms FROM payments WHERE phase = 'outage' ORDER BY created_ms").all();
  const deliveriesFor = db.prepare(`
    SELECT event_id, received_ms, signature_t, event_created_s, duplicate FROM deliveries
    WHERE payment_id = ? AND event_type = 'payment_intent.succeeded' ORDER BY received_ms`);
  const seenBy = db.prepare("SELECT method, seen_ms FROM seen WHERE id = ? ORDER BY seen_ms");
  const outageRows = outagePayments.map((p) => {
    const d = deliveriesFor.all(p.id);
    const seen = seenBy.all(p.id);
    const first = seen[0];
    return {
      payment_id: p.id,
      event_id: d[0]?.event_id ?? '',
      payment_created: iso(p.created_ms),
      first_webhook_delivery: iso(d[0]?.received_ms),
      webhook_deliveries: d.length,
      duplicate_deliveries: d.filter((x) => x.duplicate).length,
      signature_t_values: d.map((x) => x.signature_t).join(' '),
      signature_t_minus_event_created_s: d.map((x) => x.signature_t - x.event_created_s).join(' '),
      event_created_s: d[0]?.event_created_s ?? '',
      app_knew_via: first?.method ?? 'NEVER',
      app_knew_at: iso(first?.seen_ms),
      total_delay_s: first ? sec(first.seen_ms - p.created_ms) : null,
    };
  });
  const delivered = outageRows.filter((r) => r.first_webhook_delivery);
  const outageArrival = [...delivered].sort((a, b) => a.first_webhook_delivery.localeCompare(b.first_webhook_delivery));
  const outageRank = new Map(outageRows.map((r, i) => [r.payment_id, i]));
  const outageInversions = countInversions(outageArrival.map((r) => outageRank.get(r.payment_id)));

  // ---------- code size ----------
  const code = Object.fromEntries(Object.entries(codeFiles).map(([name, src]) => [name, countCodeLines(src)]));

  return {
    sideBySide: {
      payments: payments.length,
      window: window && { start: iso(window.start_ms), end: iso(window.end_ms) },
      poll, webhook,
      missedByPoll: missedBy('poll'), missedByWebhook: missedBy('webhook'),
      webhookBeforeCreateReturned,
      webhookArrivalInversions: sideBySideInversions,
      perPayment: payments,
    },
    apiCalls: { byHour: hourRows, quietHours, duringTest, reconcileCalls },
    deliveries: { ...deliveryTotals, duplicates: deliveryTotals.duplicates ?? 0, lateDeliveries },
    outage: {
      windows: outages,
      payments: outageRows,
      allEventuallyKnown: outageRows.every((r) => r.app_knew_via !== 'NEVER'),
      arrivedInCreationOrder: outageInversions === 0,
      arrivalInversions: outageInversions,
    },
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
  const q = r.apiCalls.quietHours;
  const quiet = q.length ? `${q.at(-1).poll_calls} (hour starting ${q.at(-1).hour_start}; ${q.length} quiet full hour(s) recorded)` : 'n/a (no full hour without payments recorded yet)';
  const dt = r.apiCalls.duringTest;
  const during = dt
    ? `${dt.first_hour_calls} in the 60 min from the first payment${dt.first_hour_complete ? '' : ' (poller stopped before the hour ended)'}; ${dt.per_hour.toFixed(1)}/h over the ${dt.minutes.toFixed(1)} min payment window`
    : 'n/a';
  const ratio = s.poll.median != null && s.webhook.median ? (s.poll.median / s.webhook.median).toFixed(1) : 'n/a';
  const banner = label ? `> **${label}**\n\n` : '';
  const o = r.outage;
  const outageTable = o.payments.length
    ? ['| Event | Payment created | Webhook deliveries | First delivered | App knew via | Total delay |', '|---|---|---|---|---|---|',
       ...o.payments.map((p) => `| ${p.event_id || '(none)'} | ${p.payment_created} | ${p.webhook_deliveries} | ${p.first_webhook_delivery || '-'} | ${p.app_knew_via} | ${p.total_delay_s == null ? '-' : p.total_delay_s.toFixed(1) + ' s'} |`)].join('\n')
    : '_No outage-phase payments recorded yet._';

  return `${banner}# Results

Generated ${new Date().toISOString()} from ${dbName}. Percentiles are nearest-rank; delays are
\`seen_ms - created_ms\` on the same machine clock.

## At a glance (side-by-side phase)

| | Polling | Webhook |
|---|---|---|
| Payments measured | ${s.poll.n} of ${s.payments} | ${s.webhook.n} of ${s.payments} |
| Median delay | ${fmt(s.poll.median)} s | ${fmt(s.webhook.median, 2)} s |
| 95th percentile delay | ${fmt(s.poll.p95)} s | ${fmt(s.webhook.p95, 2)} s |
| Worst delay | ${fmt(s.poll.max)} s | ${fmt(s.webhook.max, 2)} s |
| Best delay | ${fmt(s.poll.min)} s | ${fmt(s.webhook.min, 2)} s |
| Stripe API calls / hour, quiet hour | ${quiet} | 0 |
| Stripe API calls / hour, during the test | ${during} | 0 |
| Code lines (non-blank, non-comment) | ${r.code['poll.js'] ?? 'n/a'} (poll.js) | ${r.code['receiver.js'] ?? 'n/a'} (receiver.js) |

Median ratio, polling / webhook: **${ratio}×**. Test window: ${s.window ? `${s.window.start} → ${s.window.end}` : 'n/a'}.

- Payments the poller never saw: ${s.missedByPoll.length ? s.missedByPoll.join(', ') : 'none'}
- Payments the webhook never delivered: ${s.missedByWebhook.length ? s.missedByWebhook.join(', ') : 'none'}
- Webhooks that arrived before the create call returned (negative delay): ${s.webhookBeforeCreateReturned.length}${s.webhookBeforeCreateReturned.length ? ` (${s.webhookBeforeCreateReturned.join(', ')})` : ''}
- Webhook arrival-order inversions vs creation order: ${s.webhookArrivalInversions}

## Webhook deliveries (all phases)

- Signed deliveries received: ${r.deliveries.total} for ${r.deliveries.distinct_events} distinct events
- Duplicates turned into no-ops by the event-ID table: ${r.deliveries.duplicates}
- Deliveries that arrived more than 300 s after the event was created: ${r.deliveries.lateDeliveries.n}${r.deliveries.lateDeliveries.n ? `. All passed constructEvent's 300 s tolerance, so each carried a fresh signature; their \`t=\` was ${r.deliveries.lateDeliveries.min_age_s}–${r.deliveries.lateDeliveries.max_age_s} s after the event's \`created\`` : ''}
- Reconcile API calls recorded: ${r.apiCalls.reconcileCalls}

## Outage

Receiver down windows (from receiver_runs):
${o.windows.length ? o.windows.map((w) => `- down ${w.down_at} → up ${w.up_at}${w.minutes == null ? '' : ` (${w.minutes.toFixed(1)} min)`}`).join('\n') : '- none recorded'}

${outageTable}

- Every outage payment eventually reached the app: **${o.payments.length ? (o.allEventuallyKnown ? 'yes' : 'NO') : 'n/a'}**
- Retried events arrived in creation order: ${o.payments.length ? (o.arrivedInCreationOrder ? 'yes' : `no (${o.arrivalInversions} inversions)`) : 'n/a'}
- Failed attempt times and status codes are only visible in the Dashboard (endpoint → Event deliveries).

## Versions

${Object.entries(versions).map(([k, v]) => `- ${k} ${v}`).join('\n')}

Files: delays.csv (raw per-payment timestamps), outage.csv, api-calls-by-hour.csv, delay-chart.svg, summary.json.
`;
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({ options: { out: { type: 'string', default: path.join(PROJECT_DIR, 'results') }, label: { type: 'string', default: '' } } });
  const db = openDb();
  const read = (f) => fs.readFileSync(path.join(PROJECT_DIR, f), 'utf8');
  const result = analyze(db, { codeFiles: { 'poll.js': read('poll.js'), 'receiver.js': read('receiver.js') } });

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
    webhook_seen_ms: p.webhook?.seen_ms, webhook_delay_s: sec(p.webhook?.delay_ms),
  }))));
  out('outage.csv', csv(result.outage.payments));
  out('api-calls-by-hour.csv', csv(result.apiCalls.byHour));
  if (result.sideBySide.perPayment.length) out('delay-chart.svg', renderChart(result.sideBySide.perPayment, { label: values.label }));

  process.stdout.write(fs.readFileSync(path.join(values.out, 'summary.md'), 'utf8'));
  console.log(`\nwrote ${values.out}`);
}
