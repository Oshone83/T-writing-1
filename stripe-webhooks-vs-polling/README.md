# Stripe payments: polling vs webhooks, an outage, and the poll I kept

Companion code for *I replaced payment polling with webhooks, then killed the endpoint: what I measured*.

It measures, per payment, how long a 60-second poller and a webhook take to learn about a new
Stripe payment. It then switches the webhook endpoint off to watch Stripe's retries, and recovers a
lost event with an hourly reconcile job. **Stripe test mode only:** the scripts refuse `sk_live_` keys.

```
create-payments.js ──► Stripe ──POST per event──► receiver.js ──┐
                         ▲                                       ├─► payments.db (SQLite)
poll.js  (every 60 s) ───┤ GET /v1/payment_intents               │   seen, processed_events,
reconcile.js (hourly) ───┘ GET /v1/events ───────────────────────┘   deliveries, api_calls …
                                              analyze.js ──► results/ (summary, CSVs, chart)
```

| File | What it does |
|---|---|
| `create-payments.js` | Creates N test PaymentIntents (`pm_card_visa`) 5–30 s apart, records when each create call returned |
| `poll.js` | The poller: lists PaymentIntents since a cursor, counts every HTTP call. `node poll.js` once (cron) or `--every 60` |
| `receiver.js` | Express webhook route: raw body, signature check, event-ID dedupe, logs every delivery |
| `reconcile.js` | Catch-up job: reads `payment_intent.succeeded` from the events list, processes any the app never recorded |
| `simulate-lost-event.js` | Makes the app forget one delivered event so reconcile has something to recover |
| `analyze.js` | Turns the database into the article's numbers, raw-timestamp CSVs and an SVG chart |
| `scripts/measure-tunnel.sh` | Median round trip via the tunnel vs via localhost (20 runs each) |
| `scripts/demo.js` | The whole experiment against a **local fake Stripe**, compressed to ~2 minutes |
| `lib/db.js` | Schema and the `markSeen` / `processEventOnce` helpers |
| `test/` | Unit tests, receiver tests using Stripe's real signature code, and an end-to-end pipeline test |

## 1. Install and check it works (no Stripe account needed)

Requires Node 22 or later.

```sh
cd stripe-webhooks-vs-polling
npm install
npm test        # 15 tests
npm run demo    # ~2 min end-to-end run against a fake Stripe → demo-results/
```

`demo-results/` shows what the outputs look like. **Its numbers are simulated** (a local fake
Stripe, a 10 s poller, 5/10/20 s retries) and must not go in the article.

## 2. Configure your secrets (test mode only)

1. In the Stripe Dashboard, switch on **Test mode** (or use a sandbox).
2. **Developers → API keys**: copy the **Secret key**, which starts with `sk_test_`.
3. `cp .env.example .env` and paste it as `STRIPE_SECRET_KEY`. You add the webhook secret in step 4.

Keeping secrets safe:

- `.env` is in `.gitignore`. Before every commit, run `git status` and check `.env` is not listed.
- Never paste keys into code, issues, chat or screenshots. Crop screenshots that show a key or `whsec_`.
- Better still, create a **restricted key** (`rk_test_…`) with *PaymentIntents: write* and
  *Events: read* only. The scripts accept it.
- If a key ever leaks, roll it in **Developers → API keys** and roll the endpoint's signing secret.
- Shell variables override `.env`, e.g. `STRIPE_SECRET_KEY=sk_test_… node poll.js`.

## 3. Start a tunnel and the receiver

Stripe needs a public HTTPS URL. Any tunnel works, for example Cloudflare's:

```sh
cloudflared --version                              # note the version for the article
cloudflared tunnel --url http://localhost:3000     # prints https://<random>.trycloudflare.com
```

(or `ngrok http 3000`). Leave it running. In a second terminal:

```sh
npm run receiver          # listening on 3000, POST /webhooks/stripe
```

## 4. Register the endpoint in the Dashboard

In **test mode**, open **Developers → Webhooks → Add endpoint** (newer Dashboards: **Workbench →
Webhooks / Event destinations → Add destination → Webhook endpoint**).

