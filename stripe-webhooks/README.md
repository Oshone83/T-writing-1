# Stripe: polling vs webhooks, then killing the endpoint

Companion repo for *I replaced payment polling with webhooks, then killed the endpoint: what I measured*.

Everything runs against Stripe **test mode** on one machine, and every timestamp lands in one SQLite
file (`payments.db`), so there's no clock skew. `db.js`, `poll.js`, `receiver.js` and `reconcile.js`
are the exact code shown in the article.

| File | What it does | Fills in |
| --- | --- | --- |
| `db.js` | Shared schema (`payments`, `seen`, `processed_events`, `api_calls`, `state`) and `markSeen()` | — |
| `poll.js` | The 60-second poller (cron), cursor on `created`, logs every API call | polling row |
| `receiver.js` | Express webhook receiver: raw body, signature check, event-ID dedupe | webhook row, raw request |
| `create-payments.js` | N test PaymentIntents at random 5–30 s gaps; records "payment created" | — |
| `analyze.js` | Median / p95 / worst per method, missed payments, poller calls per hour, `--csv` | results table, FAQ "N× faster" |
| `chart.js` | Writes `chart.html`: one dot per payment per method (hover, table view, dark mode) | the chart |
| `tunnel-latency.sh` | Median of 20 POSTs via the tunnel vs localhost | tunnel overhead |
| `outage.js` | Per-payment table for an outage window: first delivery, total delay, order, still missing | retries table, order, lost |
| `simulate-loss.js` | Forgets one delivered event so `reconcile.js` has something to recover | "Showing it work" |
| `reconcile.js` | Hourly catch-up over `events.list`, same event-ID table | catch-up section |
| `versions.js` | Prints Node/stripe/express/better-sqlite3 versions | "Runtime" line |

## Setup

Node 20.6+ (for `--env-file`). `better-sqlite3` installs a prebuilt binary on common platforms.

```sh
npm install
cp .env.example .env     # sk_test_... and the endpoint's whsec_...
npm run versions
npm test                 # offline: a fake Stripe API, no key or network needed
```

`create-payments.js` refuses to run with anything but a test-mode key.

## Reproducing the article

1. **Tunnel + endpoint.** Start a public HTTPS tunnel to `localhost:3000` (cloudflared, ngrok, …). In the
   Dashboard (test mode) add `<tunnel URL>/webhooks/stripe` as an endpoint, subscribed to
   `payment_intent.succeeded` only. Put its signing secret in `.env` as `STRIPE_WEBHOOK_SECRET`.
2. **Receiver:** `npm run receiver | tee receiver.log`
3. **Tunnel overhead:** `./tunnel-latency.sh https://<tunnel URL>`
4. **Poller**, once a minute via cron (use absolute paths; `--env-file` loads the key):
   ```
   * * * * * cd /path/to/stripe-webhooks && node --env-file=.env poll.js >> poll.log 2>&1
   ```
   Let it run through at least one quiet hour first, for the "quiet hour" API-call row.
5. **Payments:** `npm run payments -- 50` (count, then optional min/max gap in seconds).
6. **Numbers and chart:** `npm run analyze -- --csv delays.csv` and `npm run chart`, then open `chart.html`.

### The outage

1. Comment out the cron line (the article's outage runs with the poller off).
2. Note the time, stop the receiver (Ctrl-C). Decide whether the tunnel stays up and write it down: Stripe
   sees an error response from the tunnel if it does, a failed connection if it doesn't.
3. `npm run payments -- 10`, then screenshot the endpoint's **Event deliveries** tab.
4. Restart the receiver (`npm run receiver | tee -a receiver.log`) and **don't** press Resend.
5. Once retries land (test mode: a few attempts over a few hours):
   ```sh
   npm run outage -- 2026-11-10T14:00:00Z 2026-11-10T14:20:00Z   # outage start, end
   grep -c '^duplicate' receiver.log
   grep -o 't=[0-9]*' receiver.log      # a fresh t= per attempt answers the signature [CHECK]
   ```
   Failed-attempt times aren't in the API; copy them from the Dashboard.

### The catch-up job

```sh
npm run simulate-loss          # or: npm run simulate-loss -- evt_...
npm run reconcile              # prints "recovered evt_... pi_..." and "done, 1 recovered"
```

Hourly in cron:

```
0 * * * * cd /path/to/stripe-webhooks && node --env-file=.env reconcile.js >> reconcile.log 2>&1
```

## Tests

`npm test` runs the real scripts in a temp directory each:

- `receiver.js` with signed test payloads: valid → 200 and recorded once, a re-signed retry → `duplicate`,
  a tampered body → 400, other event types don't mark a payment.
- `poll.js` and `reconcile.js` against a local fake of Stripe's list endpoints (loaded with
  `--import test/fake-stripe-preload.js`, which only redirects the SDK's host): cursor, `gte` overlap,
  page counting, the 3-day look-back, idempotency.
- `outage.js`, `simulate-loss.js`, `analyze.js` and `chart.js` on seeded rows.

The fake API only proves the code paths. Stripe's real timing and retry behaviour come from your own run.
