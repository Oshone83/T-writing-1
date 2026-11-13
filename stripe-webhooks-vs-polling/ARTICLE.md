<!--
Draft notes (delete before publishing):
- Every number below is from the SIMULATED run committed in demo-output/demo-output.md. If you re-run
  `npm run demo`, the numbers change (payment gaps are random); update them or keep the committed run.
- Replace [REPO LINK] with the repository URL, and add the chart image (demo-output/polling-vs-webhooks.svg).
- The story is first person. Keep it true: this describes building this project, not a production system.
-->

# I replaced payment polling with webhooks, then killed the endpoint: what I learned

Every "webhooks vs polling" article says webhooks are faster and cheaper. Fewer of them show what
happens when the webhook endpoint is down. So I built a small payment app twice, first with a poller
that asks Stripe "anything new?" on a timer, then with a webhook receiver, and then I switched the
receiver off on purpose.

To make the failures easy to reproduce, everything runs against a small local simulation of Stripe.
The code uses the official Stripe Node.js SDK and verifies real Stripe-style webhook signatures; only
the server on the other end is fake. All timings below come from that simulation, compressed so the
whole thing runs in a minute. They show *how* each approach behaves, not real-world Stripe latency.

Code: [REPO LINK]. `npm install && npm run demo` reproduces everything below.

## What I learned, at a glance

| | Polling | Webhooks |
|---|---|---|
| How the app finds out | Asks on a timer | Stripe POSTs to my endpoint |
| Delay | Between 0 and one poll interval | As soon as the event happens (plus network) |
| Requests from my side | One per poll, including the empty ones | None |
| Simulated run, 10 payments (poll every 5 s) | median 2.86 s, worst 4.99 s, 3 polls for 10 payments | median 0.02 s, worst 0.04 s, 0 requests |
| Endpoint down briefly | Nothing to go down | Deliveries fail, retries deliver later |
| Endpoint down longer than the retries | Nothing to go down | Payments silently missed, unless something reconciles |
| Payment that succeeds late | My cursor-based poller missed it | Delivered when it succeeded |

The webhook figure has no internet in it (everything ran on one machine), and the polling figure
scales with the interval: with a 60-second cron job, expect up to a minute.

## The setup

Four small Node.js scripts share one SQLite database file, and a fifth plays Stripe:

- `create-payments.js` creates test payments with Stripe's `pm_card_visa` test card.
- `poll.js` is the poller; `receiver.js` is an Express webhook endpoint.
- `reconcile.js` is a catch-up job that reads Stripe's event history.
- `fake-stripe.js` is the simulation: it answers the few Stripe API calls these scripts make, and
  POSTs signed `payment_intent.succeeded` events to the receiver, retrying failures 1, 2 and 4 seconds
  later before giving up. (Real Stripe's schedule is much longer; more on that below.)

"The app knows" means the moment a script wrote the payment's ID to the database. The delay is that
moment minus the moment the create call returned a succeeded payment, both measured on the same clock.

## The polling version

The poller lists PaymentIntents created since the last run, records the succeeded ones and saves a
cursor:

```js
const cursor = Number(getCursor.get()?.value ?? Math.floor(now / 1000) - 3600);
let newest = cursor;

for await (const pi of stripe.paymentIntents.list({ created: { gte: cursor }, limit: 100 })) {
  if (pi.status !== 'succeeded') continue;
  if (markSeen(pi.id, 'poll').changes === 1) found++;
  newest = Math.max(newest, pi.created);
}
setCursor.run(String(newest));
```

`gte` rather than `gt` because `created` is in whole seconds and two payments can share one; the
`seen` table's primary key makes reading a payment twice harmless.

The costs are easy to reason about. A payment that succeeds right after a poll waits almost a full
interval, and the poller makes requests whether or not anything happened.

The cost that surprised me was the cursor. It follows the time a payment was *created*. Some payments
succeed later than that: a card that needs 3-D Secure, for example, is `requires_action` until the
customer finishes the check. I simulated exactly that (simulated output):

```
t+0.0s   created A pi_sim_000001: requires_action (created=1794590393)
t+1.1s   created B pi_sim_000002: succeeded (created=1794590394)
t+1.2s   poll 1: found 1 (cursor moved 1794586794 -> 1794590394)
t+1.2s   A pi_sim_000001 succeeds now (its created time is still 1794590393)
t+1.2s   receiver:    new       evt_sim_000004 payment_intent.succeeded pi_sim_000001
t+1.3s   poll 2: found 0; it only lists payments created at or after 1794590394
```

Payment B moved the cursor past A's creation time, so when A finally succeeded, the poller never
looked at it again. The webhook delivered it immediately. This is a flaw in polling *objects by
creation time*, not in polling as such; polling the *events* list (which the catch-up job below does)
doesn't have it.

## The webhook version

The receiver is one Express route. This is what actually arrives (simulated request, trimmed):

```
POST /webhooks/stripe
content-type: application/json; charset=utf-8
stripe-signature: t=1794590205,v1=7ffe2aa58d5638fe…
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

1. **`express.raw`, not `express.json`.** The signature covers the exact bytes Stripe sent. Parse and
   re-serialize the JSON first and every check fails. Stripe's docs: "Stripe signs every webhook event
   by including a signature in the Stripe-Signature header." `constructEvent` recomputes it with my
   `whsec_` secret and, by default, rejects timestamps older than 5 minutes.
2. **The event ID is recorded and the work is done in one transaction.** My first draft inserted the
   event ID first and did the work afterwards. If the work failed in between, the event was marked
   processed but nothing happened, and every retry was skipped as a duplicate. Now the two succeed or
   fail together, and a failure answers 500 so Stripe retries. (There's a test for exactly this.)
3. **Answer fast.** Anything but a 2xx, including a timeout, counts as a failed delivery. Slow work
   belongs on a queue.

`processEventOnce` is the event-ID table at work:

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
per payment (simulated output):

```
payment              polling delay   webhook delay
pi_sim_000001               4.99 s          0.04 s
pi_sim_000003               3.94 s          0.02 s
pi_sim_000005               2.58 s          0.02 s
pi_sim_000007               1.05 s          0.02 s
pi_sim_000009               4.63 s          0.02 s
…
median                      2.86 s          0.02 s
worst                       4.99 s          0.04 s
API requests to Stripe: poller 3 (3 polls, 1 found nothing new), receiver 0
```

[Chart: demo-output/polling-vs-webhooks.svg. Polling delays climb and drop back with each poll (a
saw-tooth between 0 and 5 s); webhook delays sit in a flat line near zero.]

Nothing here is surprising, which is the point: the polling delay is set by the interval you choose,
and a quiet system still pays for every poll.

## Then I killed the endpoint

I stopped the receiver, created 3 payments, and started it again 2.5 seconds later. I didn't press
any "resend" button (simulated output):

```
t+0.0s   fake Stripe: evt_sim_000002 first attempt: connection refused; next retry in 1 s
t+1.0s   fake Stripe: evt_sim_000002 retry 1: connection refused; next retry in 2 s
t+2.8s   receiver started again
t+3.0s   receiver:    new       evt_sim_000002 payment_intent.succeeded pi_sim_000001
t+3.0s   fake Stripe: evt_sim_000002 retry 2: HTTP 200
```

All three payments arrived through automatic retries, each about 3 seconds after it succeeded, and
each was processed exactly once. A failed delivery isn't a lost event: the sender keeps it and tries
again, so a short outage becomes a delay.

The simulation retries after 1, 2 and 4 seconds. Real Stripe is far more patient, and test mode
differs from live mode. From Stripe's docs: "Stripe attempts to deliver events to your destination
for up to three days with an exponential back off in live mode," and "We retry event deliveries
created in a sandbox three times over the course of a few hours." Each retry carries "a new
signature and timestamp", so a retry hours later still passes the 5-minute check.

## The same event, twice

Stripe's docs warn that "webhook endpoints might occasionally receive the same event more than
once." I had the fake send one event a second time (simulated output):

```
t+0.0s   receiver:    new       evt_sim_000002 payment_intent.succeeded pi_sim_000001
t+0.1s   receiver:    duplicate evt_sim_000002 payment_intent.succeeded pi_sim_000001
```

The second delivery has the same event ID, so the event-ID table turns it into a no-op. Stripe also
mentions rarer cases where "two separate Event objects are generated and sent" for one object; an
event-ID check alone wouldn't catch those, which is one more reason to make the work itself
idempotent (here, the `seen` table is keyed by payment ID).

## When the retries run out: the poll I kept

Retries only cover outages shorter than the retry window. So I kept the receiver down longer than
the simulation's whole schedule (simulated output):

```
t+7.0s   fake Stripe: evt_sim_000002 retry 3: connection refused; no retries left, giving up
t+7.2s   receiver started again; no retries are coming
t+7.7s   payments the app doesn't know about: 2
```

Nothing errored and nothing alerted. A webhook you never received looks exactly like a payment that
never happened. The fix is a slow poll of Stripe's event history:

```js
for await (const event of stripe.events.list({ type: 'payment_intent.succeeded', created: { gte: since }, limit: 100 })) {
  if (processEventOnce(event.id, 'reconcile', () => markSeen(event.data.object.id, 'reconcile'))) {
    recovered.push(event.id);
  }
}
```

```
t+7.7s   reconcile:   recovered evt_sim_000004 (payment pi_sim_000003)
t+7.7s   reconcile:   recovered evt_sim_000002 (payment pi_sim_000001)
t+7.7s   reconcile:   reconcile done: 2 event(s) checked, 2 recovered
t+7.7s   reconcile:   reconcile done: 2 event(s) checked, 0 recovered
```

It uses the same event-ID table as the receiver, so whichever path sees an event first does the
work and the other skips it; the second run changed nothing. Stripe's events list goes "back up to
30 days", so an hourly run with a few days of look-back covers any outage shorter than that. It also
covers the cases retries can't: a deleted endpoint, or a bug that answered 200 and dropped the work.
And because it polls *events* rather than payments, it doesn't have the late-success blind spot my
first poller had.

## What I'd run

Webhooks as the main path, and an hourly reconcile job as the safety net, both writing through the
same event-ID check. If you're moving a live poller over:

1. Add the receiver and the event-ID table while the poller still runs.
2. Make the work idempotent on the payment ID, so whichever method sees a payment first wins.
3. Compare the two for a while (this repo's `npm run report` does it per payment).
4. Turn the poller into a slow reconcile job over the events list. Don't delete it.

My rule of thumb: polling alone is fine for a handful of payments a day where nobody notices a
minute's delay. Once delay matters, or most of your polls find nothing, switch to webhooks. Either
way, keep a slow poll of the events list.

## Gotchas, each one shown above

- **Verify the signature on the raw body.** A JSON parser that runs first breaks every check.
- **Record the event ID and do the work in one transaction**, or a failure in between loses the event.
- **Reply 2xx fast.** Do slow work on a queue.
- **Dedupe by event ID.** Retries, resends and the catch-up job all bring events you may already have.
- **Don't assume order.** "Stripe doesn't guarantee the delivery of events in the order that they're generated."
- **Test-mode retries aren't live-mode retries.** A few hours in a sandbox, up to three days live.
- **A cursor on `created` misses late successes.** If you keep a poll, poll events.
- **Keep a reconciliation job.** Retries end; the events list stays for 30 days.

## FAQ

**Is a webhook an API?** A webhook is an HTTP request the provider sends to a URL you expose when
something happens. An API call is a request you send to the provider when you decide to ask. Both are
plain HTTP; the difference is who starts the conversation.

**Do webhooks replace polling?** Mostly. In my simulation the webhook path delivered every payment
with no requests from my side. But I still run a slow catch-up poll, because retries stop eventually.

**What happens if my server is down when a webhook is sent?** The delivery fails and Stripe retries:
up to three days in live mode, three times over a few hours in a sandbox. Anything that outlasts the
retries needs a catch-up job that reads the events list.

**Can I try this without a Stripe account?** Yes. Everything above runs against the local
simulation: `npm install && npm run demo`. The README also shows how to point the same scripts at
real Stripe test mode with the Stripe CLI.

## Sources

- Stripe: [Receive Stripe events in your webhook endpoint](https://docs.stripe.com/webhooks) (retries, signatures, duplicates, ordering)
- Stripe API: [List all events](https://docs.stripe.com/api/events/list)
- Stripe: [Process undelivered events](https://docs.stripe.com/webhooks/process-undelivered-events)
- Stripe: [Testing](https://docs.stripe.com/testing) (`pm_card_visa`, `pm_card_threeDSecure2Required`)
- Code and simulated output: [REPO LINK]
