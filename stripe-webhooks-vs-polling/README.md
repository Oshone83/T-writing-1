# Webhooks vs API polling, with Stripe payments

A small, working Node.js project that learns about new payments in two ways, **polling** and
**webhooks**, and then breaks things on purpose: it switches the webhook endpoint off, delivers an
event twice, and lets retries run out, to show why a webhook setup still needs a recovery job.

It runs entirely on your machine against **`fake-stripe.js`, a local simulation of Stripe**, so you
need no Stripe account, no keys and no public URL. The same code can also talk to real Stripe in
test mode (optional, see the end).

Companion code for the article in [`ARTICLE.md`](ARTICLE.md):
*I replaced payment polling with webhooks, then killed the endpoint: what I measured.*

## Quick start

You need [Node.js](https://nodejs.org) 22 or later.

```sh
cd stripe-webhooks-vs-polling
npm install
npm test        # 19 automated tests, about 10 seconds
npm run demo    # the whole story in five scenarios, about a minute
```

`npm run demo` prints each scenario and writes `demo-output/`: a transcript (`demo-output.md`), a
chart (`polling-vs-webhooks.svg`) and one raw webhook request (`sample-webhook-request.txt`).

## The idea in two paragraphs

An online shop needs to know when a payment succeeds, so it can ship the order. The payment happens
at Stripe, not in the shop's own code, so the shop has to find out somehow.

- **Polling** means the shop *asks* Stripe on a timer: "any new payments since last time?" It calls
  Stripe's API (a URL the shop sends HTTP requests to) every N seconds. Simple, but the answer is
  only as fresh as the last question, and when payments are rare, most questions get "nothing new".
- **A webhook** means Stripe *tells* the shop: when a payment succeeds, Stripe sends an HTTP POST
  request to a URL the shop registered (the **webhook endpoint**). The news arrives right away and
  costs the shop no requests. But now the shop must be reachable, must check the request really
  came from Stripe, and must cope when it was down or gets the same message twice. (With real
  Stripe you register the endpoint URL and choose the event types you want; the fake is simply
  told the URL.)

## What's in the project

| File | What it does |
|---|---|
| `fake-stripe.js` | **The simulation.** A small HTTP server that answers the Stripe API calls this project makes and POSTs signed webhook events, with retries. Run it alone (`npm run fake-stripe`) or let the demo start it |
| `create-payments.js` | Creates test payments through the Stripe API and records the moment the create call returned a succeeded payment |
| `poll.js` | **The polling version.** Every N seconds, lists payments created since the last run and records the succeeded ones |
| `receiver.js` | **The webhook version.** An Express server with one route, `POST /webhooks/stripe`: verifies the signature, ignores duplicates, records the payment, answers 200 |
| `reconcile.js` | **The safety net.** Reads Stripe's list of `payment_intent.succeeded` events and processes any the receiver never recorded |
| `report.js` | Prints each payment, which method found it, how long it took, API requests made and duplicates ignored |
| `demo.js` | Runs five scenarios end to end, checks the results, writes `demo-output/` |
| `lib/db.js` | The SQLite database (one file, `payments.db`) and the two helpers everything shares: `markSeen` and `processEventOnce` |
| `lib/stripe-client.js` | Creates the official Stripe SDK client, pointed at the fake or at real Stripe; refuses live keys |
| `lib/report.js`, `lib/chart.js`, `lib/stats.js`, `lib/loop.js`, `lib/env.js` | Delay calculations, the SVG chart, median, the "run every N seconds" timer, `.env` loading |
| `test/` | Tests for the receiver, the database helpers, the fake Stripe itself, and the whole demo |

## How the pieces talk to each other

```
                         ┌───────────────────────────────┐
  create-payments.js ───►│  Stripe API                    │   real Stripe, or fake-stripe.js
   POST /v1/payment_intents                               │   on http://127.0.0.1:12111
                         │                                │
  poll.js ──────────────►│  GET /v1/payment_intents       │   "anything new?" (every N seconds)
  reconcile.js ─────────►│  GET /v1/events                │   "which success events exist?"
                         └───────────────┬───────────────┘
                                         │ POST /webhooks/stripe   (when a payment succeeds;
                                         ▼                          retried if it fails)
                                   receiver.js  (http://127.0.0.1:3000)
                                         │
  create-payments.js, poll.js,           ▼
  receiver.js, reconcile.js ────►  payments.db (SQLite)
```

All the scripts use the **official Stripe Node.js SDK** (`stripe` on npm). When `STRIPE_API_BASE`
is set (as in `.env.example`), the SDK sends its requests to the fake instead of `api.stripe.com`;
no other code changes. The fake sends webhooks signed the same way Stripe does, so the receiver's
real signature check runs unchanged.

### The database, in one minute

SQLite stores the whole database in one file (`payments.db`), so several small processes can share
it without a database server. Six tables:

| Table | What a row means |
|---|---|
| `payments` | We created this payment, and it succeeded at `created_ms` |
| `seen` | Method `poll`, `webhook` or `reconcile` found this payment at `seen_ms`. **Delay = `seen_ms − created_ms`** |
| `processed_events` | We have processed this Stripe **event ID**. This is what makes duplicates harmless |
| `deliveries` | A webhook request arrived (duplicates included) |
| `api_calls` | Our code made one HTTP request to Stripe (to count what polling costs) |
| `state` | The poller's cursor |

## Polling in this project (`poll.js`)

Every N seconds (10 by default; a cron job would typically use 60), `pollOnce()`:

1. reads the **cursor**, a bookmark stored in the database: the Stripe `created` timestamp (whole
   seconds) of the newest *succeeded* payment it has seen (on the first run, one hour ago);
2. asks the API for payments created at or after the cursor: `GET /v1/payment_intents?created[gte]=…`;
3. records each `succeeded` one in `seen` with method `poll`;
4. moves the cursor to the newest `created` time it found.

Two costs follow directly. **Delay:** a payment that succeeds just after a poll waits almost a whole
interval. **Requests:** the poller asks even when nothing happened. And one design flaw (scenario 2):
because the cursor follows the time a payment was *created*, a payment that is created but succeeds
later can be skipped forever. Stripe: "If the payment requires additional actions, such as
authenticating with 3D Secure, the PaymentIntent has a status of requires_action"
([PaymentIntents lifecycle](https://docs.stripe.com/payments/paymentintents/lifecycle)). Polling
Stripe's *events* list instead, as `reconcile.js` does, doesn't have this flaw, because a success
event is created at the moment of success.

## Webhooks in this project (`receiver.js`)

Stripe sends a **webhook event**: a JSON object with an `id` (like `evt_…`), a `type` (here
`payment_intent.succeeded`) and the payment itself in `data.object`. For each request, the receiver:

1. **Reads the raw body.** It uses `express.raw`, not `express.json`, because the signature covers the
   exact bytes sent; parsing and re-encoding the JSON first would break the check.
2. **Verifies the signature.** Stripe signs each request with a secret only you and Stripe know (the
   `whsec_…` **signing secret**) and puts the result, plus a timestamp, in the `Stripe-Signature`
   header. `Stripe.webhooks.constructEvent()` recomputes the signature (an **HMAC**, a keyed hash) and
   rejects mismatches and timestamps older than 5 minutes. Anyone can POST to your URL; this is how
   you know it was Stripe.
3. **Processes each event ID once.** In one database **transaction** (all-or-nothing), it records the
   event ID in `processed_events` and the payment in `seen`. If the ID is already there, it's a
   **duplicate** and nothing happens. If the work fails, nothing is recorded and the receiver answers
   500, so Stripe will retry and the retry can succeed. Handling a repeated message safely like this
   is called being **idempotent**.
4. **Answers 200 quickly.** Any 2xx tells Stripe "delivered". Any other status, a timeout, or no answer
   at all counts as a failed delivery, and Stripe **retries** the same event (same event ID) later.

### Why the same event can arrive twice

A sender can't always tell whether a delivery worked: if the receiver processed an event but its 200
response was lost or too slow, the sender sees a failure and tries again. Stripe's docs say endpoints
"might occasionally receive the same event more than once". So the receiver remembers every event ID
it has processed (`processed_events`) and skips repeats. The work itself is also safe to repeat here:
`seen` records each payment ID once per method.

### Reconciliation: catching what webhooks missed

Retries stop eventually. If the endpoint is down longer than that (or deleted, or a bug answered 200
without recording anything), the event never arrives and nothing complains. **Reconciliation** means
periodically comparing your records with the provider's. `reconcile.js` lists Stripe's recent
`payment_intent.succeeded` events and runs any it hasn't processed through the same
`processEventOnce` as the receiver, so it recovers missed events without ever processing one twice.

## The five scenarios (`npm run demo`)

| # | Scenario | What happens | What it shows |
|---|---|---|---|
| 1 | Side by side | Poller and receiver run together; 10 payments | Polling delay ranges from 0 to one interval; webhooks arrive in milliseconds; the poller pays for empty polls |
| 2 | Late success | A 3-D Secure payment succeeds after a newer payment moved the cursor | The poller never sees it; the webhook does |
| 3 | Endpoint down | Receiver stopped, 3 payments, receiver back 2.5 s after them | Deliveries fail, automatic retries deliver everything once it's back; outage becomes delay |
| 4 | Duplicate | The same event is delivered twice | The event-ID table turns the second delivery into a no-op |
| 5 | Retries run out | Receiver down longer than the whole retry schedule | The app silently misses the payments; `reconcile.js` finds them in the events list; a second run changes nothing |

Each scenario checks its own outcome and the demo fails if any check fails (`npm test` runs it too,
faster). A recent run's transcript is committed in `demo-output/demo-output.md`.

## Reproduce it by hand (four terminals)

This runs each component as its own process, so you can watch the logs and kill things yourself.

```sh
cp .env.example .env          # works as-is with the fake Stripe; no real keys involved
npm run reset                 # optional: start with an empty database
```

| Terminal | Command | What you'll see |
|---|---|---|
| 1 | `npm run fake-stripe` | Every delivery attempt: `HTTP 200`, `connection refused; next retry in 10 s`, `giving up` |
| 2 | `npm run receiver` | `new evt_… payment_intent.succeeded pi_…` (add `LOG_REQUESTS=1` in front to print each raw request) |
| 3 | `npm run poll` | `poll: 1 new payment(s)` every 10 s, often `0 new` |
| 4 | `npm run pay` | Three test payments, 1–3 s apart |

Then, in terminal 4:

```sh
npm run report                # each payment: poll delay vs webhook delay, API requests, duplicates
```

**Kill the endpoint.** Press Ctrl+C in terminal 2, run `npm run pay` in terminal 4, and watch
terminal 1 log failed attempts. Start `npm run receiver` again within 100 s (the fake waits 10, 30
and 60 s between attempts, so it retries 10 s, 40 s and 100 s after the first one) and a retry delivers. `npm run report` shows the bigger webhook delays.

**Let the retries run out.** Stop the receiver, `npm run pay`, wait until terminal 1 says
`giving up` (100 s after the payment), start the receiver again. `npm run report` shows webhook
`never` for those payments. Now run `npm run reconcile`: it prints `recovered evt_…`. Run it again:
`0 recovered`.

**Send a duplicate.** Copy an `evt_sim_…` ID from terminal 2, then:
`curl -X POST http://127.0.0.1:12111/_sim/events/evt_sim_000002/resend` (with your ID). Terminal 2
prints `duplicate evt_sim_…`.

**Miss a late success with polling.**

```sh
node create-payments.js --payment-method pm_card_threeDSecure2Required   # prints pi_sim_… requires_action
npm run pay -- --count 1                                                # a newer payment moves the cursor
# wait for the next poll in terminal 3, then let the first payment "finish 3-D Secure":
curl -X POST http://127.0.0.1:12111/_sim/payment_intents/pi_sim_XXXXXX/succeed
npm run report                                                          # that payment: poll never, webhook yes
```

The `/_sim/…` URLs exist only in the fake. They stand in for things that happen outside your code at
real Stripe (a customer finishing 3-D Secure; Stripe sending an event twice).

## What the results demonstrate, and what they don't

They demonstrate **mechanisms**, with your own code doing the work:

- polling delay is bounded by the poll interval, and polling costs requests even when idle;
- webhooks arrive as the event happens and cost no requests;
- a down endpoint turns into *delay* while retries last, and into *silently missing data* after;
- duplicate deliveries are harmless because the receiver remembers event IDs (and the work, recording
  a payment ID, is itself safe to repeat);
- a poller that follows `created` can miss late successes;
- a reconcile job over the events list recovers what the webhook path missed, without double-processing.

## Limits of the simulation

- **It is not Stripe.** `fake-stripe.js` imitates only the calls this project makes, with the same
  request and response shapes and the same signature scheme. Real Stripe has many more fields,
  headers and behaviours.
- **The numbers aren't real-world measurements.** Everything runs on one machine, so webhook delays
  of ~0.02 s have no internet in them. In the demo the poller runs every 5 s, and the fake waits 1,
  then 2, then 4 s between delivery attempts before giving up, so it finishes in a minute. A real cron poller often runs every 60 s, and real Stripe retries over hours
  or days (below).
- **Ordering and timing are simplified.** The fake delivers in order on a fixed schedule. Real
  Stripe doesn't guarantee order.
- **Stripe's own duplicate cases are only partly modelled.** The fake re-sends the same event ID.
  Stripe also documents rare cases of two different event objects for the same payment, which an
  event-ID check alone doesn't catch (this project's `seen` table, keyed by payment ID, does).
- **Delay is measured from the moment the create call returned**, since that's when our code learns
  the payment succeeded.

## What real Stripe does (checked against docs.stripe.com, November 2026)

| Topic | Stripe's documentation says |
|---|---|
| Retries, live mode | "Stripe attempts to deliver events to your destination for up to three days with an exponential back off in live mode." ([webhooks](https://docs.stripe.com/webhooks)) |
| Retries, test mode | "We retry event deliveries created in a sandbox three times over the course of a few hours." (same page) |
| Signatures | "Stripe signs every webhook event by including a signature in the Stripe-Signature header." Each retry gets "a new signature and timestamp". (same page) |
| Signature age | "Our libraries have a default tolerance of 5 minutes between the timestamp and the current time." (same page) |
| Duplicates | "Webhook endpoints might occasionally receive the same event more than once." and "In some cases, two separate Event objects are generated and sent." (same page) |
| Order | "Stripe doesn't guarantee the delivery of events in the order that they're generated." (same page) |
| Reply fast | "Quickly returns a successful status code (2xx) before any complex logic that might cause a timeout." (same page) |
| Events history | "List events, going back up to 30 days." ([list events](https://docs.stripe.com/api/events/list)) |
| Catching up | Use the List Events API with `delivery_success=false` to find undelivered events ([process undelivered events](https://docs.stripe.com/webhooks/process-undelivered-events)) |
| Late success | "If the payment requires additional actions, such as authenticating with 3D Secure, the PaymentIntent has a status of requires_action." ([PaymentIntents lifecycle](https://docs.stripe.com/payments/paymentintents/lifecycle)) |
| Test cards | Use test PaymentMethods such as `pm_card_visa`; `pm_card_threeDSecure2Required` is listed too ([testing](https://docs.stripe.com/testing)) |

## Optional: real Stripe in test mode

Not needed for anything above, and **not tested by the author against a real account**. It uses the
[Stripe CLI](https://docs.stripe.com/stripe-cli) to forward real test-mode webhooks to your
localhost, so you don't need a public URL.

1. In the Stripe Dashboard, switch on **Test mode** and copy your **Secret key** (`sk_test_…`)
   from Developers → API keys. The scripts refuse live (`sk_live_…`) keys.
2. In `.env`: set `STRIPE_SECRET_KEY` to that key and **delete the `STRIPE_API_BASE` line**.
3. `stripe login`, then `stripe listen --forward-to localhost:3000/webhooks/stripe`. It prints a
   `whsec_…` secret: put it in `.env` as `STRIPE_WEBHOOK_SECRET`.
4. Run `npm run receiver`, `npm run poll`, `npm run pay`, `npm run report` and `npm run reconcile`
   as above.

The outage scenarios depend on Stripe's retry schedule (hours in test mode), and whether
`stripe listen` retries like a registered endpoint isn't documented on the pages above, so use the
simulation for those. Never commit `.env`; it's in `.gitignore`.

## Tests

```sh
npm test
```

- `test/receiver.test.js`: valid signature, wrong secret, edited body, re-formatted JSON, timestamp
  older than 5 minutes, missing header, duplicate delivery, failed work → 500 → retry succeeds.
- `test/unit.test.js`: the database helpers (including the rollback), the test-key guard, the
  report's delay maths, the timer.
- `test/fake-stripe.test.js`: the fake behaves like the Stripe features we rely on (key check,
  signed deliveries, retries reusing the event ID, giving up, the undelivered-events filter, resend,
  the 3-D Secure flow). Signatures are verified with the Stripe SDK.
- `test/demo.test.js`: all five scenarios, with faster timings; every check must pass.
