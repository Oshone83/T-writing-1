# Real results (Stripe test mode)

Empty until the live run. `./exp analyze` writes here:

| File | Contents |
|---|---|
| `summary.md` | All numbers, with validity checks (quiet hour, 60-minute window, poll interval) |
| `article-values.md` | Every article placeholder, filled or [PENDING] |
| `delays.csv` | Raw per-payment timestamps: created, poll seen, webhook arrival, webhook seen |
| `outage.csv` | Outage payments: Dashboard attempts, Stripe pending view, retry delivery, total delay |
| `lost-event.csv` | The reconcile demonstration |
| `api-calls-by-hour.csv` | Poll requests per UTC hour |
| `delay-chart.svg` | One mark per payment and method |
| `summary.json` | Everything above, machine-readable |
| `raw-request.txt` | First genuine Stripe delivery, signature and IDs shortened |

`analyze.js` refuses to write here if the database contains simulated (fake Stripe) payments.
