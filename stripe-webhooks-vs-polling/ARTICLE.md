I replaced payment polling with webhooks, then killed the endpoint: what I measured
Nov 12, 2026 · @Maryam

Draft note (delete before publishing): every [FILL: …] is a number, screenshot or log line you have to capture by running the code below against Stripe in test mode. Every [CHECK: …] is a claim to confirm against your own run or Stripe's docs. Every [VERIFY: …] marks something the repository can't confirm yet. Every number marked SIMULATED comes from the repository's local fake Stripe (`npm run demo`, committed in demo-output/demo-output.md), not from Stripe: keep it labelled, or cut it once the real numbers are in. No real Stripe test-mode run has been done for this draft. Every code block is copied verbatim from the file named above it in the repo (stripe-webhooks-vs-polling/). The story is first person, so it has to be true: if you built the poller only for this test, say so in the first line. If a headline number turns out unremarkable (a webhook median of a second or two is expected), lead the intro with whatever surprised you instead.

For [FILL: how long] my app found out about new payments the boring way: a poller asking Stripe every 60 seconds, "anything new?" I replaced it with a webhook. Every "webhook vs API" article says webhooks are faster and cheaper, but none shows a number, so I ran both against the same [FILL: N] test payments. Median delay: [FILL] s polling, [FILL] s webhook. Then I switched off my endpoint to see what breaks. The first retry arrived [FILL] later. I still run a poll, just a much slower one.

Before touching real Stripe, I ran every scenario in this article against a small local fake Stripe that ships with the code (more on it in the setup). Those runs are labelled SIMULATED throughout. They show the mechanisms, not Stripe's real timings.

The results at a glance

Real Stripe test mode:

