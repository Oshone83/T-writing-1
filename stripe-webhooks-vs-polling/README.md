# Stripe payments: polling vs webhooks, an outage, and the poll I kept

Companion code for *I replaced payment polling with webhooks, then killed the endpoint: what I measured*.

It measures, per payment, how long a 60-second poller and a webhook take to learn about a new
Stripe payment. It then switches the webhook endpoint off to watch Stripe's retries, and recovers a
lost event with an hourly reconcile job. **Stripe test mode only:** the scripts refuse `sk_live_` keys.

```
create-payments.js ──► Stripe ──POST per event──► receiver.js ──┐
                         ▲                                       ├─► payments.db (SQLite)
poll.js  (every 60 s) ───┤ GET /v1/payment_intents               │   payments, seen, processed_events,
reconcile.js (hourly) ───┤ GET /v1/events                        │   deliveries, receiver_runs,
snapshot-pending.js ─────┘ GET /v1/events?delivery_success=false ┘   pending_snapshots, api_calls …
                                              analyze.js ──► results/ (summary, CSVs, chart)
```

| File | What it does |
|---|---|
| `create-payments.js` | Creates N test PaymentIntents (`pm_card_visa`) 5–30 s apart, tagged with a phase (`smoke`, `side-by-side`, `outage`, `lost-event`) |
| `poll.js` | The poller: lists PaymentIntents since a cursor. `node poll.js` once (cron) or `--every 60` |
| `receiver.js` | Express webhook route on 127.0.0.1: raw body, signature check, event-ID dedupe, every delivery logged |
| `reconcile.js` | Catch-up job: processes any `payment_intent.succeeded` event the app never recorded. Once, or `--every 3600` |
| `snapshot-pending.js` | During the outage: Stripe's own list of undelivered events (`delivery_success=false`) |
| `simulate-lost-event.js` | Forgets one delivered event so reconcile can recover it. Only works on `lost-event` payments |
| `analyze.js` | Turns the database into the article's numbers, raw-timestamp CSVs and an SVG chart |
| `manual/dashboard-delivery-attempts.csv` | You fill this in from the Dashboard: failed attempt times and status codes |
| `scripts/bg.sh` | Starts/stops the long-running processes in the background (good from a phone) |
| `scripts/measure-tunnel.sh` | Median round trip via the public URL vs via localhost (20 runs each) |
| `scripts/sample-request.js` | Prints the first genuine Stripe request from the log, signature and IDs shortened |
| `scripts/demo.js` | The whole experiment against a **local fake Stripe**, compressed to ~2 minutes |
| `STRIPE-CLAIMS.md` | Every Stripe claim, with the quote and source it was checked against |
| `test/` | 25 tests: unit, receiver (real Stripe signature code), analysis, end-to-end pipeline |

## 0. Where to run it

Everything (receiver, poller, payment creator) must run **on one machine**, so all timestamps come
from the same clock, for about **5–7 hours** in one go. You need:

- Node 22 or later and npm
- outbound HTTPS to `api.stripe.com`
- a **public HTTPS URL** that forwards to the receiver on port 3000
- a machine that stays on and awake the whole time

A laptop or desktop works (section 2a: use a tunnel such as `cloudflared` or `ngrok`). **From a
phone**, use GitHub Codespaces (section 2b): its port forwarding gives the public URL and no tunnel is
needed. Claude's cloud sessions can't host this experiment: they can't receive inbound requests from
Stripe and aren't guaranteed to stay up for hours.

## 1. Install and check it works (no Stripe account needed)

```sh
cd stripe-webhooks-vs-polling
npm install
npm test        # 25 tests
npm run demo    # ~2 min end-to-end run against a fake Stripe → demo-results/
```

`demo-results/` shows what the outputs look like. **Its numbers are simulated** (a local fake
Stripe, a 10 s poller, retries after 5/10/20 s) and must not go in the article. The demo writes only
to `demo.db` and `demo-results/`, and fails if it ever touches the real `logs/` or `payments.db`.

## 2. Keys and the public URL

### Keep secrets safe (both setups)

- **Test mode only.** In the Dashboard, switch to **Test mode** (or a sandbox) before copying anything.
- Prefer a **restricted key** (`rk_test_…`, **Developers → API keys → Create restricted key**) with
  *PaymentIntents: Write* and *Events: Read*. A plain `sk_test_…` key also works.
- Keys live in `.env` (git-ignored) or in environment variables, never in code, commits, chat or
  screenshots. Run `git status` before every commit and make sure `.env` isn't listed.
- If a key leaks, roll it in **Developers → API keys**, and roll the endpoint's signing secret.

