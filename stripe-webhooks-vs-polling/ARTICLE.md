<!--
Draft notes (delete before publishing):
- Every number below is from the SIMULATED run committed in demo-output/demo-output.md. Re-running
  `npm run demo` overwrites that file with new numbers (payment gaps are random); keep the committed
  run, or update the numbers here to match a new one.
- Every code block is copied verbatim from the file named above it. If you edit the code, re-copy it.
- Replace [REPO LINK] with the repository URL, and add the chart image (demo-output/polling-vs-webhooks.svg).
- The story is first person. Keep it true: this describes building this project, not a production system.
- The project has NOT been run against a real Stripe account. Don't claim otherwise.
-->

# I replaced payment polling with webhooks, then killed the endpoint: what I learned

Most "webhooks vs polling" explanations stop at "webhooks are faster and cheaper". I wanted to see
what happens when the webhook side breaks. So I built a small payment app that finds out about
payments both ways: first with a poller that asks Stripe "anything new?" on a timer, then with a
webhook receiver. Then I switched the receiver off on purpose.

This is a walkthrough of that code, file by file. Everything runs against a small local simulation
of Stripe, so the failures are easy to reproduce. The app code uses the official Stripe Node.js SDK
and checks webhook signatures with Stripe's own verification function; only the server on the other
end is fake. All timings below come from that simulation, compressed so the whole demo runs in
about a minute. They show *how* each approach behaves, not how fast real Stripe is. I haven't run
this project against a real Stripe account.

Code: [REPO LINK].

## Two ways to find out about a payment

When a customer pays, the payment happens at Stripe, not in my code. My app still has to find out,
so it can ship the order.

- **Polling (API requests on a timer).** An *API request* is an HTTP request my code sends to Stripe,
  such as "list the payments created since 10:00". *Polling* means sending that request again and
  again on a schedule and looking for anything new. My app decides when to ask.
- **Webhooks (Stripe calls me).** A *webhook* is an HTTP POST request that Stripe sends to a URL I
  own, called the *webhook endpoint*, when something happens. With real Stripe, you register that
  URL and choose which *event types* you want, here `payment_intent.succeeded`. Each request carries
  an *event*: a JSON object with its own ID (`evt_…`), its type, and the payment it's about. Stripe
  decides when to send.

## What's real and what's simulated

| Real (this code would make the same calls against Stripe) | Simulated (`fake-stripe.js`) |
|---|---|
| The Stripe SDK calls: create a payment, list payments, list events | The server answering those calls, on my machine |
| Signature checking with `Stripe.webhooks.constructEvent` | The signing: the fake signs with the Stripe SDK's test helper, in the same header format |
| The receiver, poller and reconcile job | The retry schedule: the fake waits 1, then 2, then 4 seconds between attempts, then gives up |
| | A payment that needs 3-D Secure, and the customer completing it |
| | Re-sending an event to create a duplicate |

Where I describe what real Stripe does, I quote its documentation and link it at the end.

## What I learned, at a glance

| | Polling | Webhooks |
|---|---|---|
| How the app finds out | It asks on a timer | Stripe POSTs to my endpoint |
| Delay | Between 0 and one poll interval | As soon as the event is sent (plus network) |
| Requests from my side | One per poll, including the empty ones | None |
| Simulated run, 10 payments, polling every 5 s | median 2.44 s, worst 4.98 s; 3 polls | median 0.02 s, worst 0.04 s; 0 requests |
| My side is down for a while | Nothing to receive; when the poller restarts, it catches up from its cursor | Deliveries fail; retries deliver them later |
| My side is down longer than the retries | Same as above | Payments silently missed, unless something reconciles |
| A payment that succeeds late | My poller missed it (below) | Delivered when it succeeded |

The webhook figure has no internet in it, because everything ran on one machine. The polling figure
scales with the interval: with a poller that runs once a minute, expect delays of up to a minute.

## The project, and how to run it

```
stripe-webhooks-vs-polling/
  create-payments.js   creates test payments
  poll.js              the polling version
  receiver.js          the webhook version (an Express server)
  reconcile.js         the catch-up job that recovers missed events
  fake-stripe.js       the simulation of Stripe
  report.js            prints, per payment, which method found it and how fast
  demo.js              runs the five scenarios in this article and checks each outcome
  lib/db.js            the SQLite database and the two helpers everything shares
  lib/stripe-client.js creates the Stripe SDK client (pointed at the fake or at Stripe)
  lib/loop.js          "run this every N seconds"
  lib/report.js, lib/chart.js, lib/stats.js, lib/env.js
  test/                19 automated tests
  demo-output/         the simulated run quoted in this article
```

You need Node.js 22 or later:

```sh
cd stripe-webhooks-vs-polling
npm install
npm test          # 19 tests
npm run demo      # five scenarios, about a minute; writes demo-output/
```

