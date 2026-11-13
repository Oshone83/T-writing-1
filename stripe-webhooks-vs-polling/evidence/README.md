# Evidence for the article

Real-run evidence only. Nothing simulated goes here (simulated output lives in `../demo-results/`).

## Screenshots: `evidence/screenshots/`

Save each with exactly this name (`.png` or `.jpg`). `./exp analyze` links any that exist in
results/article-values.md and leaves the rest as [PENDING].

| File name | What to capture | When |
|---|---|---|
| `endpoint-settings.png` | Workbench → Webhooks → your destination: URL, `payment_intent.succeeded`, Snapshot payload. **Signing secret hidden** | After creating the destination |
| `outage-deliveries-failed.png` | The destination's **Event deliveries** tab: failed attempts and the next retry time | During the outage, before `./exp outage-end` |
| `outage-deliveries-final.png` | The same tab after all retries | After `./exp outage-finish` |

From a phone, take the screenshot normally, then in the Codespace's file explorer long-press
`evidence/screenshots` → **Upload…** and pick the image. Rename it to the name above.
Before committing, check that no screenshot shows a key, a `whsec_` secret or anything else private.

## Other evidence and where it lands

| Evidence | Location | Written by |
|---|---|---|
| Every step with a UTC timestamp | `logs/timeline.log` | `./exp` |
| Raw webhook requests | `logs/webhook-requests.jsonl` (git-ignored: contains full signatures) | receiver |
| First genuine request, redacted, for the article | `results/raw-request.txt` | `./exp analyze` |
| Tunnel / port-forwarding overhead | `logs/tunnel-latency.txt` | `./exp tunnel` |
| Failed delivery attempts from the Dashboard | `manual/dashboard-delivery-attempts.csv` | you, by hand |
| Reconcile recovering a lost event | `logs/reconcile-demo.log` | `./exp lost-event` |
| Process logs (receiver, poller, snapshot, payment creation) | `logs/*.log` | `scripts/bg.sh`, `./exp` |
| Numbers, CSVs, chart, article values | `results/` | `./exp analyze` |

`logs/` and `payments.db` are git-ignored by default. To publish them as evidence, review them first,
then `git add -f logs/timeline.log logs/tunnel-latency.txt logs/reconcile-demo.log` (never the
`.jsonl` with full signatures).
