<!--
Draft notes (delete before publishing):
- Every number below is from the SIMULATED run committed in demo-output/demo-output.md. Re-running
  `npm run demo` overwrites that file with new numbers (payment gaps are random); keep the committed
  run, or update the numbers here to match a new one.
- Replace [REPO LINK] with the repository URL, and add the chart image (demo-output/polling-vs-webhooks.svg).
- The story is first person. Keep it true: this describes building this project, not a production system.
-->

# I replaced payment polling with webhooks, then killed the endpoint: what I learned

Most "webhooks vs polling" explanations stop at "webhooks are faster and cheaper". I wanted to see
what happens when the webhook side breaks. So I built a small payment app that finds out about
payments both ways: first with a poller that asks Stripe "anything new?" on a timer, then with a
webhook receiver. Then I switched the receiver off on purpose.

Everything runs against a small local simulation of Stripe, so the failures are easy to reproduce.
The code uses the official Stripe Node.js SDK and checks webhook signatures with Stripe's own
verification function; only the server on the other end is fake. All timings below come from that
simulation, compressed so the whole thing runs in about a minute. They show *how* each approach
behaves, not how fast real Stripe is.

Code: [REPO LINK]. In the `stripe-webhooks-vs-polling` folder, `npm install && npm run demo` runs
every scenario below (your timings will differ slightly; the payment gaps are random).

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

| Real (the same code would run against Stripe) | Simulated (`fake-stripe.js`) |
|---|---|
| The Stripe SDK calls: create a payment, list payments, list events | The server answering those calls, on my laptop |
| Signature checking with `Stripe.webhooks.constructEvent` | The signing: the fake signs with the Stripe SDK's test helper, in the same format |
| The receiver, poller and reconcile job | The retry schedule: the fake waits 1, then 2, then 4 seconds between attempts, then gives up |
| | A payment that needs 3-D Secure, and the customer completing it |
| | Re-sending an event to create a duplicate |

Where I describe what real Stripe does, I quote its documentation.

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

## The setup

Four small Node.js scripts share one SQLite database file, and a fifth plays Stripe:

- `create-payments.js` creates test payments with Stripe's test PaymentMethod `pm_card_visa`, and
  records when each create call returned a succeeded payment.
- `poll.js` is the poller.
- `receiver.js` is the webhook endpoint, an Express server.
- `reconcile.js` is a catch-up job that reads Stripe's event history.
- `fake-stripe.js` is the simulation. It answers the few Stripe API calls these scripts make and
  POSTs signed `payment_intent.succeeded` events to the receiver.

"The app knows" means the moment a script writes the payment's ID to the database. The delay is that
moment minus the moment the create call returned a succeeded payment, both on the same clock.

## The polling version

Stripe calls a payment a *PaymentIntent*. Each poll lists the PaymentIntents created since a
*cursor*, a bookmark the poller keeps in the database. It records the succeeded ones and moves the
cursor forward:

```js
const cursor = Number(getCursor.get()?.value ?? Math.floor(now / 1000) - 3600);
let newest = cursor;
let found = 0;

for await (const pi of stripe.paymentIntents.list({ created: { gte: cursor }, limit: 100 })) {
  if (pi.status !== 'succeeded') continue;
  if (markSeen(pi.id, 'poll').changes === 1) found++;
  newest = Math.max(newest, pi.created);
}
setCursor.run(String(newest));
```

The cursor is the `created` time of the newest succeeded payment seen so far. On the first run it
starts an hour back. I use `gte` (greater than or equal) rather than `gt` because `created` is in
whole seconds and two payments can share one. Reading a payment twice is harmless, because
`markSeen` ignores a payment it has already recorded.

Two costs are easy to reason about. A payment that succeeds right after a poll waits almost a full
interval. And the poller sends a request on every run, whether or not anything happened.

The cost that surprised me was the cursor itself. It follows the time a payment was *created*, but
some payments succeed later than that. Stripe's docs: "If the payment requires additional actions,
such as authenticating with 3D Secure, the PaymentIntent has a status of requires_action." The fake
can create such a payment, so I tried it (simulated output, trimmed):