To run the pieces by hand, each in its own terminal: `cp .env.example .env` (the values work as-is
with the fake), then `npm run fake-stripe`, `npm run receiver`, `npm run poll` and `npm run pay`.
Afterwards, `npm run report` and `npm run reconcile`. The README has the step-by-step versions of
each failure.

## Step 1: one database for everything (`lib/db.js`)

Every script writes to one SQLite database. SQLite keeps the whole database in a single file
(`payments.db`), so small processes can share it without a database server.

From `lib/db.js`:

```js
export function openDb(file = process.env.DB_PATH || path.join(PROJECT_DIR, 'payments.db')) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL'); // lets several processes read and write the same file
  db.pragma('busy_timeout = 5000'); // wait (up to 5 s) instead of failing when another process is writing

  db.exec(`
    -- Payments we created, and the moment our app considered them paid.
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      created_ms INTEGER NOT NULL,
      phase TEXT NOT NULL DEFAULT 'manual'        -- which demo scenario created it
    );
    -- "The app knows about this payment": one row per payment per method that found it.
    CREATE TABLE IF NOT EXISTS seen (
      id TEXT, method TEXT, seen_ms INTEGER,      -- method: 'poll', 'webhook' or 'reconcile'
      PRIMARY KEY (id, method)
    );
    -- Every event ID we have processed. This table is what makes duplicate deliveries harmless.
    CREATE TABLE IF NOT EXISTS processed_events (
      event_id TEXT PRIMARY KEY, received_ms INTEGER, source TEXT
    );
    -- Every webhook delivery that passed the signature check, duplicates included.
    CREATE TABLE IF NOT EXISTS deliveries (
      event_id TEXT, event_type TEXT, payment_id TEXT, received_ms INTEGER, duplicate INTEGER
    );
    -- One row per HTTP request our code made to Stripe, so polling's cost can be counted.
    CREATE TABLE IF NOT EXISTS api_calls (source TEXT, at_ms INTEGER);
    -- Small key/value store; the poller keeps its cursor here.
    CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT);
  `);
  return db;
}
```

**What it does.** It opens (or creates) the database and makes sure six tables exist. The two
`pragma` lines let the poller, receiver and reconcile job write to the same file at once: *WAL* mode
allows readers and a writer at the same time, and the busy timeout makes a second writer wait its
turn for up to 5 seconds instead of failing.

**Why it's needed.** The two tables that matter most for the comparison are `payments`, which records
when each payment succeeded, and `seen`, which records when each method found it. A payment's delay
is `seen_ms − created_ms`. `seen` has one row per payment *per method*, so the same payment can be
found by the poller and the webhook without the two overwriting each other.

The two helpers everything else uses are next.

From `lib/db.js`:

```js
export function makeHelpers(db) {
  const seenStmt = db.prepare('INSERT OR IGNORE INTO seen (id, method, seen_ms) VALUES (?, ?, ?)');
  const rememberStmt = db.prepare(
    'INSERT OR IGNORE INTO processed_events (event_id, received_ms, source) VALUES (?, ?, ?)'
  );
  const apiCallStmt = db.prepare('INSERT INTO api_calls (source, at_ms) VALUES (?, ?)');

  // Record that `method` found payment `id`. A second call for the same pair does nothing.
  const markSeen = (id, method, at = Date.now()) => seenStmt.run(id, method, at);

  // Run `work` exactly once per event ID, in one transaction with recording the ID.
  // If `work` throws, the ID is NOT recorded, so a later retry of the same event can still succeed.
  // Returns true if the event was new (work ran), false if it was a duplicate.
  const processEventOnce = db.transaction((eventId, source, work) => {
    const isNew = rememberStmt.run(eventId, Date.now(), source).changes === 1;
    if (isNew) work();
    return isNew;
  });

  const logApiCall = (source) => apiCallStmt.run(source, Date.now());
  return { markSeen, processEventOnce, logApiCall };
}
```

**`markSeen`** writes "method X found payment Y at time Z". `INSERT OR IGNORE` means a second insert
with the same primary key (same payment, same method) is silently skipped. So a payment can be
"found" twice, and only the first time counts.

**`processEventOnce`** is the heart of duplicate protection, and both the receiver and the reconcile
job use it. It tries to insert the event ID into `processed_events`. If that inserts a row
(`changes === 1`), the event is new and it runs `work`. If the ID was already there, the insert is
ignored, `work` doesn't run, and it returns `false`: a duplicate.

`db.transaction(...)` wraps all of that in a database *transaction*: either everything inside
happens, or nothing does. If `work` throws an error, the event-ID insert is rolled back too. That
matters, because otherwise a failed attempt would leave the ID behind, and every retry of that event
would be skipped as a "duplicate" even though nothing was ever processed.

**`logApiCall`** adds one row per HTTP request to Stripe, so the cost of polling can be counted.

## Step 2: the Stripe client (`lib/stripe-client.js`)

From `lib/stripe-client.js`:

```js
export function createStripe({ key = process.env.STRIPE_SECRET_KEY, apiBase = process.env.STRIPE_API_BASE, onRequest } = {}) {
  assertTestKey(key);
  const opts = {};
  if (apiBase) {
    const u = new URL(apiBase);
    Object.assign(opts, { host: u.hostname, port: Number(u.port), protocol: u.protocol.replace(':', '') });
  }
  const stripe = new Stripe(key, opts);
  if (onRequest) stripe.on('request', () => onRequest());
  return stripe;
}
```

**What it does.** It creates the official Stripe SDK client. Three details:

- `assertTestKey` throws unless the key starts with `sk_test_` or `rk_test_`, so a live key pasted by
  mistake can never create a real charge.
- If `STRIPE_API_BASE` is set (it is in `.env.example`, pointing at `http://127.0.0.1:12111`), the SDK
  sends its requests to the fake Stripe instead of `api.stripe.com`. Nothing else in the app changes;
  that's what lets the same code run against the simulation.
- `stripe.on('request', …)` is an SDK hook that fires for every HTTP request the SDK sends, including
  extra pages and automatic retries. The poller passes `() => logApiCall('poll')`, which is how the
  demo counts what polling costs.

## Step 3: creating a payment (`create-payments.js`)

Stripe calls a payment a *PaymentIntent*. This function creates one and confirms it in a single call.

From `create-payments.js`:

```js
export async function createPayment({ db, stripe, phase = 'manual', paymentMethod = 'pm_card_visa' }) {
  const pi = await stripe.paymentIntents.create({
    amount: 1000,
    currency: 'usd',
    payment_method: paymentMethod,
    confirm: true,
    automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
  });
  // "Payment created" = the moment the create call returned a succeeded payment. Delays are measured
  // from here. A payment still waiting for 3-D Secure isn't paid yet, so it isn't recorded.
  if (pi.status === 'succeeded') {
    db.prepare('INSERT INTO payments (id, created_ms, phase) VALUES (?, ?, ?)').run(pi.id, Date.now(), phase);
  }
  return pi;
}
```

**What it does.** It asks for a $10.00 payment (`amount` is in cents) using `pm_card_visa`, a test
*PaymentMethod* from Stripe's testing docs, and `confirm: true`, which means "try to charge it now".
`allow_redirects: 'never'` says not to use payment methods that send the customer to another website.
If the payment comes back `succeeded`, it records the moment the call returned in `payments.created_ms`.
That's the starting point for every delay in this article.

**What the fake does with it.** The fake answers this request itself. When the payment method is
`pm_card_visa`, it marks the payment `succeeded` at once and creates a `payment_intent.succeeded`
event. When it's `pm_card_threeDSecure2Required`, it leaves the payment in `requires_action` and
creates no event until the simulated customer finishes 3-D Secure.

From `fake-stripe.js`:

```js
    if (req.method === 'POST' && url.pathname === '/v1/payment_intents') {
      const params = new URLSearchParams(body);
      const needs3ds = params.get('payment_method') === 'pm_card_threeDSecure2Required';
      const pi = {
        id: newId('pi'), object: 'payment_intent', amount: Number(params.get('amount') ?? 0),
        currency: params.get('currency') ?? 'usd', created: nowS(), livemode: false,
        status: needs3ds ? 'requires_action' : 'succeeded',
      };
      paymentIntents.push(pi);
      if (!needs3ds) emitSucceeded(pi);
      return send(200, pi);
    }
```

From `fake-stripe.js`:

```js
  function emitSucceeded(pi) {
    const event = {
      id: newId('evt'), object: 'event', type: 'payment_intent.succeeded', created: nowS(),
      livemode: false, pending_webhooks: webhookUrl ? 1 : 0, data: { object: { ...pi } },
    };
    events.push(event);
    if (webhookUrl) later(deliveryDelayMs, () => deliver(event, 0));
    return event;
  }
```

`emitSucceeded` builds the event (its `data.object` is a copy of the payment), keeps it in a list that
the events API will return later, and schedules the first webhook delivery 20 ms later. Real Stripe's
PaymentIntents have far more fields and states; the fake keeps only what this project reads.

### The whole journey of one payment

Putting the pieces together, this is what happens to one `pm_card_visa` payment:

1. `createPayment` sends `POST /v1/payment_intents` through the SDK. The fake marks it `succeeded`,
   creates an event, and replies.
2. `createPayment` sees `succeeded` and writes the payment to `payments` with `created_ms` = now.
3. **Webhook path:** about 20 ms later the fake POSTs the signed event to the receiver. The receiver
   checks the signature, runs `processEventOnce`, and `markSeen(payment, 'webhook')` writes a `seen` row.
4. **Polling path:** at its next run, the poller lists recent payments, sees this one is `succeeded`,
   and `markSeen(payment, 'poll')` writes a second `seen` row.