| | Polling every 60 s | Webhook |
|---|---|---|
| Median delay, payment created → app knows | [FILL] s | [FILL] s |
| 95th percentile delay | [FILL] s [VERIFY: the repo's report.js computes median and worst, not p95; compute it from the raw rows or drop this row] | [FILL] s [VERIFY: same] |
| Worst delay | [FILL] s | [FILL] s |
| Stripe API calls per hour, quiet hour | [FILL] (expect 60) [VERIFY: report.js prints total requests per script, not per hour; count the poll rows in the api_calls table for one quiet hour] | 0 |
| Stripe API calls per hour, during the test | [FILL] [VERIFY: same] | 0 |
| What happened when my side was down for [FILL] min | [FILL] | [FILL] |
| Code I maintain | poll.js: 62 lines + a cursor | receiver.js: 82 lines + an event-ID table |

(The code row counts the whole files in the repo, comments and command-line handling included.)

SIMULATED, local fake Stripe (`npm run demo`, 10 payments, poller every 5 s, everything on one machine):

| | Polling every 5 s | Webhook |
|---|---|---|
| Median delay | 2.44 s | 0.02 s |
| Worst delay | 4.98 s | 0.04 s |
| Stripe API requests in the run | 3 (3 polls, 1 of them found nothing) | 0 |
| Receiver down 2.5 s after 3 payments | not applicable | all 3 delivered by automatic retry, about 3 s after each payment |
| Receiver down longer than all retries | not applicable | 2 payments missed until the reconcile job recovered them |

The simulated webhook delay has no internet in it, and the fake's retries are seconds apart instead of hours. Details, code and the raw timestamps are below.

The setup, so you can reproduce it

Everything ran on one machine against Stripe in test mode [VERIFY: true only after the real run], so no real money moved and every timestamp came from the same clock.
Runtime: Node [FILL: version; the simulated run used v22.23.4], stripe 23.1.0, express 5.3.0, better-sqlite3 13.1.1 (the versions pinned in the repo's package-lock.json)
Payments: [FILL: N] test PaymentIntents, created by a script at random gaps of 5–30 seconds so they land at different points in the polling cycle (`node create-payments.js --count N --min-gap 5 --max-gap 30`; the script's own default is 3 payments 1–3 s apart)
Receiver URL: a public HTTPS tunnel to localhost:3000 using [FILL: tool + version], registered as a real webhook endpoint in the Stripe Dashboard. The tunnel adds its own delay, so I measured it: [FILL: median of 20 runs of curl -s -o /dev/null -w '%{time_total}' -X POST against the tunnel URL vs against localhost]. That's how much of the webhook number is my tunnel, not Stripe. [VERIFY: the repo's README documents only the Stripe CLI (`stripe listen`) for real test mode, and neither path has been run yet. A tunnel and a registered endpoint need no code changes, but they aren't documented in the repo.]
Simulation: `fake-stripe.js` is a small local server that answers the three Stripe API calls these scripts make (create a payment, list payments, list events) and POSTs signed webhook events, retrying failures. When `STRIPE_API_BASE` is set (as in the repo's .env.example), the official Stripe SDK talks to it instead of api.stripe.com; the app code doesn't change. `npm install && npm run demo` runs every scenario in this article against it in about a minute.
Repo: [FILL: link]

How I timed it. "Payment created" is the moment the create call returned a succeeded PaymentIntent. "App knows" is the moment my poller or receiver wrote that payment's ID to SQLite. Both are Date.now() on the same machine, so there's no clock skew to correct for. The delay includes network time and my own code, which is what a real app feels.

One shared SQLite file holds everything. From lib/db.js:

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

Three changes from my first sketch. WAL mode alone isn't enough when three processes write to one file: without the busy timeout, a write that collides with another process fails at once instead of waiting its turn. `payments` has a `phase` column, so each scenario's payments can be analysed separately. And `deliveries` logs every webhook request that passed the signature check, duplicates included, which is what the retry and duplicate counts below come from.

The two helpers everything else shares. From lib/db.js:

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

`markSeen` writes "method X found payment Y at time Z"; `INSERT OR IGNORE` makes a second write for the same payment and method a no-op, so only the first sighting counts. `processEventOnce` is what the webhook receiver and the catch-up job both use to handle each event exactly once, and it gets its own section below.

The payments come from a short script in the repo. It waits a random gap between payments (`--min-gap`, `--max-gap`), and the function that matters records the "payment created" time. From create-payments.js:

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

`pm_card_visa` is one of Stripe's test PaymentMethods, and `confirm: true` charges it in the same call. Only a payment that comes back `succeeded` is recorded: one that still needs 3-D Secure isn't paid yet, and it matters for the cursor problem below.

The polling version: what I started with

The poller asks Stripe for PaymentIntents created since the last run, records the succeeded ones, and saves a cursor. For the real run it runs once a minute:

`node poll.js --every 60`

or, from cron, one run per minute:

`* * * * * cd /path/to/app && node poll.js --once >> poll.log 2>&1`

(A correction to my first draft: in the repo, plain `node poll.js` keeps polling every 10 seconds until you stop it; `--once` is the single run that cron expects. The repo doesn't ship a crontab file.)

From poll.js:

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

Each run reads the cursor from the `state` table, lists everything created at or after it (the SDK's `for await` fetches further pages by itself), records the succeeded payments, and stores the newest `created` time as the next cursor. Every HTTP request is counted. From poll.js:

```js
  const stripe = createStripe({ onRequest: () => logApiCall('poll') }); // count every HTTP request
```

`createStripe` hooks the SDK's `request` event, which fires once per HTTP request, extra pages and automatic retries included. From lib/stripe-client.js:

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

It also refuses any key that isn't `sk_test_…` or `rk_test_…` (`assertTestKey`), and points the SDK at the fake Stripe when `STRIPE_API_BASE` is set.

The costs you can work out on paper: a 60-second cycle means about 30 seconds of delay on average and up to 60 in the worst case, plus run time. It also means at least 60 API calls an hour when nothing is happening.

The cost that doesn't show up on paper is the cursor. It's set from the `created` time of the newest succeeded payment. A real payment that is created now and succeeds a minute later (a 3D Secure check, say) can have a `created` time the cursor has already passed, and then the poller never sees it succeed. Stripe's docs: "If the payment requires additional actions, such as authenticating with 3D Secure, the PaymentIntent has a status of requires_action." I haven't hit this against real Stripe [VERIFY: whether you hit it in your real run], but the demo reproduces it with the fake (SIMULATED, trimmed):

```
t+0.0s   created A pi_sim_000001: requires_action (created=1794600143)
t+1.1s   created B pi_sim_000002: succeeded (created=1794600145)
t+1.2s   poll 1: found 1 (cursor moved 1794596545 -> 1794600145)
t+1.2s   A pi_sim_000001 succeeds now (its created time is still 1794600143)
t+1.2s   receiver:    new       evt_sim_000004 payment_intent.succeeded pi_sim_000001
t+1.3s   poll 2: found 0; it only lists payments created at or after 1794600145
```

Payment B moved the cursor past A's creation time, so when A succeeded the poller never looked at it again. The webhook delivered it straight away. (In the fake, the 3-D Secure step is simulated: the demo marks A as succeeded itself.)

Measured: median [FILL] s, 95th percentile [FILL] s, worst [FILL] s. API calls: [FILL] per hour.
SIMULATED (poller every 5 s, 10 payments): median 2.44 s, worst 4.98 s, 3 API requests for the run.

The webhook version

The receiver is one Express route. It checks Stripe's signature, records the event ID and the payment in one database transaction, and replies 200 straight away. From receiver.js:

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

Three differences from my first draft, each for a reason:

- It checks signatures with `Stripe.webhooks.constructEvent` and no API key. Verifying a signature only needs the endpoint's `whsec_` secret, so the webhook server doesn't need to hold the secret API key at all.
- It records the event ID and does the work in one transaction (`processEventOnce`). My first draft inserted the event ID first and did the work afterwards. If the work had failed in between, the event would have been marked as processed with nothing done, and every retry would have been skipped as a duplicate. Now a failure records nothing and answers 500, so Stripe retries. The repo has a test for exactly this.
- It doesn't log every request. Raw headers and body are printed only with `LOG_REQUESTS=1 npm run receiver`, because real payloads contain customer data.

`express.raw`, not `express.json`: the signature is computed over the exact bytes Stripe sent, so the body has to be verified before anything parses and re-serializes it. `constructEvent` recomputes the HMAC signature with the `whsec_` secret and, by default, rejects a timestamp more than 5 minutes old. Stripe's docs give the same default: "Our libraries have a default tolerance of 5 minutes between the timestamp and the current time."

This is what actually arrives. Here is the raw request from my log, with the signature and IDs trimmed:

[FILL: paste the logged method, path, headers (Content-Type, Stripe-Signature, User-Agent) and the first lines of the JSON body. Start the receiver with LOG_REQUESTS=1 to print them]

For comparison, a SIMULATED request from the fake Stripe (demo-output/sample-webhook-request.txt, trimmed; the fake sends its own User-Agent, not Stripe's):

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

That's the whole mystery of the "HTTP callback." It's an ordinary POST to a URL I gave Stripe, the same kind of request you'd send with curl. The only difference is who starts it.

Registering the endpoint. In the Stripe Dashboard, in test mode, I opened Workbench → Webhooks → Create an event destination, chose my account's events, the **Snapshot** payload format, `payment_intent.succeeded` only, and a webhook endpoint with the tunnel URL plus /webhooks/stripe. Snapshot matters: Stripe now offers "Thin" payloads too, and this receiver reads the payment from `event.data.object`, which only snapshot events include. Stripe shows a signing secret for the endpoint, which goes in STRIPE_WEBHOOK_SECRET. [FILL: screenshot of the endpoint settings] [VERIFY: Dashboard labels as of your run; this step isn't documented in the repo README, which uses `stripe listen` instead]

Why the event-ID table. Stripe can send the same event more than once ("Webhook endpoints might occasionally receive the same event more than once"), and a retry reuses the original event ID. `processEventOnce` inserts the ID with `INSERT OR IGNORE` and only runs the work if the insert added a row, so a second delivery is a no-op. That's what makes retries safe, as the outage test shows below.

Measured: median [FILL] s, 95th percentile [FILL] s, worst [FILL] s. API calls from my side: none.
SIMULATED: median 0.02 s, worst 0.04 s, on one machine with no network in between.

Running both side by side

I ran the poller and the receiver at the same time, then created [FILL: N] payments. Each one ends up with two rows in `seen`, one per method, so the comparison is per payment, not just an average. The report in the repo (`npm run report`, built on lib/report.js) turns those rows into the numbers at the top. Its core is one query. From lib/report.js:

```js
export function paymentRows(db, phase) {
  return db.prepare(`
    WITH ids AS (SELECT id FROM payments UNION SELECT id FROM seen)
    SELECT ids.id, p.phase, p.created_ms,
      (SELECT seen_ms FROM seen WHERE id = ids.id AND method = 'poll') AS poll_ms,
      (SELECT seen_ms FROM seen WHERE id = ids.id AND method = 'webhook') AS webhook_ms,
      (SELECT seen_ms FROM seen WHERE id = ids.id AND method = 'reconcile') AS reconcile_ms
    FROM ids LEFT JOIN payments p ON p.id = ids.id
    WHERE (? IS NULL OR p.phase = ?)
    ORDER BY COALESCE(p.created_ms, 0), ids.id`).all(phase ?? null, phase ?? null);
}
```

One row per payment, with the time each method found it (null = never). Then the delays and the payments each method missed. From lib/report.js:

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

`summarize` gives the median, minimum and maximum. The report also counts API requests per script from the `api_calls` table, as totals, not per hour (a correction to my first draft, which said it counted per hour).

[FILL: chart from the real run. One dot per payment: x = when it was created, y = delay in seconds, polling and webhook in two colours. If the poller behaves like a 60-second cycle, its dots climb from 0 to about 60 s and drop back each minute. The webhook dots should sit in a flat line near the bottom.]

The demo draws the same chart from the SIMULATED run: demo-output/polling-vs-webhooks.svg. With a 5-second poller, the polling dots form that saw-tooth between 0 and 5 s and the webhook dots sit flat near zero. The simulated table (trimmed):

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

[FILL: anything surprising. Outliers, a webhook that arrived before the create call returned, events out of order, a payment one method missed. If nothing surprised you, say that in one sentence.] (In the SIMULATED run neither method missed a payment and no delay was negative.)

If you're moving a live poller over, this is the order I'd use:
1. Add the receiver and the event-ID table, with the poller still running.
2. Make processing idempotent on the payment ID, so whichever method sees a payment first wins and the other is a no-op.
3. Compare for a few days with the same report as above.
4. Slow the poller down to a reconciliation job (below). Don't delete it.

Then I killed the endpoint

At [FILL: time] I [FILL: stopped the receiver process but left the tunnel up / stopped both]. That choice matters: with the tunnel up, Stripe gets an error response from the tunnel; with it down, the connection fails. [FILL: what Stripe's dashboard recorded for your choice, e.g. the status code or connection error.]

With the endpoint down, I created [FILL: N] payments over [FILL: minutes]. Nothing reached my app. The poller had been turned off for this test, so the only record of those payments was on Stripe's side.

[FILL: screenshot of the endpoint's Event deliveries tab in the Dashboard, showing the failed attempts and the next retry time.]

Test mode doesn't behave like production here. Stripe's docs say live mode retries "for up to three days with an exponential back off", but "We retry event deliveries created in a sandbox three times over the course of a few hours." So whatever timing I measured below is test-mode timing. It shows the mechanism, not the production schedule. (Stripe: retry behavior)

I used a registered endpoint here, not stripe listen, so the retries below come from Stripe's own delivery system and show up in the Dashboard. [VERIFY: true only once the real run uses a registered endpoint; the repo doesn't establish whether `stripe listen` deliveries are retried the same way]

The simulated version of this test runs in seconds. The fake Stripe's retry logic is a fixed schedule; the demo uses 1, 2 and 4 seconds between attempts, then gives up. From fake-stripe.js:

```js
    if (ok) {
      event.pending_webhooks = 0;
      log(`${event.id} ${label}: ${result}`);
    } else if (typeof attempt === 'number' && attempt < retryDelaysMs.length) {
      log(`${event.id} ${label}: ${result}; next retry in ${retryDelaysMs[attempt] / 1000} s`);
      later(retryDelaysMs[attempt], () => deliver(event, attempt + 1));
    } else {
      log(`${event.id} ${label}: ${result}; no retries left, giving up`);
    }
```

In the demo, the receiver process is stopped, so nothing listens on its port and each attempt fails with "connection refused". There's no tunnel in the simulation, so the "error response from the tunnel" case isn't covered.

When the retries came back

I restarted the receiver at [FILL: time], [FILL: minutes] after stopping it, and left it alone. I didn't press the Dashboard's resend button: a manual resend proves nothing about automatic retries.

| Event | Payment created | Failed attempts | Delivered by retry at | Total delay |
|---|---|---|---|---|
| [FILL: evt_…] | [FILL] | [FILL: times] | [FILL] | [FILL] |
| [FILL] | [FILL] | [FILL] | [FILL] | [FILL] |

SIMULATED (demo scenario 3: receiver stopped, 3 payments, receiver back 2.5 s after the payments; times relative to the receiver stopping):

| Event | Failed attempts | Delivered by | Total delay |
|---|---|---|---|
| evt_sim_000002 | t+0.0 s, t+1.0 s (connection refused) | retry 2, t+3.0 s | 3.03 s |
| evt_sim_000004 | t+0.2 s, t+1.2 s | retry 2, t+3.2 s | 3.03 s |
| evt_sim_000006 | t+0.4 s, t+1.4 s | retry 2, t+3.4 s | 3.02 s |

What the log showed:
Order: [FILL: did the retried events arrive in the order the payments were created?] (SIMULATED: yes, but the fake always delivers in order, so this says nothing about Stripe, which "doesn't guarantee the delivery of events in the order that they're generated.")
Duplicates: [FILL: how many duplicate lines the receiver printed. Each one is a delivery the event-ID table turned into a no-op.] (SIMULATED: none during the outage; a separate demo scenario re-sends one event on purpose, and the receiver logs `duplicate evt_sim_000002` and does nothing.)
Signatures: Stripe's docs confirm that "If Stripe retries an event (for example, your endpoint previously replied with a non-2xx status code), then we generate a new signature and timestamp for the new delivery attempt." So a retry still passes constructEvent's 5-minute age check, and a fresh signature isn't something to work around. [CHECK: that each retry in your log carries a new t= in Stripe-Signature] (The fake does the same: it signs every attempt with the current time.)
Anything lost: [FILL: did every payment created during the outage eventually reach the app? If one didn't, that's your lead for the next section.] (SIMULATED: no; all three arrived by retry and each was processed once.)

The takeaway: retries turned a [FILL] minute outage into [FILL] of delay, not lost payments. But that only held because the outage was shorter than Stripe's retry window, and in test mode that window is a few hours, not days. (SIMULATED: a 2.5-second outage became about 3 seconds of delay.)

The catch-up script: the poll I kept

Retries cover a short outage. They don't cover one longer than the retry window, a deleted or disabled endpoint, or a bug that returns 200 and then drops the work. For those, Stripe keeps a list of events you can read back. This script asks for recent payment_intent.succeeded events and handles any my receiver never recorded. From reconcile.js:

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

It uses the same `processEventOnce` as the receiver. If the script processes an event first and Stripe's retry arrives later, the receiver logs a duplicate and does nothing, and the other way round. It looks back 3 days by default (`--since-hours` changes it), capped at 30 days.

Stripe's events list goes back up to 30 days (Stripe API: list events: "List events, going back up to 30 days"), so this job covers any outage shorter than that, as long as the job itself keeps running. Stripe has its own guide to processing undelivered events that follows the same idea.

Showing it work. [FILL: from the real run. If every event came back through retries, there's nothing for reconcile to recover; record that it found 0.]

A correction to my plan: the draft said to simulate a lost event by deleting its rows from `processed_events` and `seen`. The repo doesn't do that. Instead, the demo loses events the honest way: it keeps the receiver down until the fake Stripe has used up all its retries, then runs the reconcile job twice (SIMULATED, trimmed):

```
t+7.0s   fake Stripe: evt_sim_000002 retry 3: connection refused; no retries left, giving up
t+7.2s   receiver started again; no retries are coming
t+7.7s   payments the app doesn't know about: 2
t+7.7s   reconcile:   recovered evt_sim_000004 (payment pi_sim_000003)
t+7.7s   reconcile:   recovered evt_sim_000002 (payment pi_sim_000001)
t+7.7s   reconcile:   reconcile done: 2 event(s) checked, 2 recovered
t+7.7s   reconcile:   reconcile done: 2 event(s) checked, 0 recovered
```

Nothing errored and nothing alerted until the reconcile ran. The second run recovered nothing, because both event IDs were already in `processed_events`.

I run it hourly:

`0 * * * * cd /path/to/app && node reconcile.js >> reconcile.log 2>&1`

(or `node reconcile.js --every 3600` without cron). That's at least one list call per run, 24 a day instead of the old poller's 1,440, and more only if the 3-day look-back holds more than 100 events, since the SDK then fetches extra pages. It only does real work when something went wrong.

What I run now

Webhooks are the main path and an hourly reconcile job is the safety net. Both write through the same event-ID check, so neither can process a payment twice.

What I run now · webhook first, hourly reconcile as backup

Here's my rule of thumb from this test. Polling alone is fine when you have a handful of payments a day and nobody notices a one-minute delay. Once delay matters, or your poller is spending most of its API calls finding nothing, switch to webhooks. Either way, keep a slow poll of the events list, because a webhook you never received looks exactly like a payment that never happened.

[FILL: one or two sentences on what changed for your app in practice, e.g. delay users see, API calls saved per day, code deleted.]

Gotchas, each one shown above

- Verify the signature on the raw body. A JSON parser that runs first changes the bytes and every check fails. (The webhook version)
- Record the event ID and do the work in one transaction, or a failure in between turns every retry into a "duplicate". (The webhook version)
- Reply 200 before slow work. Do the heavy lifting on a queue, or a slow handler can turn into failed deliveries and retries. (The webhook version; from Stripe's docs, not tested in this project)
- Dedupe by event ID. Retries and the catch-up script both send events you may already have. (Retries, catch-up)
- Don't assume order. [FILL: link to what you saw.] (Retries; the simulation can't show this, because the fake delivers in order)
- Test-mode retries aren't production retries. A few hours in a sandbox, up to three days live. (Killing the endpoint)
- A cursor on created misses late successes. If you keep any polling, poll events, not objects. (Polling, catch-up)
- Keep a reconciliation job. Retries only cover outages shorter than the retry window. (Catch-up)

FAQ

Is a webhook an API? A webhook is an HTTP request the provider sends to a URL you expose, when something happens. An API call is a request you send to the provider, when you decide to ask. Both are plain HTTP. The difference is who starts the conversation.

Do webhooks replace polling? Mostly. In my test, webhooks were [FILL] times faster at the median and made zero API calls. (In the SIMULATED run the webhook path also made zero API calls; its speed ratio isn't meaningful, because the simulated webhook has no network in it.) But I still run an hourly catch-up poll, because retries stop eventually.

What happens if my server is down when a webhook is sent? With Stripe, the delivery fails and Stripe retries: up to three days in live mode, three attempts over a few hours in test mode. Anything that outlasts the retries needs a catch-up job that reads the events list.

Can I test this without real money? Yes. The real-run numbers here come from Stripe's test mode with the pm_card_visa test PaymentMethod [VERIFY: once the real run is done], and the whole project also runs with no Stripe account at all, against the local fake Stripe: `npm install && npm run demo`.

Sources
- Stripe: receive events in your webhook endpoint, including retry behavior
- Stripe: how PaymentIntents work (requires_action)
- Stripe API: list events
- Stripe: process undelivered events
- Stripe: testing (pm_card_visa)
- [FILL: link to your repo, with create-payments.js and report.js (plus lib/report.js) in full]
