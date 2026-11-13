// lib/article.js — maps every [FILL] in the article to a measured value, or to an explicit
// [PENDING: …] that says where the value will come from. It never estimates.
// `./exp analyze` (or `node analyze.js`) writes the result to results/article-values.md.
// ARTICLE-RESULTS.md in the repo is this same output for an empty database: every value PENDING.

const P = (what) => `[PENDING: ${what}]`;
const s1 = (ms) => (ms / 1000).toFixed(1);
const s2 = (ms) => (ms / 1000).toFixed(2);
const RUN = 'needs the real Stripe test-mode run';

export const SCREENSHOTS = [
  ['endpoint-settings', 'Event destination settings (secret hidden)', 'step 3 of the runbook'],
  ['outage-deliveries-failed', 'Event deliveries tab during the outage: failed attempts and next retry time', 'outage, before restarting the receiver'],
  ['outage-deliveries-final', 'Event deliveries tab after all retries', 'outage, at the end'],
];

export function renderArticleValues(r, x = {}) {
  const s = r.sideBySide;
  const o = r.outage;
  const a = r.apiCalls;
  const has = s.payments > 0;
  const v = (cond, value, pending) => (cond ? value : P(pending));
  const med = (m, f) => v(has && s[m].n, `${f(s[m].median)} s`, RUN);
  const p95 = (m, f) => v(has && s[m].n, `${f(s[m].p95)} s`, RUN);
  const max = (m, f) => v(has && s[m].n, `${f(s[m].max)} s`, RUN);
  const ratio = has && s.webhook.median > 0 ? `${(s.poll.median / s.webhook.median).toFixed(0)}×` : P(RUN);
  const quiet = a.quiet?.valid ? `${a.quiet.calls} (${a.quiet.from} → ${a.quiet.to})` : P(a.quiet ? `quiet hour not valid yet: ${a.quiet.problems.join('; ')}` : RUN);
  const during = a.duringTest?.first_hour_complete ? String(a.duringTest.first_hour_calls) : P(a.duringTest ? 'keep the poller running 60 min after the first payment' : RUN);
  const interval = a.pollInterval?.median != null ? `median ${s1(a.pollInterval.median)} s between poll runs` : P(RUN);

  const planned = o.planned;
  const outPays = o.payments;
  const outMinutes = planned?.minutes != null ? `${planned.minutes.toFixed(1)} min` : P('outage phase');
  const delivered = outPays.filter((p) => p.webhook_delivery_delay_s != null);
  const firstRetry = delivered.length ? Math.min(...delivered.map((p) => p.webhook_delivery_delay_s)) : null;
  const worstOutage = outPays.length && outPays.every((p) => p.total_delay_s != null) ? Math.max(...outPays.map((p) => p.total_delay_s)) : null;
  const span = outPays.length > 1 ? (Date.parse(outPays.at(-1).payment_created) - Date.parse(outPays[0].payment_created)) / 60000 : null;
  const dashResults = [...new Set((x.dashboardRows ?? []).filter((d) => !/^2\d\d$/.test(d.result)).map((d) => d.result))];

  const shot = (name) => (x.screenshots?.[name] ? `evidence/screenshots/${x.screenshots[name]}` : P(`save as evidence/screenshots/${name}.png`));
  const versions = x.versions ?? {};

  const retryRows = outPays.length
    ? outPays.map((p) => `| ${p.event_id || P('not delivered yet')} | ${p.payment_created} | ${p.dashboard_failed_attempt_times || (x.dashboardRows?.length ? 'none recorded' : P('copy from the Dashboard into manual/dashboard-delivery-attempts.csv'))} | ${p.first_webhook_delivery || P('waiting for a retry')} | ${p.total_delay_s == null ? P('waiting') : `${p.total_delay_s.toFixed(1)} s`} |`)
    : [`| ${P('outage phase')} | | | | |`];

  const surprises = has ? [
    s.missedByPoll.length ? `Poller missed: ${s.missedByPoll.join(', ')}` : 'Poller missed none',
    s.missedByWebhook.length ? `Webhook missed: ${s.missedByWebhook.join(', ')}` : 'Webhook missed none',
    `Webhooks written before the create call returned: ${s.webhookBeforeCreateReturned.length}`,
    `Webhook arrival-order inversions: ${s.webhookArrivalInversions}`,
    `Same payment under two event IDs: ${r.deliveries.samePaymentMultipleEvents.length}`,
  ].map((b) => `- ${b}`).join('\n') : `- ${P(RUN)}`;

  const lost = r.lostEvent.find((l) => l.recovered);

  return `${x.label ? `> **${x.label}**\n\n` : ''}# Article values

Every [FILL] in the article, in article order. A value appears only once it has been measured;
otherwise it reads [PENDING: …] with where it will come from. Source data: results/summary.md,
results/*.csv, logs/, manual/ and evidence/.

## Intro and results table

| Placeholder | Polling every 60 s | Webhook |
|---|---|---|
| Median delay | ${med('poll', s1)} | ${med('webhook', s2)} |
| 95th percentile delay | ${p95('poll', s1)} | ${p95('webhook', s2)} |
| Worst delay | ${max('poll', s1)} | ${max('webhook', s2)} |
| API calls per hour, quiet hour | ${quiet} | 0 |
| API calls per hour, during the test | ${during} | 0 |
| When my side was down for ${outMinutes} | ${outPays.length ? 'poller was off for this phase' : P('outage phase')} | ${worstOutage != null ? `all ${outPays.length} delivered; worst total delay ${worstOutage.toFixed(1)} s` : P('outage phase')} |
| Code I maintain | ${r.code['poll.js'] != null ? `${r.code['poll.js']} lines + a cursor` : P('analyze')} | ${r.code['receiver.js'] != null ? `${r.code['receiver.js']} lines + an event-ID table` : P('analyze')} |

- How long the poller had run before switching: ${P('your own history; if built only for this test, say so')}
- N test payments: ${has ? s.payments : P(RUN)}
- First retry arrived (earliest outage payment delivered by retry, after its creation): ${firstRetry != null ? `${firstRetry.toFixed(1)} s` : P('outage phase')}
- Polling / webhook median ratio (FAQ "X times faster"): ${ratio}
- Poll interval actually used: ${interval}

## Setup

- Node ${versions.node ?? P('analyze')}, stripe ${versions.stripe ?? P('analyze')}, express ${versions.express ?? P('analyze')}, better-sqlite3 ${versions['better-sqlite3'] ?? P('analyze')}
- Public URL tool and version: ${x.tunnelTool ?? P('e.g. "GitHub Codespaces port forwarding" or "cloudflared 2026.x"')}
- Tunnel delay (median of 20 POSTs via the public URL vs localhost): ${x.tunnelLatency ?? P('./exp tunnel → logs/tunnel-latency.txt')}
- Repo link: ${P('your GitHub repo URL')}

## The webhook version

Raw request (first genuine Stripe delivery; signature and IDs shortened):

\`\`\`
${x.rawRequest ?? P('./exp analyze writes results/raw-request.txt after the first real delivery')}
\`\`\`

- Endpoint settings screenshot: ${shot('endpoint-settings')}

## Running both side by side

- Chart: ${has ? 'results/delay-chart.svg' : P(RUN)}
- Anything surprising:
${surprises}

## Then I killed the endpoint

- Stopped the receiver at: ${planned?.down_at ?? P('outage phase')} (tunnel/port left up, per the runbook)
- What Stripe recorded for the failed attempts: ${dashResults.length ? dashResults.join(', ') : P('Dashboard → Event deliveries → manual/dashboard-delivery-attempts.csv')}
- Outage payments: ${outPays.length ? `${outPays.length} over ${span != null ? span.toFixed(1) : '0'} min` : P('outage phase')}
- Event deliveries screenshot (failed): ${shot('outage-deliveries-failed')}
- Restarted the receiver at: ${planned?.up_at ?? P('outage phase')}, ${outMinutes} after stopping it

| Event | Payment created | Failed attempts | Delivered by retry at | Total delay |
|---|---|---|---|---|
${retryRows.join('\n')}

- Order: ${outPays.length ? (o.arrivedInCreationOrder ? 'retried events arrived in creation order' : `not in creation order (${o.arrivalInversions} inversions)`) : P('outage phase')}
- Duplicates: ${r.deliveries.total ? `${r.deliveries.duplicates} same-event-ID duplicate(s) turned into no-ops` : P(RUN)}
- Signatures: ${r.deliveries.lateDeliveries.n ? `${r.deliveries.lateDeliveries.n} delivery(ies) arrived > 300 s after the event was created and passed the 300 s check; their t= was ${r.deliveries.lateDeliveries.min_age_s}–${r.deliveries.lateDeliveries.max_age_s} s after the event's created (fresh signature). Stripe documents this: "we generate a new signature and timestamp for the new delivery attempt."` : P('needs a retry arriving > 5 min after its event; keep the receiver down ≥ 10 min')}
- Anything lost: ${outPays.length ? (o.allDeliveredByWebhook ? 'no: every outage payment was delivered by a webhook retry' : 'YES: see results/outage.csv and run ./exp lost-event / node reconcile.js') : P('outage phase')}
- Event deliveries screenshot (final): ${shot('outage-deliveries-final')}
- Takeaway: retries turned a ${outMinutes} outage into ${worstOutage != null ? `at most ${worstOutage.toFixed(1)} s` : P('outage phase')} of delay

## The catch-up script

- Showing it work: ${lost ? `forgot ${lost.event_id} at ${lost.forgotten_at}; reconcile recovered it at ${lost.recovered_by_reconcile_at} (logs/reconcile-demo.log)` : P('./exp lost-event → logs/reconcile-demo.log')}

## What I run now

- What changed in practice: ${P('your words')}
`;
}