```
t+0.0s   created A pi_sim_000001: requires_action (created=1794600143)
t+1.1s   created B pi_sim_000002: succeeded (created=1794600145)
t+1.2s   poll 1: found 1 (cursor moved 1794596545 -> 1794600145)
t+1.2s   A pi_sim_000001 succeeds now (its created time is still 1794600143)
t+1.2s   receiver:    new       evt_sim_000004 payment_intent.succeeded pi_sim_000001
t+1.3s   poll 2: found 0; it only lists payments created at or after 1794600145
```

Payment B moved the cursor past A's creation time, so when A finally succeeded, the poller never
looked at it again. The webhook delivered it straight away. This is a flaw in polling *payments by
creation time*, not in polling itself. Polling the *events* list, which the catch-up job below does,
doesn't have it, because a success event is created when the payment succeeds.

## The webhook version

The receiver is one Express route. This is what arrives (simulated request, trimmed):

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
difference from an API call is who starts it. Here's the handler, trimmed for length:

```js
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  let event;
  try {
    event = Stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], endpointSecret);
  } catch (err) {
    return res.status(400).send(`Signature check failed: ${err.message}`);
  }

  let isNew;
  try {
    isNew = processEventOnce(event.id, 'webhook', () => {
      if (event.type === 'payment_intent.succeeded') markSeen(event.data.object.id, 'webhook');
    });
  } catch (err) {
    return res.sendStatus(500);
  }
  res.sendStatus(200);
});
```

Three details matter more than they look:

1. **Check the signature on the raw body.** Anyone can send a POST to my URL. Stripe's docs: "Stripe
   signs every webhook event by including a signature in the Stripe-Signature header." The signature
   is a keyed hash (HMAC) of the exact bytes sent, made with a secret only Stripe and I know (`whsec_…`).
   `constructEvent` recomputes it and rejects a mismatch. It also rejects timestamps older than 5
   minutes by default, so a captured request can't be replayed later. That's why the route uses
   `express.raw`, not `express.json`: parsing and re-serializing the JSON changes the bytes, and then
   every check fails.