- URL: `https://<your-tunnel>/webhooks/stripe`
- Events: **`payment_intent.succeeded` only**
- Save, then reveal the **Signing secret** (`whsec_…`) and put it in `.env` as `STRIPE_WEBHOOK_SECRET`
- Restart the receiver (Ctrl+C, `npm run receiver`) so it picks up the secret
- 📸 Screenshot the endpoint settings with the secret hidden (article: *[FILL: screenshot of the endpoint settings]*)

Measure the tunnel overhead while you're here (the receiver must be running):

```sh
./scripts/measure-tunnel.sh https://<your-tunnel>   # median via tunnel, via localhost, and the difference
```

Use `stripe listen` only for a quick sanity check, if at all. The article's outage test needs a
registered endpoint, so the retries come from Stripe's own delivery system.

## 5. Run the experiment

Keep the tunnel and receiver running throughout. Use a third terminal for the poller.

### Phase A: a quiet hour (API calls with nothing happening)

Start the poller at least an hour before creating any payments, so it covers one full clock hour
(e.g. 10:00–11:00) with no payments in it:

```sh
crontab -e     # paste the poll line from crontab.example, with your path
# or, without cron:
npm run poll:loop    # node poll.js --every 60
```

### Phase B: side by side (delays + API calls during the test)

```sh
npm run create       # 100 payments, 5–30 s apart, about 30 minutes; Ctrl+C stops cleanly
```

Leave the poller running for **at least 60 minutes after the first payment**, so the "calls in the
first hour of the test" number is complete. Change `--count` in `package.json` if you want a
different N.

### Phase C: kill the endpoint

1. Stop the poller (comment out the cron line or Ctrl+C the loop). It must not record outage payments.
2. **Stop the receiver with Ctrl+C**, not `kill -9`, so its stop time is recorded. Decide whether the
   tunnel stays up (Stripe sees an error status from the tunnel) or goes down too (Stripe sees a
   connection failure), and write down which.
3. `npm run create:outage` creates 5 payments, 5–30 s apart.
4. 📸 In the Dashboard, open the endpoint's **Event deliveries** and screenshot the failed attempts
   and the **next retry** time. Note each failed attempt's time and status code; analyze.js can't
   see failed attempts.
5. After the downtime you chose (e.g. 10 min), run `npm run receiver` again.
6. **Leave it alone. Don't press Resend.** Test-mode retries are spaced out (Stripe's docs say three
   attempts over a few hours), so keep the receiver and tunnel up until every outage event has
   arrived or the Dashboard shows no retries left. Screenshot the deliveries tab again at the end.

> If your tunnel URL changes when you restart it (free `trycloudflare` URLs do), keep the tunnel
> process running during the outage and stop only the receiver. Otherwise the retries go to a
> dead URL.

### Phase D: the catch-up script

If every event came back through retries, simulate a lost one, then recover it:

```sh
node simulate-lost-event.js | tee -a logs/reconcile-demo.log
node reconcile.js           | tee -a logs/reconcile-demo.log    # "recovered evt_… pi_…", "1 recovered"
node reconcile.js           | tee -a logs/reconcile-demo.log    # second run: 0 recovered
```

If an outage payment never arrived, skip `simulate-lost-event.js`: `node reconcile.js` recovers the real one.

### Phase E: analyze

```sh
npm run analyze      # prints the summary and writes results/
```

`results/` contains `summary.md`, `summary.json`, `delays.csv` (raw per-payment timestamps),
`outage.csv`, `api-calls-by-hour.csv` and `delay-chart.svg`. Commit `results/` so the article's
numbers can be traced. `payments.db` and `logs/` are git-ignored. Commit them only after
checking they contain nothing you don't want public.

## 6. Where each [FILL] comes from