5. **Reconcile path:** if the webhook never arrived, the reconcile job finds the event in the events
   list and `markSeen(payment, 'reconcile')` writes the row instead.
6. `report.js` and the demo compute each delay as `seen_ms − created_ms`.

## Step 4: the polling version (`poll.js`)

From `poll.js`:

```js
export async function pollOnce({ db, stripe, now = Date.now() }) {
  const { markSeen } = makeHelpers(db);
  const getCursor = db.prepare("SELECT value FROM state WHERE key = 'poll_cursor'");
  const setCursor = db.prepare(
    "INSERT INTO state (key, value) VALUES ('poll_cursor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );

  // The cursor is a Stripe `created` timestamp (whole seconds). First run: look back one hour.
  const cursor = Number(getCursor.get()?.value ?? Math.floor(now / 1000) - 3600);
  let newest = cursor;
  let found = 0;

  // gte, not gt: two payments can share a second, so we re-read the cursor's second each time.
  // The seen table's primary key makes re-reading harmless. The SDK fetches further pages automatically.
  for await (const pi of stripe.paymentIntents.list({ created: { gte: cursor }, limit: 100 })) {
    // KNOWN FLAW (demonstrated by `npm run demo`, scenario 2): a payment that is not yet succeeded is
    // skipped, and once a newer payment moves the cursor past its `created` time, it is never listed
    // again, even after it succeeds. Polling the events list instead (reconcile.js) avoids this.
    if (pi.status !== 'succeeded') continue;
    if (markSeen(pi.id, 'poll').changes === 1) found++;
    newest = Math.max(newest, pi.created);
  }

  setCursor.run(String(newest));
  return { cursor, newest, found };
}
```

**What happens when it runs:**

1. It reads the **cursor**, a bookmark stored in the `state` table. The cursor is a Stripe `created`
   timestamp in whole seconds: the creation time of the newest succeeded payment seen so far. On the
   very first run there's no cursor yet, so it starts one hour back.
2. It asks the API for payments created at or after the cursor (`created: { gte: cursor }`). The
   `for await` loop is the SDK's automatic paging: if there are more than 100 results, it fetches
   the next page for you.
3. It skips anything not `succeeded`, records the rest with `markSeen(…, 'poll')`, and counts how many
   were new.
4. It saves the newest `created` time it saw as the next cursor.

**Why `gte` and not `gt`?** `created` has one-second resolution, so a payment created in the same
second as the cursor, but after the last poll, would be missed with "greater than". With "greater
than or equal", the poller re-reads that second every time; `markSeen` ignores the payments it has
already recorded, so re-reading is harmless.

The timer comes from `lib/loop.js`:

From `lib/loop.js`:

```js
export function startEvery(periodMs, job) {
  if (!(periodMs > 0)) throw new Error(`interval must be a positive number, got ${periodMs}`);
  const ac = new AbortController();
  const done = (async () => {
    while (!ac.signal.aborted) {
      const started = Date.now();
      await job();
      const wait = periodMs - ((Date.now() - started) % periodMs);
      await sleep(wait, undefined, { signal: ac.signal }).catch(() => {});
    }
  })();
  return async () => { ac.abort(); await done; };
}
```

It runs the job immediately, then waits so the *next run starts* one period after this one started,
like a cron job. `npm run poll` uses a 10-second period; the demo uses 5 seconds.

### What polling costs (simulated)

In the demo, the poller (every 5 s) and the receiver ran at the same time while 10 payments were
created at random 0.3–2 s gaps (simulated output, trimmed):

```
payment              polling delay   webhook delay
pi_sim_000001               4.98 s          0.04 s
pi_sim_000003               3.87 s          0.02 s
pi_sim_000005               3.31 s          0.02 s
pi_sim_000007               1.39 s          0.02 s
pi_sim_000009               0.08 s          0.02 s
…
median                      2.44 s          0.02 s
worst                       4.98 s          0.04 s
API requests to Stripe: poller 3 (3 polls, 1 found nothing new), receiver 0
```

[Chart: demo-output/polling-vs-webhooks.svg. Polling delays rise and fall with each poll, a
saw-tooth between 0 and 5 s; webhook delays sit in a flat line near zero.]

A payment that succeeds just after a poll waits almost a whole interval; one that succeeds just
before a poll is found almost at once. And the poller sends a request on every run, whether or not
anything happened. In this short run only the first poll came back empty; on a quiet day, most would.

### The cursor's blind spot

The cursor follows the time a payment was *created*, but some payments succeed later than that.
Stripe's docs: "If the payment requires additional actions, such as authenticating with 3D Secure,
the PaymentIntent has a status of requires_action." The demo creates such a payment with the fake
(simulated output, trimmed):

