# Stripe payments: polling vs webhooks, an outage, and the poll I kept

Companion code for *I replaced payment polling with webhooks, then killed the endpoint: what I measured*.

It measures, per payment, how long a **60-second poller** and a **webhook** take to learn about a new
Stripe payment. It then switches the webhook endpoint off to watch Stripe's retries, and recovers a
lost event with an hourly reconcile job. **Stripe test mode only:** every script refuses live keys.

## Status: what is verified, simulated, and still to be measured

| | Status |
|---|---|
| **Code behaviour** | Verified by 30 automated tests and a phone-flow self-test. Signatures use Stripe's own SDK code; SQLite, Express and the scripts run for real. |
| **Real Stripe API** | All four API-calling scripts reached `api.stripe.com` and handled its real 401 (invalid key) correctly. No real payment has been made. |
| **Simulated results** | `demo-results/` only, from a local fake Stripe. **Not Stripe data; never publish.** |
| **Real measurements** | **None yet.** `ARTICLE-RESULTS.md` lists every article value as [PENDING]. After the live run, `./exp analyze` fills them in at `results/article-values.md`. |
| **Stripe claims** | Checked against docs.stripe.com, with quotes, in `STRIPE-CLAIMS.md`. |

## Contents

```
create-payments.js ──► Stripe ──POST per event──► receiver.js ──┐
                         ▲                                       ├─► payments.db (SQLite)
poll.js  (every 60 s) ───┤ GET /v1/payment_intents               │
reconcile.js (hourly) ───┤ GET /v1/events                        │
snapshot-pending.js ─────┘ GET /v1/events?delivery_success=false ┘
                                       analyze.js ──► results/ (summary, article values, CSVs, chart)
```

| Path | What it is |
|---|---|
| `exp` | **One command per step** (`./exp help`). Guards stop mistakes; every step goes to `logs/timeline.log` |
| `create-payments.js` | Test PaymentIntents (`pm_card_visa`), 5–30 s apart, tagged `smoke` / `side-by-side` / `outage` / `lost-event` |
| `poll.js` | The poller: PaymentIntents created since a cursor, every 60 s |
| `receiver.js` | Webhook route on 127.0.0.1: raw body, signature check, event-ID dedupe, every delivery logged |
| `reconcile.js` | Catch-up job: any `payment_intent.succeeded` event the app never recorded |
| `snapshot-pending.js` | During the outage: Stripe's own list of undelivered events |
| `simulate-lost-event.js` | Forgets one delivered event so reconcile can recover it (only `lost-event` payments) |
| `analyze.js` | Numbers, raw-timestamp CSVs, chart, article values |
| `ARTICLE-RESULTS.md` | Every article [FILL] in order, all [PENDING] until the real run |
| `STRIPE-CLAIMS.md` | Each Stripe claim with the documentation quote it was checked against |
| `evidence/` | Where screenshots go and where every other piece of evidence lands |
| `manual/dashboard-delivery-attempts.csv` | You copy failed delivery attempts here from the Dashboard |
| `results/` | Real results (empty until the live run) |
| `demo-results/` | Simulated demo output, labelled as such |
| `scripts/` | `bg.sh` (background processes), `doctor.js`, `exp-status.js`, `measure-tunnel.sh`, `sample-request.js`, `article-template.js`, `demo.js` |
| `test/` | `npm test` (30 tests) and `npm run selftest` (phone flow, ~3 min) |

---

# Runbook: GitHub Codespaces from a phone

Everything runs in one Codespace, so all timestamps share one clock. Total time is about **5–7
hours**, mostly waiting. Use your phone's browser (desktop-site mode helps the editor). Codespaces
itself wasn't tested by the author; `./exp doctor` and `./exp smoke` are what prove your setup works.

## Step 1: GitHub settings (once, about 3 min)

On github.com: profile picture → **Settings → Codespaces**:

1. **Default idle timeout**: set it to the maximum offered (GitHub documents 240 minutes). The
   Codespace stops after that long without you touching it, and the experiment's processes stop
   with it. You'll check in every 3 hours or less.
2. **Codespaces secrets → New secret**:
   - Name: `STRIPE_SECRET_KEY`
   - Value: a Stripe **test-mode** key (step 2 says how to get one)
   - Repository access: this repository

   The key then reaches the Codespace as an environment variable and never sits in a file. If you
   skip this, use `./exp set-api-key` later.
3. **Settings → Billing**: check your free Codespaces hours. A 2-core machine for ~7 hours fits most free allowances.

## Step 2: Stripe test-mode key (about 3 min)

In the Stripe Dashboard, switch on **Test mode** (or open a sandbox), then **Developers → API keys**:

- Best: **Create restricted key** with *PaymentIntents: Write* and *Events: Read* (`rk_test_…`).
- Or copy the standard **Secret key** (`sk_test_…`).

Never paste a key into chat, a commit or a screenshot. If one leaks, roll it on the same page.

## Step 3: Create the Codespace (about 5 min)