2. **Record the event ID and do the work in one transaction.** A transaction means both database
   writes happen, or neither does. My first draft recorded the event ID first and did the work
   afterwards. If the work failed in between, the event looked processed but nothing had happened,
   and every retry was skipped as a duplicate. Now a failure records nothing and answers 500, so the
   sender retries. (There's a test for exactly this.)
3. **Answer quickly.** A 2xx status means "delivered". Any other status, a timeout or no answer at all
   counts as a failed delivery. Slow work belongs on a queue, after the 200.

`processEventOnce` is the part that remembers event IDs:

```js
const processEventOnce = db.transaction((eventId, source, work) => {
  const isNew = rememberStmt.run(eventId, Date.now(), source).changes === 1; // INSERT OR IGNORE
  if (isNew) work();
  return isNew;
});
```

## Running both side by side

I ran the poller (every 5 s in the simulation) and the receiver at the same time and created 10
payments at random 0.3–2 s gaps. Each payment ends up with one row per method, so the comparison is
per payment (simulated output, trimmed):

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

Nothing here is surprising, and that's the point. The polling delay is set by the interval you
choose, and a poller pays for every run, including the empty ones. In this short run only the first
poll came back empty; on a quiet day, most would.

## Then I killed the endpoint

I stopped the receiver, created 3 payments, and started it again 2.5 seconds after the payments. I
didn't touch anything else (simulated output, one of the three events shown):

```
t+0.0s   fake Stripe: evt_sim_000002 first attempt: connection refused; next retry in 1 s
t+1.0s   fake Stripe: evt_sim_000002 retry 1: connection refused; next retry in 2 s
t+2.9s   receiver started again
t+3.0s   receiver:    new       evt_sim_000002 payment_intent.succeeded pi_sim_000001
t+3.0s   fake Stripe: evt_sim_000002 retry 2: HTTP 200
```

With the receiver gone, nothing was listening on its port, so each delivery attempt failed with
"connection refused". The sender didn't throw the event away; it tried again later. All three
payments arrived through automatic retries, each about 3 seconds after it succeeded, and each was
processed exactly once. A short outage became a delay, not lost data.

The 1-2-4-second schedule is the simulator's. Real Stripe is far more patient, and test mode differs
from live mode. From Stripe's docs: "Stripe attempts to deliver events to your destination for up to
three days with an exponential back off in live mode," and "We retry event deliveries created in a
sandbox three times over the course of a few hours." Stripe also generates "a new signature and
timestamp for the new delivery attempt", so a retry that arrives hours later still passes the
5-minute check. The fake does the same: it signs every attempt afresh.

## The same event, twice

Why would an event arrive twice? A sender can't always tell whether a delivery worked. If my server
processed the event but its 200 response got lost or arrived too late, the sender sees a failure
and tries again. Stripe's docs say plainly that "webhook endpoints might occasionally receive the
same event more than once." I had the fake send one event a second time (simulated output):

```
t+0.0s   receiver:    new       evt_sim_000002 payment_intent.succeeded pi_sim_000001
t+0.1s   receiver:    duplicate evt_sim_000002 payment_intent.succeeded pi_sim_000001
```

The second delivery has the same event ID, so `processEventOnce` skips it. Without that check, a
real shop could ship the same order twice. Handling a repeated message safely like this is called
being *idempotent*. Stripe also mentions rarer cases where "two separate Event objects are generated
and sent" for the same object. An event-ID check alone wouldn't catch those, which is why the work
itself should be idempotent too. Here it is: `markSeen` records each payment ID only once.

## When the retries run out: the poll I kept

Retries only cover outages shorter than the retry window. So I kept the receiver down longer than the
simulator's whole schedule (simulated output, trimmed):

```
t+7.0s   fake Stripe: evt_sim_000002 retry 3: connection refused; no retries left, giving up
t+7.2s   receiver started again; no retries are coming
t+7.7s   payments the app doesn't know about: 2
```

Nothing errored and nothing alerted. A webhook you never received looks exactly like a payment that
never happened. The fix is *reconciliation*: now and then, compare your records with the provider's
and fill in the gaps. Here, that's a slow poll of Stripe's event history (simplified):

```js
for await (const event of stripe.events.list({ type: 'payment_intent.succeeded', created: { gte: since }, limit: 100 })) {
  const paymentId = event.data.object.id;
  if (processEventOnce(event.id, 'reconcile', () => markSeen(paymentId, 'reconcile'))) {
    recovered.push({ eventId: event.id, paymentId });
  }
}
```

```
t+7.7s   reconcile:   recovered evt_sim_000004 (payment pi_sim_000003)
t+7.7s   reconcile:   recovered evt_sim_000002 (payment pi_sim_000001)
t+7.7s   reconcile:   reconcile done: 2 event(s) checked, 2 recovered
t+7.7s   reconcile:   reconcile done: 2 event(s) checked, 0 recovered
```

It uses the same `processEventOnce` as the receiver, so whichever path sees an event first does the
work and the other skips it; the second run changed nothing. The job doesn't depend on the webhook
endpoint at all, so it doesn't matter how long the endpoint was down. What matters is that the job
runs more often than events disappear from the list, and Stripe lists events "going back up to 30
days". My version looks back 3 days by default, so running it hourly leaves plenty of overlap. It
also catches what retries can't: a deleted endpoint, or a bug that answered 200 without recording
the event. And because it reads *events* rather than payments, it doesn't have my first poller's
late-success blind spot.

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

Shown in the demo:

- **Verify the signature on the raw body.** A JSON parser that runs first breaks every check.
- **Record the event ID and do the work in one transaction**, or a failure in between loses the event.
- **Dedupe by event ID.** Retries, resends and the catch-up job all bring events you may already have.
- **A cursor on `created` misses late successes.** If you keep a poll, poll events.
- **Keep a reconciliation job.** Retries end; the events list keeps 30 days.

From Stripe's documentation, not shown in the demo:

- **Reply 2xx fast.** "Quickly returns a successful status code (2xx) before any complex logic that might cause a timeout."
- **Don't assume order.** "Stripe doesn't guarantee the delivery of events in the order that they're generated."
- **Test-mode retries aren't live-mode retries.** Three times over a few hours in a sandbox, up to three days live.

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

- Stripe: [Receive Stripe events in your webhook endpoint](https://docs.stripe.com/webhooks) (retries, signatures, duplicates, ordering)
- Stripe: [How PaymentIntents work](https://docs.stripe.com/payments/paymentintents/lifecycle) (`requires_action`)
- Stripe API: [List all events](https://docs.stripe.com/api/events/list)
- Stripe: [Testing](https://docs.stripe.com/testing) (`pm_card_visa`)
- Code and simulated output: [REPO LINK]