### 2a. On a computer

```sh
cp .env.example .env           # then put your sk_test_/rk_test_ key in STRIPE_SECRET_KEY
cloudflared --version          # note the version for the article
cloudflared tunnel --url http://localhost:3000    # prints https://<random>.trycloudflare.com
```

Leave the tunnel running. Free `trycloudflare` URLs **change every time cloudflared restarts**, which
would strand Stripe's retries, so don't restart it mid-experiment. An `ngrok` account with a fixed
domain avoids that. Then continue with section 3.

Keep the computer awake for the whole run: macOS `caffeinate -dimsu` in a spare terminal; Linux
`systemd-inhibit --what=sleep:idle sleep infinity`; Windows: Settings → Power → Never sleep (plugged
in). Sleep stops cron, the receiver and the tunnel. On Windows, run the shell scripts in WSL or
Git Bash, and use `./scripts/bg.sh` or `npm run poll:loop` instead of cron.

### 2b. From a phone: GitHub Codespaces

Nothing here was tested on Codespaces itself. The smoke test in step 4 is what proves your setup works.

1. Before starting, in GitHub on your phone's browser: **Settings → Codespaces**.
   - **Default idle timeout**: set it to the maximum (GitHub documents 240 minutes; check what yours allows).
     A codespace stops after that long without you interacting with it, and the experiment's processes stop with it.
   - **Secrets → New secret**: name `STRIPE_SECRET_KEY`, value your `rk_test_`/`sk_test_` key,
     repository access: this repo. Codespaces turns it into an environment variable, so no key is typed into a file.
   - Check your free Codespaces allowance under **Settings → Billing**. A 2-core machine for ~7 hours fits most free allowances, but check yours.
2. Open the repo on github.com → **Code → Codespaces → Create codespace on**
   `claude/stripe-webhook-polling-test-p6dx3f` (or main once merged). The repo's `.devcontainer`
   gives it Node 22 and runs `npm install`.
3. In the codespace terminal: `cd stripe-webhooks-vs-polling && npm test`.
4. Start the receiver once so port 3000 exists. It refuses to start without a signing secret, so use a
   placeholder for now: `STRIPE_WEBHOOK_SECRET=whsec_placeholder ./scripts/bg.sh start receiver`.