1. Open the repository on github.com → branch `claude/stripe-webhook-polling-test-p6dx3f` →
   **Code → Codespaces → Create codespace on claude/stripe-webhook-polling-test-p6dx3f**.
   The repo's `.devcontainer` gives Node 22 and runs `npm install` automatically.
2. When the editor opens, open a terminal (☰ menu → **Terminal → New Terminal**) and run:

```sh
cd stripe-webhooks-vs-polling
npm test                      # expect: pass 30, fail 0
STRIPE_WEBHOOK_SECRET=whsec_placeholder_for_port ./exp receiver   # starts port 3000 (real secret comes in step 5)
./exp url                     # prints the public URL to register
```

3. **Ports** panel (bottom of the editor; ☰ → View → Ports if hidden): long-press port **3000** →
   **Port Visibility → Public**. Without this, Stripe can't reach the receiver.

## Step 4: Register the webhook in Stripe (about 3 min)

Dashboard, **Test mode**: **Workbench → Webhooks → Create an event destination**

| Setting | Choose |
|---|---|
| Events from | **Your account** |
| Payload format | **Snapshot** (not the default Thin: the receiver reads `event.data.object`) |
| API version | as offered |
| Events | **`payment_intent.succeeded`** only |
| Destination type | **Webhook endpoint** |
| Endpoint URL | the `Register in Stripe:` line from `./exp url` (ends in `/webhooks/stripe`) |

Then on the destination's page: **Reveal secret**, copy the `whsec_…` value, and take the
`endpoint-settings` screenshot **with the secret hidden** (see `evidence/README.md`).

## Step 5: Connect and smoke-test (about 5 min)

```sh
./exp set-webhook-secret      # paste the whsec_… value (hidden); restarts the receiver with it
./exp doctor                  # every line should start with ✓
./exp smoke                   # one real test payment; must end with "received by webhook"
./exp tunnel                  # what the public URL adds → logs/tunnel-latency.txt
```

If `smoke` fails, open the destination's **Event deliveries** in the Dashboard: 400 = wrong secret;
404 = URL must end in `/webhooks/stripe`; 502/timeout = port 3000 not Public or receiver down; no
delivery at all = wrong event type or Thin payload. If deliveries return 502 while the receiver runs,
restart it listening on all interfaces (acceptable inside a Codespace):
`./scripts/bg.sh stop receiver && HOST=0.0.0.0 ./scripts/bg.sh start receiver`.

## Step 6 (phase A): the quiet hour (65 min)

```sh
./exp quiet                   # starts the 60-second poller; prints when payments may start
```

Create **no** payments for 65 minutes, and touch the Codespace once in a while (`./exp status`).
The quiet-hour figure is the 60 minutes right before the first side-by-side payment; `./exp
payments` refuses to start earlier.

## Step 7 (phase B): side by side (about 90 min)

```sh
./exp payments                # 100 payments, 5–30 s apart, in the background (~30 min)
./exp status                  # progress: created / seen by poll / seen by webhook
```

Leave the poller running **60 minutes after the first payment**; `./exp outage-start` refuses to
start earlier, so the "API calls during the test" number is complete.

## Step 8 (phase C): kill the endpoint (10 min to a few hours)

```sh
./exp outage-start            # stops poller + receiver (public URL stays up), starts Stripe pending
                              # snapshots, creates 5 outage payments
```

Now, in the Dashboard: **Event deliveries** → screenshot `outage-deliveries-failed` and copy every
failed attempt into `manual/dashboard-delivery-attempts.csv` (open it in the editor; one row per
attempt: `event_id,attempted_at_utc,result,next_retry_at_utc,notes`).

After **at least 10 minutes** (`./exp outage-end` refuses earlier, so at least one retry arrives
more than 300 s after its event and proves the fresh signature):

```sh
./exp outage-end              # receiver back up. Do NOT press Resend in the Dashboard
./exp outage-status           # repeat every hour or so; Stripe retries sandbox events 3 times over a few hours
```

Keep adding attempts to the CSV as they appear. When `outage-status` shows `undelivered: 0`:

```sh
./exp outage-finish           # stops the snapshots
```

Take the `outage-deliveries-final` screenshot. If the Dashboard shows no retries left but a payment
never arrived, run `./exp outage-finish --force`: that is a lost payment, and reconcile recovers it next.

## Step 9 (phases D and E): analyze, then the catch-up demo (about 5 min)

```sh
./exp analyze                 # results/ first, before anything else touches the data
./exp lost-event              # dedicated payment → forgotten → reconcile recovers it → second run recovers 0
```

`lost-event` re-runs the analysis. Upload the three screenshots to `evidence/screenshots/` (Explorer
→ long-press the folder → Upload…), then run `./exp analyze` once more so they're linked.

## Step 10: commit the evidence and clean up

```sh
git status                    # .env must NOT be listed
git add results manual evidence
git add -f logs/timeline.log logs/tunnel-latency.txt logs/reconcile-demo.log
git commit -m "Real test-mode results" && git push
./exp stop-all
```

Then in Stripe disable or delete the test destination, and on GitHub stop or delete the Codespace.
**Article values** are now in `results/article-values.md`; anything still [PENDING] says where it comes from.