```
t+0.0s   created A pi_sim_000001: requires_action (created=1794600143)
t+1.1s   created B pi_sim_000002: succeeded (created=1794600145)
t+1.2s   poll 1: found 1 (cursor moved 1794596545 -> 1794600145)
t+1.2s   A pi_sim_000001 succeeds now (its created time is still 1794600143)
t+1.2s   receiver:    new       evt_sim_000004 payment_intent.succeeded pi_sim_000001
t+1.3s   poll 2: found 0; it only lists payments created at or after 1794600145
```

Walk through it with the code above. Poll 1 sees A, but A isn't `succeeded`, so it's skipped. B is
succeeded, so the cursor moves to B's `created` time. Then A succeeds, but its `created` time is
older than the cursor, so poll 2 doesn't even fetch it, and no later poll ever will. The webhook
delivered A straight away.

This is a flaw in polling *payments by creation time*, not in polling itself. Polling Stripe's
*events* list, which the catch-up job below does, avoids it: the success is a new event, created
when the payment succeeds, so a "recent events" query still includes it.

## Step 5: the webhook receiver (`receiver.js`)

This is what arrives at the receiver (simulated request from the fake, trimmed):

```
POST /webhooks/stripe
content-type: application/json; charset=utf-8
stripe-signature: t=1794600129,v1=994af28acda559b5…
{
  "id": "evt_sim_000002",
  "type": "payment_intent.succeeded",
  "data": { "object": { "id": "pi_sim_000001", "object": "payment_intent", … } }
}
```

That's the whole mystery of the "HTTP callback": an ordinary POST to a URL I chose. The only
difference from an API call is who starts it. Here's the complete route that handles it.

From `receiver.js`:

```js
  app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), (req, res) => {
    const receivedMs = Date.now();
    if (logRequests) {
      // For learning only. Real payloads contain customer data: don't log them in production.
      log(`${req.method} ${req.originalUrl}\n${JSON.stringify(req.headers, null, 2)}\n${req.body?.toString('utf8')}`);
    }

    const signature = req.headers['stripe-signature'];
    if (!Buffer.isBuffer(req.body) || !signature) {
      return res.status(400).send('Expected a raw JSON body with a Stripe-Signature header');
    }

    // 1) Is this really from Stripe, and recent? constructEvent recomputes the HMAC signature with our
    //    whsec_ secret and rejects timestamps older than 5 minutes (replay protection).
    let event;
    try {
      event = Stripe.webhooks.constructEvent(req.body, signature, endpointSecret);
    } catch (err) {
      log(`signature check failed: ${err.message}`);
      return res.status(400).send(`Signature check failed: ${err.message}`);
    }

    // 2) + 3) Record the event ID and do the work in ONE database transaction. A duplicate delivery
    //    (same event ID) is a no-op. If the work fails, nothing is recorded and we answer 500,
    //    so Stripe retries and the retry can succeed.
    const payment = event.data?.object ?? {};
    let isNew;
    try {
      isNew = processEventOnce(event.id, 'webhook', () => {
        if (event.type === 'payment_intent.succeeded') markSeen(payment.id, 'webhook'); // real work: fulfil the order
      });
    } catch (err) {
      log(`failed to process ${event.id}: ${err.message}`);
      return res.sendStatus(500);
    }
    recordDelivery.run(event.id, event.type, payment.id ?? null, receivedMs, isNew ? 0 : 1);
    log(`${isNew ? 'new      ' : 'duplicate'} ${event.id} ${event.type} ${payment.id ?? ''}`);

    // 4) Answer quickly. Slow work belongs on a queue, or Stripe times out and retries.
    res.sendStatus(200);
  });
```

Taking it top to bottom:

**`express.raw({ type: 'application/json' })`** hands the route the request body as raw bytes (a
`Buffer`) instead of parsed JSON. That's deliberate. The signature is computed over the exact bytes
that were sent, and parsing then re-serializing the JSON can change them (the spacing, for example),
which would make every check fail. `express.json()` must not run on this route.

**The signature check.** Anyone on the internet can POST to a webhook URL, so the receiver has to
prove the request came from Stripe. Stripe's docs: "Stripe signs every webhook event by including a
signature in the Stripe-Signature header." The header holds a timestamp (`t=`) and a signature
(`v1=`). The signature is an *HMAC*, a keyed hash of the timestamp and the body, made with a secret
that only Stripe and I know: the endpoint's *signing secret*, starting `whsec_`.
`Stripe.webhooks.constructEvent` recomputes the HMAC with my secret and compares. If they differ, or
the timestamp is more than 5 minutes old, it throws and the receiver answers 400. The age check is
replay protection: a request captured by someone else can't be sent again later. Stripe's docs give
the same default: "Our libraries have a default tolerance of 5 minutes between the timestamp and the
current time."

**Duplicate protection.** `processEventOnce` (Step 1) records the event ID and runs the work in one
transaction. The work here is `markSeen(payment.id, 'webhook')`; in a real shop, it would be
"fulfil the order". If the event ID was already processed, the work is skipped and `isNew` is
`false`. The receiver still answers 200, because the event *was* handled, just earlier.