| Article placeholder | Source |
|---|---|
| Medians, p95, worst (both methods) | `results/summary.md`: *At a glance* |
| N payments | *Payments measured* row |
| API calls/hour, quiet hour | *quiet hour* row; per-hour detail in `api-calls-by-hour.csv` |
| API calls/hour, during the test | *during the test* row |
| "X times faster at the median" | *Median ratio* line |
| Versions | *Versions* section (plus your tunnel tool's `--version`) |
| Tunnel delay | `scripts/measure-tunnel.sh` output |
| Raw request (headers + body start) | first line of `logs/webhook-requests.jsonl`. Trim the `stripe-signature` value and IDs before pasting |
| Chart | `results/delay-chart.svg` (open in a browser; screenshot or embed) |
| Surprises / missed payments / webhook before create returned / order | bullet list under *At a glance* |
| Outage start/end and length | *Outage → Receiver down windows* |
| What Stripe recorded (status code / connection error), failed attempt times | Dashboard → endpoint → Event deliveries (only source) |
| Retry table (event, payment created, delivered by retry at, total delay) | *Outage* table and `outage.csv` |
| Order of retried events | *Retried events arrived in creation order* |
| Duplicates | *Duplicates turned into no-ops* (and `duplicate` lines in the receiver output) |
| [CHECK] fresh `t=` on retries | *Deliveries that arrived more than 300 s after the event was created*, plus `signature_t_minus_event_created_s` in `outage.csv` |
| Anything lost | *Every outage payment eventually reached the app* |
| Reconcile recovery | `logs/reconcile-demo.log` |
| Code I maintain | *Code lines* row (non-blank, non-comment lines of `poll.js` / `receiver.js`) |

How the delay is defined: `seen_ms − created_ms`, both `Date.now()` on the same machine.
`created_ms` is taken right after the create call returns. The webhook's `seen_ms` is when the
request reached the receiver, and the poller's is when it wrote the row. Percentiles are
nearest-rank, so p95 is always a delay that actually happened.

## Changes from the article's code, and why

| Article code | Problem | Fix here |
|---|---|---|
| `db.pragma('journal_mode = WAL')` only | Three processes write one SQLite file. Without a busy timeout, a colliding write throws `SQLITE_BUSY` at once | `busy_timeout = 5000` |
| Receiver/reconcile: insert event ID, *then* `markSeen` | If the work throws after the ID is committed, the event counts as processed but the work never happened, and every retry is skipped as a duplicate | Both in one transaction (`processEventOnce`); on failure the receiver returns 500 so Stripe retries |
| Receiver creates `new Stripe(STRIPE_SECRET_KEY)` | Signature checking needs only `whsec_`; the API key on the webhook server is unnecessary exposure | `Stripe.webhooks.constructEvent` with no API key |
| One `payments` table for all runs | Side-by-side and outage payments get mixed in the statistics | `phase` column; analysis per phase |
| Duplicates only printed to the console | Not enough to build the retry table, check ordering or verify `t=` freshness | `deliveries` table: every verified delivery with signature `t=` and a duplicate flag |
| Outage times noted by hand | Easy to get wrong | `receiver_runs` records start and stop times (Ctrl+C / SIGTERM) |
| No guard on the key | A live key in `.env` would create real charges | Scripts refuse anything but `sk_test_` / `rk_test_` |
| `* * * * * … node poll.js` only | Not everyone has cron | `node poll.js --every 60` loop with a fixed-rate schedule |

The poller's `created` cursor still misses payments that succeed after the cursor has moved past
them. That's deliberate, since the article discusses it. API calls are counted with the SDK's
`request` event, so list pages and the SDK's automatic network retries count too.

## Tests

```sh
npm test
```

- `test/unit.test.js`: percentiles, idempotent `markSeen`, `processEventOnce` rollback, test-key guard.
- `test/receiver.test.js`: valid signature, duplicate delivery, wrong secret, tampered body,
  re-serialized JSON, stale timestamp (> 300 s), missing header, non-payment events. Signatures
  come from the Stripe SDK's own `generateTestHeaderString`.
- `test/pipeline.test.js`: create → poll → webhook → outage with retries → forced duplicate →
  lost event → reconcile → analyze, against `test/support/fake-stripe.js`.
