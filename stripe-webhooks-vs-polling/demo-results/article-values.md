> **SIMULATED against a local fake Stripe on a compressed timescale. NOT real Stripe data; do not publish these numbers.**

# Article values

Every [FILL] in the article, in article order. A value appears only once it has been measured;
otherwise it reads [PENDING: …] with where it will come from. Source data: results/summary.md,
results/*.csv, logs/, manual/ and evidence/.

## Intro and results table

| Placeholder | Polling every 60 s | Webhook |
|---|---|---|
| Median delay | 6.2 s | 0.05 s |
| 95th percentile delay | 9.9 s | 0.06 s |
| Worst delay | 10.0 s | 0.06 s |
| API calls per hour, quiet hour | [PENDING: quiet hour not valid yet: the poller was not running at the window start (first poll call 2026-11-13T05:12:48.533Z)] | 0 |
| API calls per hour, during the test | [PENDING: keep the poller running 60 min after the first payment] | 0 |
| When my side was down for 0.2 min | poller was off for this phase | all 3 delivered; worst total delay 15.1 s |
| Code I maintain | 41 lines + a cursor | 79 lines + an event-ID table |

- How long the poller had run before switching: [PENDING: your own history; if built only for this test, say so]
- N test payments: 20
- First retry arrived (earliest outage payment delivered by retry, after its creation): 15.1 s
- Polling / webhook median ratio (FAQ "X times faster"): 119×
- Poll interval actually used: median 10.0 s between poll runs

## Setup

- Node v22.23.4, stripe 23.1.0, express 5.3.0, better-sqlite3 13.1.1
- Public URL tool and version: [PENDING: e.g. "GitHub Codespaces port forwarding" or "cloudflared 2026.x"]
- Tunnel delay (median of 20 POSTs via the public URL vs localhost): [PENDING: ./exp tunnel → logs/tunnel-latency.txt]
- Repo link: [PENDING: your GitHub repo URL]

## The webhook version

Raw request (first genuine Stripe delivery; signature and IDs shortened):

```
[PENDING: ./exp analyze writes results/raw-request.txt after the first real delivery]
```

- Endpoint settings screenshot: [PENDING: save as evidence/screenshots/endpoint-settings.png]

## Running both side by side

- Chart: results/delay-chart.svg
- Anything surprising:
- Poller missed none
- Webhook missed none
- Webhooks written before the create call returned: 0
- Webhook arrival-order inversions: 0
- Same payment under two event IDs: 0

## Then I killed the endpoint

- Stopped the receiver at: 2026-11-13T05:13:52.031Z (tunnel/port left up, per the runbook)
- What Stripe recorded for the failed attempts: [PENDING: Dashboard → Event deliveries → manual/dashboard-delivery-attempts.csv]
- Outage payments: 3 over 0.0 min
- Event deliveries screenshot (failed): [PENDING: save as evidence/screenshots/outage-deliveries-failed.png]
- Restarted the receiver at: 2026-11-13T05:14:06.893Z, 0.2 min after stopping it

| Event | Payment created | Failed attempts | Delivered by retry at | Total delay |
|---|---|---|---|---|
| evt_fake000069 | 2026-11-13T05:13:52.191Z | [PENDING: copy from the Dashboard into manual/dashboard-delivery-attempts.csv] | 2026-11-13T05:14:07.249Z | 15.1 s |
| evt_fake000073 | 2026-11-13T05:13:53.665Z | [PENDING: copy from the Dashboard into manual/dashboard-delivery-attempts.csv] | 2026-11-13T05:14:08.721Z | 15.1 s |
| evt_fake000076 | 2026-11-13T05:13:54.706Z | [PENDING: copy from the Dashboard into manual/dashboard-delivery-attempts.csv] | 2026-11-13T05:14:09.759Z | 15.1 s |

- Order: retried events arrived in creation order
- Duplicates: 1 same-event-ID duplicate(s) turned into no-ops
- Signatures: [PENDING: needs a retry arriving > 5 min after its event; keep the receiver down ≥ 10 min]
- Anything lost: no: every outage payment was delivered by a webhook retry
- Event deliveries screenshot (final): [PENDING: save as evidence/screenshots/outage-deliveries-final.png]
- Takeaway: retries turned a 0.2 min outage into at most 15.1 s of delay

## The catch-up script

- Showing it work: forgot evt_fake000088 at 2026-11-13T05:14:33.486Z; reconcile recovered it at 2026-11-13T05:14:33.635Z (logs/reconcile-demo.log)

## What I run now

- What changed in practice: [PENDING: your words]
