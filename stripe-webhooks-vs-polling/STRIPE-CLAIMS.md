# Stripe claims: what was checked, and how

Checked on **2026-11-12** against the official Stripe docs (fetched from docs.stripe.com) and the
installed `stripe` Node SDK 23.1.0. Stripe changes its docs; re-check before publishing.

## Verified against official Stripe documentation

| Claim (as used in the article / this repo) | Stripe's words | Source |
|---|---|---|
| Live mode retries for up to three days with exponential backoff | "Stripe attempts to deliver events to your destination for up to three days with an exponential back off in live mode." | docs.stripe.com/webhooks, *Automatic retries* |
| Test mode (sandbox) retries three times over a few hours | "We retry event deliveries created in a sandbox three times over the course of a few hours." | docs.stripe.com/webhooks, *Automatic retries* |
| The next retry time is shown in the Dashboard | "View when the next retry will occur, if applicable, in your event destination's Event deliveries tab." | docs.stripe.com/webhooks |
| A disabled or deleted endpoint stops retries | "If your destination has been disabled or deleted when we attempt a retry, we prevent future retries of that event." | docs.stripe.com/webhooks |
| A manual resend doesn't cancel automatic retries | "Manually resending an event that failed to reach a webhook endpoint doesn't cancel Stripe's automatic retry behavior, even if it results in a 2xx status code." | docs.stripe.com/webhooks |
| Every retry gets a fresh `t=` and signature | "If Stripe retries an event (for example, your endpoint previously replied with a non-2xx status code), then we generate a new signature and timestamp for the new delivery attempt." | docs.stripe.com/webhooks, *Prevent replay attacks* |
| Default signature tolerance is 5 minutes | "Our libraries have a default tolerance of 5 minutes between the timestamp and the current time." | docs.stripe.com/webhooks |
| Event order is not guaranteed | "Stripe doesn't guarantee the delivery of events in the order that they're generated." | docs.stripe.com/webhooks |
| The same event can arrive more than once; dedupe by event ID | "Webhook endpoints might occasionally receive the same event more than once. You can guard against duplicated event receipts by logging the event IDs you've processed…" | docs.stripe.com/webhooks, *Handle duplicate events* |
| …and sometimes as two different events for one object | "In some cases, two separate Event objects are generated and sent. To identify these duplicates, use the ID of the object in data.object along with the event.type." | docs.stripe.com/webhooks |
| Don't use `created` for order or dedupe | "Snapshot events record created in seconds, so distinct events can share a timestamp. Don't use created to determine event order or whether you've already processed an event." | docs.stripe.com/webhooks |
| Reply 2xx before slow work | "Quickly returns a successful status code (2xx) before any complex logic that might cause a timeout." | docs.stripe.com/webhooks |
| Events can be listed back 30 days | "List events, going back up to 30 days." / "Stripe only returns events created in the last 30 days." | docs.stripe.com/api/events/list; docs.stripe.com/webhooks/process-undelivered-events |
| An event can be retrieved for 30 days | "Retrieves the details of an event if it was created in the last 30 days." | docs.stripe.com/api/events/object |
| List events can filter undelivered events | "delivery_success: Set to false to return events with deliveries that are still pending or have failed all delivery attempts to at least one of your endpoints." | docs.stripe.com/webhooks/process-undelivered-events |
| Events carry a `pending_webhooks` count | `pending_webhooks` (integer) is a field of the Event object | docs.stripe.com/api/events/object |
| Dashboard steps to create an endpoint | "Open the Webhooks tab in Workbench. Click Create an event destination. Select Your account… Choose the payload format: Thin (recommended) or Snapshot… Select Continue, then select Webhook endpoint… provide the Endpoint URL… a signing secret beginning with whsec_ appears. Click Reveal secret…" | docs.stripe.com/webhooks, *Create an event destination* |

**Consequence for this project:** the Dashboard's default payload format is **Thin**. This receiver
handles **Snapshot** events (it reads the PaymentIntent from `event.data.object`), so you must pick
**Snapshot** when creating the destination.

## Verified in the installed SDK source (stripe-node 23.1.0), not in the docs

| Behaviour | Where |
|---|---|
| `constructEvent` default tolerance is 300 s, and it rejects a signature when `now − t > tolerance` | `node_modules/stripe/esm/Webhooks.js` (`DEFAULT_TOLERANCE: 300`, `timestampAge > tolerance`) |
| The SDK retries failed requests twice by default | `node_modules/stripe/esm/platform/PlatformFunctions.js` (`getDefaultMaxNetworkRetries` returns 2) |
| The `request` event fires once per HTTP attempt, retries included, so the API-call counts include them | `node_modules/stripe/esm/RequestSender.js` (`emit('request')` inside the per-attempt `makeRequest`) |

## Not verified

| Claim | Status |
|---|---|
| Whether events forwarded by `stripe listen` are retried like a registered endpoint | The docs page describes `stripe listen` for local testing but says nothing about its retries. The article only relies on using a registered endpoint, which the docs do cover. |
| Exact test-mode retry times (minutes between attempts) | Not documented beyond "three times over the course of a few hours". Your outage run measures it. |
| Whether `pm_card_visa` + `confirm: true` + `automatic_payment_methods.allow_redirects: 'never'` returns `succeeded` | Not checked against the docs. The smoke test (one payment) shows it on the real API. |
| Any public API listing individual delivery attempts and their status codes | None found in the pages checked. The repo treats the Dashboard as the only source (manual/dashboard-delivery-attempts.csv) and uses `delivery_success=false` + `pending_webhooks` for Stripe's own pending view. |
