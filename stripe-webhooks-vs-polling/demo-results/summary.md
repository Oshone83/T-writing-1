> **SIMULATED against a local fake Stripe on a compressed timescale. NOT real Stripe data; do not publish these numbers.**

# Results

Generated 2026-11-12T16:40:16.716Z from demo.db. Percentiles are nearest-rank; delays are
`seen_ms - created_ms` on the same machine clock.

## At a glance (side-by-side phase)

| | Polling | Webhook |
|---|---|---|
| Payments measured | 20 of 20 | 20 of 20 |
| Median delay | 5.3 s | 0.05 s |
| 95th percentile delay | 8.5 s | 0.06 s |
| Worst delay | 9.6 s | 0.06 s |
| Best delay | 0.1 s | 0.05 s |
| Stripe API calls / hour, quiet hour | n/a (no full hour without payments recorded yet) | 0 |
| Stripe API calls / hour, during the test | 6 in the 60 min from the first payment (poller stopped before the hour ended); 340.2/h over the 0.9 min payment window | 0 |
| Code lines (non-blank, non-comment) | 49 (poll.js) | 77 (receiver.js) |

Median ratio, polling / webhook: **101.7×**. Test window: 2026-11-12T16:38:32.107Z → 2026-11-12T16:39:25.011Z.

- Payments the poller never saw: none
- Payments the webhook never delivered: none
- Webhooks that arrived before the create call returned (negative delay): 0
- Webhook arrival-order inversions vs creation order: 0

## Webhook deliveries (all phases)

- Signed deliveries received: 24 for 23 distinct events
- Duplicates turned into no-ops by the event-ID table: 1
- Deliveries that arrived more than 300 s after the event was created: 0
- Reconcile API calls recorded: 2

## Outage

Receiver down windows (from receiver_runs):
- down 2026-11-12T16:39:36.024Z → up 2026-11-12T16:39:50.926Z (0.2 min)

| Event | Payment created | Webhook deliveries | First delivered | App knew via | Total delay |
|---|---|---|---|---|---|
| evt_fake000069 | 2026-11-12T16:39:36.181Z | 1 | 2026-11-12T16:39:51.239Z | webhook | 15.1 s |
| evt_fake000072 | 2026-11-12T16:39:37.596Z | 1 | 2026-11-12T16:39:52.652Z | webhook | 15.1 s |
| evt_fake000075 | 2026-11-12T16:39:38.742Z | 1 | 2026-11-12T16:39:53.797Z | reconcile | 37.7 s |

- Every outage payment eventually reached the app: **yes**
- Retried events arrived in creation order: yes
- Failed attempt times and status codes are only visible in the Dashboard (endpoint → Event deliveries).

## Versions

- node v22.23.4
- stripe 23.1.0
- express 5.3.0
- better-sqlite3 13.1.1

Files: delays.csv (raw per-payment timestamps), outage.csv, api-calls-by-hour.csv, delay-chart.svg, summary.json.