**When the work fails.** If anything inside the transaction throws, nothing is recorded and the
receiver answers 500. A non-2xx answer tells the sender the delivery failed, so it will retry, and
because no event ID was recorded, the retry runs the work again. My first draft recorded the event
ID first and did the work afterwards; a failure in between left the event marked as processed with
nothing done, and every retry was skipped as a duplicate.

**The bookkeeping.** `recordDelivery` writes a row to `deliveries` for every signed delivery the
receiver handled, duplicates included (`duplicate` is 1 or 0). The demo uses it to count deliveries.

**Answer quickly.** A 2xx status means "delivered". Any other status, a timeout or no answer at all
counts as a failure. Stripe's docs recommend a handler that "quickly returns a successful status
code (2xx) before any complex logic that might cause a timeout", so slow work belongs on a queue,
after the 200.

How does the fake produce a valid signature? With the Stripe SDK's own test helper. This is the
simulation's delivery function (we'll come back to its retry logic in the next step).

From `fake-stripe.js`:

```js
  async function deliver(event, attempt) {
    const payload = JSON.stringify(event, null, 2);
    // Stripe signs every attempt afresh, with the current time as t=.
    const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: webhookSecret, timestamp: nowS() });
    let result;
    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'stripe-signature': signature,
          'user-agent': 'FakeStripe/1.0 (local simulation)',
        },
        body: payload,
        signal: AbortSignal.timeout(5000),
      });
      result = `HTTP ${res.status}`;
    } catch (err) {
      result = err.cause?.code === 'ECONNREFUSED' ? 'connection refused' : `error: ${err.cause?.code ?? err.message}`;
    }
    const ok = /^HTTP 2\d\d$/.test(result);
    attempts.push({ event_id: event.id, attempt, at_ms: Date.now(), result });

    const label = attempt === 'resend' ? 'resend' : attempt === 0 ? 'first attempt' : `retry ${attempt}`;
    if (ok) {
      event.pending_webhooks = 0;
      log(`${event.id} ${label}: ${result}`);
    } else if (typeof attempt === 'number' && attempt < retryDelaysMs.length) {
      log(`${event.id} ${label}: ${result}; next retry in ${retryDelaysMs[attempt] / 1000} s`);
      later(retryDelaysMs[attempt], () => deliver(event, attempt + 1));
    } else {
      log(`${event.id} ${label}: ${result}; no retries left, giving up`);
    }
    return ok;
  }
```

`generateTestHeaderString` produces a `Stripe-Signature` header in the same format Stripe uses, with
the current time as `t=`, so the receiver's real `constructEvent` check runs unchanged. The fake sends
its own user agent and none of Stripe's other headers; the receiver doesn't read them.

## Step 6: killing the endpoint

The `deliver` function above is also the fake's retry logic. If the POST fails, whether from a non-2xx
status, "connection refused" or no answer within 5 seconds, and retries are left, it schedules the
same event again after the next delay in `retryDelaysMs`. The demo sets that to 1, 2 and 4 seconds.
After the last one it gives up.

In the demo I stopped the receiver, created 3 payments, and started it again 2.5 seconds after the
payments (simulated output, one of the three events shown):

```
t+0.0s   fake Stripe: evt_sim_000002 first attempt: connection refused; next retry in 1 s
t+1.0s   fake Stripe: evt_sim_000002 retry 1: connection refused; next retry in 2 s
t+2.9s   receiver started again
t+3.0s   receiver:    new       evt_sim_000002 payment_intent.succeeded pi_sim_000001
t+3.0s   fake Stripe: evt_sim_000002 retry 2: HTTP 200
```

With the receiver gone, nothing was listening on its port, so each attempt failed with "connection
refused". The sender didn't throw the event away; it tried again later. All three payments arrived
through automatic retries, each about 3 seconds after it succeeded, and each was processed exactly
once. A short outage became a delay, not lost data.

The 1-2-4-second schedule is the simulator's. Real Stripe is far more patient, and test mode differs
from live mode. From Stripe's docs: "Stripe attempts to deliver events to your destination for up to
three days with an exponential back off in live mode," and "We retry event deliveries created in a
sandbox three times over the course of a few hours." Stripe also generates "a new signature and
timestamp for the new delivery attempt", so a retry that arrives hours later still passes the
5-minute check. The fake does the same: `deliver` signs every attempt with the current time.

## Step 7: the same event, twice

Why would an event arrive twice? A sender can't always tell whether a delivery worked. If my server
processed the event but its 200 response got lost or arrived too late, the sender sees a failure
and tries again. Stripe's docs say plainly that "webhook endpoints might occasionally receive the
same event more than once." The fake can re-send an event on request, and the demo does that once
(simulated output):

```
t+0.0s   receiver:    new       evt_sim_000002 payment_intent.succeeded pi_sim_000001
t+0.1s   receiver:    duplicate evt_sim_000002 payment_intent.succeeded pi_sim_000001
```