## Running on a computer instead

Same commands. Instead of Codespaces port forwarding, run a tunnel and tell `exp` its URL:

```sh
cloudflared tunnel --url http://localhost:3000       # free URLs change on restart: don't restart it mid-run
./exp set-url https://<random>.trycloudflare.com "cloudflared $(cloudflared --version | awk '{print $3}')"
./exp set-api-key                                     # if not using an environment variable
```

Keep the computer awake (macOS `caffeinate -dimsu`; Linux `systemd-inhibit --what=sleep:idle sleep infinity`;
Windows: never sleep when plugged in, and use WSL). `crontab.example` has cron lines if you prefer cron to `./exp`.

---

## What the numbers mean

- **Delay**, for both methods: the moment the poller or receiver **wrote** the payment ID to SQLite,
  minus the moment the create call returned a succeeded PaymentIntent (`Date.now()`, same machine).
  That start point stands in for "payment succeeded": Stripe only gives whole seconds. The receiver's
  arrival time is kept too; the summary shows arrival → write takes milliseconds.
- **Percentiles** are nearest-rank, so p95 is always a delay that happened. All times are UTC.
- **API calls** count every HTTP attempt (list pages and the SDK's automatic retries included), per script.
- The summary marks numbers **NOT VALID** / **INCOMPLETE** when a phase didn't meet its timing
  rule, and shows the poll interval actually measured (should be 60 s).
- Webhook delays include the tunnel or port forwarding (measured by `./exp tunnel`).
- Retry timing is **sandbox** timing ("three times over the course of a few hours"), not live mode
  ("up to three days with an exponential back off").

### What this run cannot show

The poller's `created` cursor misses payments that succeed late. A payment still pending (for
example, waiting on 3D Secure) is skipped; if a newer payment succeeds meanwhile, the cursor moves
past it and it is never listed again. That is a flaw in polling *objects by creation time*, not in
polling itself: polling the events list (what `reconcile.js` does) avoids it. `pm_card_visa`
succeeds instantly, so **this run cannot demonstrate the miss**. Don't report it as measured.

## Changes from the article's code, and why

| Article code | Problem | Fix here |
|---|---|---|
| `journal_mode = WAL` only | Several processes write one SQLite file; without a busy timeout a colliding write fails at once | `busy_timeout = 5000` |
| Insert event ID, *then* do the work | If the work throws, the event counts as processed but nothing happened, and every retry is skipped | One transaction; on failure the receiver returns 500 so Stripe retries (tested) |
| Receiver creates `new Stripe(STRIPE_SECRET_KEY)` | Checking signatures needs only `whsec_` | `Stripe.webhooks.constructEvent`, no API key on the receiver |
| `app.listen(3000)` | Listens on every network interface | `127.0.0.1` by default (`HOST` overrides) |
| One `payments` table for everything | Phases mix in the statistics | `phase` column; smoke / outage / lost-event payments excluded from the delay statistics |
| Duplicates only printed | Not enough for the retry table, ordering or the `t=` check | `deliveries` table with signature `t=` and a duplicate flag |
| Outage times noted by hand | Easy to get wrong | `receiver_runs` + `logs/timeline.log` |
| "Delete one event's rows" to show reconcile | Deleting a measured payment corrupts the outage numbers | Dedicated `lost-event` payment; the script refuses others |
| No guard on the key | A live key would make real charges | Only `sk_test_` / `rk_test_`, never the `.env.example` placeholders |
| cron only | Not available in Codespaces / Windows | `--every` loops and `scripts/bg.sh`, same 60 s / hourly intervals |

## Tests

```sh
npm test            # 30 tests, ~5 s
npm run demo        # whole experiment against a fake Stripe, ~2 min → demo-results/ (SIMULATED)
npm run selftest    # every ./exp step in runbook order against a fake Stripe, ~3 min, temp data dir
```

- `unit`: statistics, idempotent writes, transaction rollback, test-key guard.
- `receiver`: valid/invalid/edited/re-serialized/stale/missing signatures, duplicates, charset, failed work → 500 → retry succeeds.
- `analysis`: delay statistics, quiet-hour window rules, during-test completeness, same-payment duplicates, Dashboard CSV, request redaction.
- `article`: `ARTICLE-RESULTS.md` matches its generator (no invented numbers), article values fill from data, placeholder keys refused, simulated data refused in `results/`.
- `pipeline`: create → poll → webhook → outage with pending snapshots and retries → duplicate → refusal to forget measured payments → lost event → reconcile ×2 → analyze.

The demo and self-test fail if they touch the real `payments.db`, `logs/`, `results/`, `run/` or `.env`.

### Behind an HTTPS proxy

In a sandbox whose only internet access is an HTTPS proxy (like the Claude cloud session this was
built in), Node's default HTTPS client ignores the proxy. Run the scripts with
`STRIPE_HTTP_CLIENT=fetch NODE_USE_ENV_PROXY=1` (Node ≥ 22.21). Codespaces and normal computers don't need this.