5. Open the **Ports** panel, find port 3000, right-click (long-press) → **Port Visibility → Public**,
   and copy the forwarded address (`https://<codespace>-3000.app.github.dev`). That is your public URL.
   If Stripe's deliveries later fail with 502 while the receiver runs, restart it with `HOST=0.0.0.0`
   (the codespace is not on a shared network, so that's acceptable there).
6. `./scripts/bg.sh stop receiver`, then continue with section 3, using `./scripts/bg.sh` for every
   long-running process. Closing the browser tab doesn't stop them; the codespace stopping does.
7. Check in at least every ~3 hours during the run (open the codespace, run `./scripts/bg.sh status`):
   that resets the idle timer. If the codespace did stop, the database survives; restart the processes
   and the gap shows up in the results as an "unknown" receiver down window.

## 3. Register the endpoint, then start the receiver (in this order)

1. In the Dashboard, **test mode**: **Workbench → Webhooks → Create an event destination**.
   - Events from: **Your account**
   - Payload format: **Snapshot**, not the default Thin. This receiver reads the payment from
     `event.data.object`, which thin events don't include. Leave the API version as offered.
   - Event types: **`payment_intent.succeeded` only**
   - Destination type: **Webhook endpoint**; URL: `https://<your public URL>/webhooks/stripe`
2. On the destination's page, **Reveal secret** and copy the `whsec_…` value into `.env` as
   `STRIPE_WEBHOOK_SECRET` (in Codespaces: open `.env.example`, save a copy as `.env` in the editor).
3. 📸 Screenshot the destination settings with the secret hidden (article: *[FILL: screenshot of the endpoint settings]*).
4. Start the receiver: `./scripts/bg.sh start receiver` (or `npm run receiver` in its own terminal).

## 4. Smoke test (one payment) and tunnel overhead

```sh
npm run create:smoke          # one test payment, phase "smoke" (left out of all statistics)
./scripts/bg.sh logs receiver # expect: "new  evt_… payment_intent.succeeded pi_…"
```

If no `new` line appears within a minute, check the destination's **Event deliveries** tab. 400 means
the signing secret is wrong; 404 means the URL path is wrong; 502 or a timeout means the
tunnel/port isn't reaching the receiver. Fix it before going further.

Then measure how much delay the tunnel or port forwarding adds:

```sh
./scripts/measure-tunnel.sh https://<your public URL> | tee logs/tunnel-latency.txt
```

## 5. Run the experiment

Times are UTC everywhere in the results. Write down what you do and when.

### Phase A: quiet hour (API calls with nothing happening)

```sh
./scripts/bg.sh start poller     # node poll.js --every 60 (or the cron line in crontab.example)
```

Then **wait at least 65 minutes without creating any payments.** `analyze.js` measures the quiet hour
as the 60 minutes right before the first side-by-side payment, and marks the number NOT VALID if the
poller wasn't running for that whole hour or any payment (including the smoke test) falls inside it.
To use a different window: `node analyze.js --quiet-from 2026-11-20T09:00:00Z --quiet-to 2026-11-20T10:00:00Z`.

### Phase B: side by side (delays, API calls during the test)

```sh
npm run create      # 100 payments, 5–30 s apart, about 30 minutes; Ctrl+C stops cleanly
```

From a phone, run it in the background so a closed tab doesn't stop it:
`nohup npm run create > logs/create.log 2>&1 &`, then check with `tail logs/create.log`.

**Keep the poller running for at least 60 minutes after the first payment.** The "during the test"
number is the poll calls in that hour, and is marked INCOMPLETE otherwise.

### Phase C: kill the endpoint

1. `./scripts/bg.sh stop poller`. It must not record outage payments.
2. `./scripts/bg.sh stop receiver` (or Ctrl+C; not `kill -9`), so its stop time is recorded.
   **Leave the tunnel / public port up.** Stripe then gets an error status from the tunnel instead
   of a connection failure; write down which you chose.
3. `./scripts/bg.sh start snapshot`: every 5 minutes it records which events Stripe itself says are
   still undelivered.
4. `npm run create:outage`: 5 payments, 5–30 s apart.
5. 📸 Dashboard → your destination → **Event deliveries**: screenshot the failed attempts and the
   next retry time. For each outage event, copy every attempt (time, status code or error) into
   `manual/dashboard-delivery-attempts.csv`, one row per attempt. No code can see these attempts.
6. Keep the receiver down for **at least 10 minutes**. That makes at least one retry arrive more than
   300 s after its event was created, which is what shows retries carry a fresh signature.
7. `./scripts/bg.sh start receiver`. **Don't press Resend**: a manual resend proves nothing about
   automatic retries. Stripe retries sandbox deliveries "three times over the course of a few
   hours", so leave everything running until every outage payment shows `new` in the receiver log
   or the Dashboard shows no retries left. Keep updating the CSV as attempts appear.
8. `./scripts/bg.sh stop snapshot`, then 📸 the Event deliveries tab once more.

### Phase D: analyze, before anything else

```sh
npm run analyze     # prints the summary, writes results/
```

### Phase E: the catch-up script on its own payment

This uses a dedicated payment, so it can't touch the measurements above (the script refuses any other phase):

```sh
npm run create:lost                                   # receiver running: wait for its "new" line
node simulate-lost-event.js | tee -a logs/reconcile-demo.log
node reconcile.js           | tee -a logs/reconcile-demo.log   # "recovered evt_… pi_…", "1 recovered"
node reconcile.js           | tee -a logs/reconcile-demo.log   # second run: "0 recovered"
npm run analyze                                      # adds the lost-event table
```

If a real outage payment never arrived, `node reconcile.js` recovers it too; the summary lists it
under *Reconciliation*. Optionally keep `./scripts/bg.sh start reconcile` running hourly afterwards.

### After the run

`results/` holds `summary.md`, `summary.json`, `delays.csv` (raw timestamps), `outage.csv`,
`lost-event.csv`, `api-calls-by-hour.csv` and `delay-chart.svg`. Commit `results/` and
`manual/dashboard-delivery-attempts.csv`. `payments.db` and `logs/` are git-ignored; commit them only
after checking they hold nothing you don't want public. Then stop everything
(`./scripts/bg.sh stop receiver`, …), disable or delete the test endpoint, and stop or delete the codespace.

## 6. Where each [FILL] comes from

| Article placeholder | Source |
|---|---|
| Medians, p95, worst (both methods), N | `results/summary.md`: *At a glance* |
| API calls/hour, quiet hour / during the test | *At a glance* rows; must not say NOT VALID or INCOMPLETE |
| Total poll and reconcile calls | *Stripe API requests* table |
| "X times faster at the median" | *Median ratio* |
| Versions | *Versions* (plus your tunnel tool's `--version`) |
| Tunnel delay | `logs/tunnel-latency.txt` |
| Raw request (headers + body start) | `npm run sample-request`: first request with a `Stripe/` User-Agent, signature and IDs shortened |
| Chart | `results/delay-chart.svg` |
| Surprises: missed payments, webhook before create returned, order | bullets under *At a glance* |
| Outage start/end and length | *Outage → Receiver down windows* |
| What Stripe recorded (status code / error), failed attempt times | Dashboard → your CSV → *Failed attempts (Dashboard)* column |
| Retry table (event, created, failed attempts, delivered by retry at, total delay) | *Outage* table and `outage.csv` |
| Order of retried events | *Retried events arrived in creation order* |
| Duplicates | *Same event ID delivered again* and *Same payment under two event IDs* |
| [CHECK] fresh `t=` on retries | *Deliveries that arrived more than 300 s after the event was created* (and STRIPE-CLAIMS.md) |
| Anything lost | *Every outage payment was eventually delivered by a webhook retry* |
| Reconcile recovery | *Lost-event demonstration* table and `logs/reconcile-demo.log` |
| Code I maintain | *Code lines* row |

How the delay is defined, for both methods: the moment the poller or receiver **wrote** the payment
ID to SQLite, minus the moment the create call returned a succeeded PaymentIntent (`Date.now()` on the
same machine). That start point is a stand-in for "payment succeeded": Stripe only gives whole
seconds. The receiver's request-arrival time is kept separately; the summary shows how long arrival
→ write took. Percentiles are nearest-rank.

## 7. What this experiment does and doesn't show

- The poller's `created` cursor **can miss payments that succeed late**. A payment that's still
  pending (for example, waiting on 3D Secure) is skipped; if a newer payment succeeds meanwhile, the
  cursor moves past it and it is never listed again. This is a flaw in polling *objects by creation
  time*, not in polling as such: polling the events list (what `reconcile.js` does) doesn't have it.
  The test card succeeds instantly, so **this run cannot show the miss**. Don't report it as measured.
- Webhook delays include the tunnel or port forwarding (measured in step 4) and the receiver's own work.
- Retry timing is sandbox timing (three retries over a few hours), not live mode (up to three days).

## Changes from the article's code, and why

| Article code | Problem | Fix here |
|---|---|---|
| `journal_mode = WAL` only | Three processes write one SQLite file; without a busy timeout a colliding write throws `SQLITE_BUSY` | `busy_timeout = 5000` |
| Insert event ID, *then* `markSeen` | If the work throws, the event counts as processed but the work never happened, and every retry is skipped | One transaction; on failure the receiver returns 500 so Stripe retries (tested) |
| Receiver creates `new Stripe(STRIPE_SECRET_KEY)` | Checking signatures only needs `whsec_`; an API key on the webhook server is unnecessary exposure | `Stripe.webhooks.constructEvent`, no API key |
| `app.listen(3000)` | Listens on every network interface | `127.0.0.1` by default (`HOST` to override) |
| One `payments` table for everything | Phases get mixed in the statistics | `phase` column; analysis per phase |
| Duplicates only printed | Not enough for the retry table, ordering or the `t=` check | `deliveries` table with signature `t=` and a duplicate flag |
| Outage times noted by hand | Easy to get wrong | `receiver_runs` records start/stop times |
| "Delete one event's rows" to show reconcile | Deleting a measured payment's rows corrupts the outage numbers | Dedicated `lost-event` payment; the script refuses others |
| No guard on the key | A live key would create real charges | Only `sk_test_` / `rk_test_` accepted |
| cron only | Not available everywhere | `--every` loops and `scripts/bg.sh` (same 60 s / hourly intervals) |

## Stripe claims

Every Stripe behaviour this repo or the article relies on is listed in **STRIPE-CLAIMS.md**, with the
exact quote and page it was checked against (2026-11-12), plus what could only be checked in the SDK
source and what couldn't be verified.

## Tests

```sh
npm test
```

- `test/unit.test.js`: percentiles, idempotent `markSeen`, `processEventOnce` rollback, test-key guard.
- `test/receiver.test.js`: valid signature, duplicate, wrong secret, edited body, re-formatted JSON,
  stale timestamp, missing header, charset header, other event types, failed work → 500 → retry succeeds.
- `test/analysis.test.js`: delay statistics, quiet-hour window (default, explicit, invalid),
  during-test completeness, same-payment duplicates, Dashboard CSV parsing, request-sample redaction.
- `test/pipeline.test.js`: create → poll → webhook → outage with pending snapshots and retries →
  forced duplicate → refusal to forget measured payments → lost-event → reconcile ×2 → analyze,
  against `test/support/fake-stripe.js`.
