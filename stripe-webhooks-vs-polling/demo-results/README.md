# ⚠️ Simulated output: not Stripe data

Produced by `npm run demo` against `test/support/fake-stripe.js`, a local stand-in for Stripe,
on a compressed timescale (payments 1–4 s apart, poller every 10 s, retries after 5/10/20 s).

It shows that the scripts work together end to end and what each output file looks like.
**None of these numbers belong in the article.** Real results go in `../results/` after you run
the experiment against Stripe test mode (see the main README).