The second delivery carries the same event ID, so `processEventOnce` finds it in `processed_events`,
skips the work, and the receiver logs `duplicate` and answers 200. Without that check, a real shop
could ship the same order twice. Handling a repeated message safely like this is called being
*idempotent*.

Stripe also mentions rarer cases where "two separate Event objects are generated and sent" for the
same object. An event-ID check alone wouldn't catch those, which is why the work itself should be
idempotent too. Here it is: `markSeen` records each payment ID once per method, whatever the event
ID. The fake doesn't simulate this case.

## Step 8: when the retries run out, reconciliation (`reconcile.js`)

Retries only cover outages shorter than the retry window. So the demo keeps the receiver down longer
than the simulator's whole schedule (simulated output, trimmed):

```
t+7.0s   fake Stripe: evt_sim_000002 retry 3: connection refused; no retries left, giving up
t+7.2s   receiver started again; no retries are coming
t+7.7s   payments the app doesn't know about: 2
```

Nothing errored and nothing alerted. A webhook you never received looks exactly like a payment that
never happened. The fix is *reconciliation*: now and then, compare your records with the provider's
and fill in the gaps.

From `reconcile.js`:

```js
export async function reconcile({ db, stripe, sinceHours = 72, now = Date.now(), log = console.log }) {
  const { markSeen, processEventOnce } = makeHelpers(db);
  // Look back further than the gap between runs: overlap costs nothing because processed events are
  // skipped. Stripe only lists events from the last 30 days, so more than 720 h is pointless.
  const since = Math.floor(now / 1000) - Math.min(sinceHours, 720) * 3600;
  const recovered = [];
  let checked = 0;

  for await (const event of stripe.events.list({ type: 'payment_intent.succeeded', created: { gte: since }, limit: 100 })) {
    checked++;
    const paymentId = event.data.object.id;
    // The same event-ID table and transaction as the receiver: whichever sees an event first does the
    // work, the other one skips it. So reconcile and webhook retries can never double-process.
    if (processEventOnce(event.id, 'reconcile', () => markSeen(paymentId, 'reconcile'))) {
      recovered.push({ eventId: event.id, paymentId });
      log(`recovered ${event.id} (payment ${paymentId})`);
    }
  }
  log(`reconcile done: ${checked} event(s) checked, ${recovered.length} recovered`);
  return { checked, recovered };
}
```

**What happens when it runs:**

1. It works out a start time, `since`: 72 hours ago by default, never more than 30 days.
2. It lists every `payment_intent.succeeded` event created since then (`stripe.events.list`, again
   paged automatically by `for await`).
3. For each event, it calls the **same** `processEventOnce` the receiver uses. An event the receiver
   already processed is skipped. An event the receiver never saw is new: the work runs and the
   payment is recorded with method `reconcile`.

The demo's output (simulated):

```
t+7.7s   reconcile:   recovered evt_sim_000004 (payment pi_sim_000003)
t+7.7s   reconcile:   recovered evt_sim_000002 (payment pi_sim_000001)
t+7.7s   reconcile:   reconcile done: 2 event(s) checked, 2 recovered
t+7.7s   reconcile:   reconcile done: 2 event(s) checked, 0 recovered
```

The first run recovered both lost payments. The second run changed nothing, because the event IDs
were now in `processed_events`. The same is true if a late webhook retry and the reconcile job race
each other: whichever reaches `processEventOnce` first does the work, the other is a no-op.

**How often to run it.** The job doesn't depend on the webhook endpoint at all, so it doesn't matter
how long the endpoint was down. What matters is that the job runs more often than its look-back
window, and that the window fits in what Stripe keeps: Stripe lists events "going back up to 30 days".
Running it hourly with a 3-day look-back leaves plenty of overlap (`node reconcile.js --every 3600`).
It also catches what retries can't: a deleted endpoint, or a bug that answered 200 without recording
the event. And because it reads *events*, not payments, it doesn't have the poller's late-success
blind spot.

## Step 9: measuring the delay (`lib/report.js`)

The comparison tables come from one calculation.

From `lib/report.js`:

```js
export function delaySummary(rows) {
  const delays = (key) => rows.filter((r) => r.created_ms != null && r[key] != null).map((r) => r[key] - r.created_ms);
  return {
    payments: rows.length,
    poll: summarize(delays('poll_ms')),
    webhook: summarize(delays('webhook_ms')),
    reconcile: summarize(delays('reconcile_ms')),
    missedByPoll: rows.filter((r) => r.poll_ms == null).map((r) => r.id),
    missedByWebhook: rows.filter((r) => r.webhook_ms == null).map((r) => r.id),
  };
}
```

For each method it takes `seen_ms − created_ms` per payment (the median, minimum and maximum come
from `summarize`), and lists the payments a method never found. Both timestamps come from `Date.now()`
on the same machine, so there's no clock difference to correct for. `created_ms` is taken when the
create call *returns*, so a very fast webhook could in principle be recorded before it, giving a
slightly negative delay. In the committed run all delays were positive.

## What the tests prove, and what they don't

`npm test` runs 19 tests, and all 19 pass. The demo also checks itself: 14 of 14 checks passed in the
committed run.

| Test file | What it proves |
|---|---|
| `test/receiver.test.js` (7 tests) | The real receiver accepts a correctly signed event; rejects a wrong secret, an edited body, re-serialized JSON, a timestamp older than 5 minutes and a missing header with 400; turns a repeated event ID into a no-op that still returns 200; answers 500 when the work fails and lets the retry succeed |
| `test/unit.test.js` (7 tests) | `markSeen` and `processEventOnce` behave as described, including the rollback; live keys are refused; the delay maths; the timer |
| `test/fake-stripe.test.js` (4 tests) | The fake behaves as this article says: test-key check, signed deliveries that the Stripe SDK can verify, retries that reuse the event ID, giving up, the 3-D Secure flow, re-sending |
| `test/demo.test.js` (1 test) | All five scenarios produce the outcomes described here, with faster timings |

Signatures in these tests are created with the Stripe SDK's own helper and checked with the SDK's
real verification function, so the signature logic is exercised for real.

What they **don't** prove:

- That real Stripe behaves exactly like the fake. The fake imitates only the calls this project makes;
  the API shapes, retry schedule, 3-D Secure flow and duplicates are my simulation of Stripe's
  documented behaviour.
- Anything about real-world latency. Everything ran on one machine.
- That the code works against a real Stripe account. I haven't run it against one.

## What I'd run

Webhooks as the main path, and an hourly reconcile job as the safety net, both going through the
same `processEventOnce`. If you're moving a live poller over:

1. Add the receiver and the event-ID table while the poller still runs.
2. Make the work idempotent on the payment ID, so whichever method sees a payment first wins.
3. Compare the two for a while (this repo's `npm run report` does it per payment).
4. Turn the poller into a slow reconcile job over the events list. Don't delete it.

My rule of thumb: polling alone is fine for a handful of payments a day where nobody notices a
minute's delay. Once delay matters, or most of your polls find nothing, use webhooks. Either way,
keep a slow poll of the events list.

## Gotchas

Shown in the code and the demo:

- **Verify the signature on the raw body.** A JSON parser that runs first breaks every check.
- **Record the event ID and do the work in one transaction**, or a failure in between loses the event.
- **Dedupe by event ID.** Retries, resends and the catch-up job all bring events you may already have.
- **A cursor on `created` misses late successes.** If you keep a poll, poll events.
- **Keep a reconciliation job.** Retries end; the events list keeps 30 days.

From Stripe's documentation, not shown in the demo:

- **Reply 2xx fast.** Do slow work on a queue.
- **Don't assume order.** "Stripe doesn't guarantee the delivery of events in the order that they're generated."
- **Test-mode retries aren't live-mode retries.** Three times over a few hours in a sandbox, up to three days live.

## Limits of this project

- **It's a simulation.** `fake-stripe.js` imitates the few Stripe calls the app makes, with a made-up
  retry schedule. It isn't Stripe.
- **No real-world latency.** Webhook delays of about 0.02 s contain no internet, and the 5-second
  poll interval is compressed; real pollers often run every 60 seconds.
- **Simplified behaviour.** The fake delivers events in order and never creates two events for one
  payment. Real Stripe guarantees neither.
- **Not tested against a real Stripe account.** The README describes an optional way to try it in
  Stripe test mode with the Stripe CLI; I haven't verified it.

## FAQ

**Is a webhook an API?** A webhook is an HTTP request the provider sends to a URL you expose, when
something happens. An API call is a request you send to the provider, when you decide to ask. Both
are plain HTTP; the difference is who starts the conversation.

**Do webhooks replace polling?** Mostly. In my simulation the webhook path delivered every payment
with no requests from my side. But I still run a slow catch-up poll, because retries stop eventually.

**What happens if my server is down when a webhook is sent?** According to Stripe's docs, the
delivery is retried: for up to three days in live mode, three times over a few hours in a sandbox.
Anything that outlasts the retries needs a catch-up job that reads the events list.

**Can I try this without a Stripe account?** Yes. Everything above runs against the local
simulation: in the `stripe-webhooks-vs-polling` folder, `npm install && npm run demo`.

## Sources

- Stripe: [Receive Stripe events in your webhook endpoint](https://docs.stripe.com/webhooks) (retries, signatures, duplicates, ordering, fast replies)
- Stripe: [How PaymentIntents work](https://docs.stripe.com/payments/paymentintents/lifecycle) (`requires_action`)
- Stripe API: [List all events](https://docs.stripe.com/api/events/list) (30 days)
- Stripe: [Testing](https://docs.stripe.com/testing) (`pm_card_visa`)
- Code and simulated output: [REPO LINK]
