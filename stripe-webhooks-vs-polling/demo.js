// demo.js — the whole story in about a minute, against the local fake Stripe (a SIMULATION).
//
//   npm run demo        prints each scenario and writes demo-output/ (transcript, chart, raw request)
//
// Every scenario builds a fresh "world": a fake Stripe server, an in-memory database and the real
// receiver, talking over real HTTP on localhost. The poller, receiver and reconcile code are the same
// files you run by hand. Each scenario checks its own claims; the demo exits with an error if any
// check fails. Timings are compressed (seconds instead of minutes/hours) so it runs quickly.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { isMain, PROJECT_DIR } from './lib/env.js';
import { openDb, makeHelpers } from './lib/db.js';
import { createStripe } from './lib/stripe-client.js';
import { startEvery } from './lib/loop.js';
import { paymentRows, delaySummary, apiCallCounts, deliveryCounts } from './lib/report.js';
import { renderChart } from './lib/chart.js';
import { createFakeStripe } from './fake-stripe.js';
import { createApp } from './receiver.js';
import { pollOnce } from './poll.js';
import { reconcile } from './reconcile.js';
import { createPayment, createPayments } from './create-payments.js';

// Simulated timings. Real-world equivalents are in the README ("Limits of the simulation").
export const DEFAULT_TIMINGS = {
  pollEveryMs: 5000,                  // a cron poller would typically run every 60 s
  retryDelaysMs: [1000, 2000, 4000],  // the fake's wait before retry 1, 2, 3. Stripe (per its docs): sandbox
                                      // 3 retries over a few hours; live mode up to 3 days
  payments: 10, minGapMs: 300, maxGapMs: 2000,
  outageMs: 2500,                     // scenario 3: receiver stays down this long after the payments
};

const SECRET = 'whsec_local_simulation_secret';
const KEY = 'sk_test_local_simulation_key';
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const s2 = (ms) => `${(ms / 1000).toFixed(2)} s`;

// A fresh world: fake Stripe + database + receiver that can be stopped and started again.
async function makeWorld({ retryDelaysMs, say }) {
  const t0 = Date.now();
  const rel = () => `t+${((Date.now() - t0) / 1000).toFixed(1)}s`.padEnd(8);
  const port = await freePort();
  const db = openDb(':memory:');
  const { logApiCall } = makeHelpers(db);
  const requests = [];
  const fake = createFakeStripe({
    webhookUrl: `http://127.0.0.1:${port}/webhooks/stripe`, webhookSecret: SECRET, retryDelaysMs,
    log: (m) => say(`    ${rel()} fake Stripe: ${m}`),
  });
  const apiBase = await fake.start();
  const stripeFor = (source) => createStripe({ key: KEY, apiBase, onRequest: () => logApiCall(source) });
  const app = createApp({
    db, endpointSecret: SECRET, logRequests: true,
    log: (m) => (m.startsWith('POST ') ? requests.push(m) : say(`    ${rel()} receiver:    ${m}`)),
  });
  let server = null;
  const world = {
    db, fake, stripeFor, requests, say: (m) => say(`    ${rel()} ${m}`),
    startReceiver: () => new Promise((r) => { server = app.listen(port, '127.0.0.1', r); }),
    // Like a crash: close the port and drop open connections at once.
    stopReceiver: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); server = null; }),
    close: async () => { if (server) await world.stopReceiver(); await fake.stop(); db.close(); },
  };
  return world;
}

async function waitFor(cond, timeoutMs, stepMs = 50) {
  const until = Date.now() + timeoutMs;
  while (!cond()) { if (Date.now() > until) return false; await sleep(stepMs); }
  return true;
}

export async function runDemo({ timings = DEFAULT_TIMINGS, log = console.log, outDir } = {}) {
  const T = { ...DEFAULT_TIMINGS, ...timings };
  const md = [];
  const checks = [];
  const say = (m = '') => { log(m); md.push(m); };
  const check = (ok, text) => { checks.push({ ok, text }); say(`  ${ok ? '✓' : '✗'} ${text}`); };
  const artifacts = {};

  say('> **SIMULATED.** Everything below ran against `fake-stripe.js`, a local stand-in for Stripe, with');
  say(`> compressed timings: the poller runs every ${T.pollEveryMs / 1000} s; when a webhook delivery fails, the fake waits ${T.retryDelaysMs.map((x) => x / 1000).join(', ')} s between attempts, then gives up.`);
  say('> The numbers show the *mechanisms*, not real-world Stripe latency or retry schedules. Anything the fake does is labelled "fake Stripe".');
  say();

  // ── 1 ────────────────────────────────────────────────────────────────────────────────────────
  say('## 1. Polling and webhooks, side by side');
  say(`Both run at once. ${T.payments} payments are created at random ${T.minGapMs / 1000}–${T.maxGapMs / 1000} s gaps. The poller asks every ${T.pollEveryMs / 1000} s; the fake Stripe POSTs a webhook the moment each payment succeeds.`);
  say('```');
  {
    const w = await makeWorld({ retryDelaysMs: T.retryDelaysMs, say: () => {} }); // too chatty to narrate
    await w.startReceiver();
    const pollStripe = w.stripeFor('poll');
    let runs = 0, emptyRuns = 0;
    const stopPolling = startEvery(T.pollEveryMs, async () => {
      const r = await pollOnce({ db: w.db, stripe: pollStripe });
      runs++; if (r.found === 0) emptyRuns++;
    });
    await createPayments({ db: w.db, stripe: w.stripeFor('create'), count: T.payments, minGapMs: T.minGapMs, maxGapMs: T.maxGapMs, phase: 'side-by-side', log: () => {} });
    await sleep(T.pollEveryMs + 500); // let the poller catch the last payment
    await stopPolling();

    const rows = paymentRows(w.db);
    const s = delaySummary(rows);
    say('payment              polling delay   webhook delay');
    for (const r of rows) say(`${r.id.padEnd(20)} ${s2(r.poll_ms - r.created_ms).padStart(13)}   ${s2(r.webhook_ms - r.created_ms).padStart(13)}`);
    say(`median               ${s2(s.poll.median).padStart(13)}   ${s2(s.webhook.median).padStart(13)}`);
    say(`worst                ${s2(s.poll.max).padStart(13)}   ${s2(s.webhook.max).padStart(13)}`);
    const calls = apiCallCounts(w.db);
    say(`API requests to Stripe: poller ${calls.poll ?? 0} (${runs} polls, ${emptyRuns} found nothing new), receiver 0`);
    say('```');
    check(s.missedByPoll.length === 0 && s.missedByWebhook.length === 0, `both methods saw all ${rows.length} payments`);
    check(s.poll.max <= T.pollEveryMs + 1000, `polling delay never exceeded one poll interval (${T.pollEveryMs / 1000} s) plus run time`);
    check(s.webhook.median < s.poll.median, 'webhook median delay is lower than polling median delay');
    check(emptyRuns >= 1 && (calls.poll ?? 0) >= runs, 'the poller made requests that found nothing (the cost of asking)');
    artifacts.chart = renderChart(rows, { subtitle: `SIMULATED · ${rows.length} payments · poll every ${T.pollEveryMs / 1000} s` });
    artifacts.request = w.requests[0];
    await w.close();
  }
  say('What this shows: a poller learns about a payment only at its next run, so its delay is anywhere between 0 and one interval, and it pays for every run, including the empty ones. The webhook arrives as soon as the event happens and costs no requests from our side.');
  say();

  // ── 2 ────────────────────────────────────────────────────────────────────────────────────────
  say('## 2. The polling cursor misses a payment that succeeds late');
  say('Payment A needs 3-D Secure, so it is created as `requires_action`. Payment B is created a second later and succeeds at once. The poller runs, then A\'s customer finishes 3-D Secure and A succeeds, and the poller runs again.');
  say('```');
  {
    const w = await makeWorld({ retryDelaysMs: T.retryDelaysMs, say });
    await w.startReceiver();
    const stripe = w.stripeFor('poll');
    const a = await createPayment({ db: w.db, stripe: w.stripeFor('create'), paymentMethod: 'pm_card_threeDSecure2Required', phase: 'cursor' });
    w.say(`created A ${a.id}: ${a.status} (created=${a.created})`);
    await sleep(1100); // B gets a later `created` second
    const b = await createPayment({ db: w.db, stripe: w.stripeFor('create'), phase: 'cursor' });
    w.say(`created B ${b.id}: ${b.status} (created=${b.created})`);
    await sleep(100);
    let r = await pollOnce({ db: w.db, stripe });
    w.say(`poll 1: found ${r.found} (cursor moved ${r.cursor} -> ${r.newest})`);
    w.fake.succeed(a.id); // the customer completes 3-D Secure
    w.db.prepare("INSERT INTO payments (id, created_ms, phase) VALUES (?, ?, 'cursor')").run(a.id, Date.now());
    w.say(`A ${a.id} succeeds now (its created time is still ${a.created})`);
    await waitFor(() => w.db.prepare("SELECT 1 FROM seen WHERE id = ? AND method = 'webhook'").get(a.id), 3000);
    r = await pollOnce({ db: w.db, stripe });
    w.say(`poll 2: found ${r.found}; it only lists payments created at or after ${r.cursor}`);
    const seenA = (m) => Boolean(w.db.prepare('SELECT 1 FROM seen WHERE id = ? AND method = ?').get(a.id, m));
    say('```');
    check(!seenA('poll'), 'the poller never saw payment A succeed');
    check(seenA('webhook'), 'the webhook delivered payment A as soon as it succeeded');
    await w.close();
  }
  say('What this shows: polling *objects* by creation time misses late state changes. It is a flaw in this poller design, not in polling as such: polling the *events* list (what reconcile.js does) sees the success event whenever it happens.');
  say();

  // ── 3 ────────────────────────────────────────────────────────────────────────────────────────
  say('## 3. I killed the endpoint: retries deliver the events later');
  say(`The receiver is stopped, 3 payments succeed, and the receiver starts again ${T.outageMs / 1000} s after the payments. Nobody presses "resend".`);
  say('```');
  {
    const w = await makeWorld({ retryDelaysMs: T.retryDelaysMs, say });
    await w.startReceiver();
    await w.stopReceiver();
    w.say('receiver stopped');
    await createPayments({ db: w.db, stripe: w.stripeFor('create'), count: 3, minGapMs: 100, maxGapMs: 300, phase: 'outage', log: () => {} });
    await sleep(T.outageMs);
    await w.startReceiver();
    w.say('receiver started again');
    const ok = await waitFor(() => delaySummary(paymentRows(w.db)).missedByWebhook.length === 0, T.retryDelaysMs.reduce((x, y) => x + y, 0) + 2000);
    const rows = paymentRows(w.db);
    say('```');
    const failed = w.fake.attempts.filter((x) => !x.result.startsWith('HTTP 2')).length;
    check(failed >= 3, `${failed} delivery attempts failed while the endpoint was down`);
    check(ok, 'every payment was delivered by an automatic retry once the endpoint was back');
    check(deliveryCounts(w.db).duplicates === 0, 'each event was processed exactly once');
    say(`Delay from payment to "app knows" during the outage: ${rows.map((x) => s2(x.webhook_ms - x.created_ms)).join(', ')}.`);
    await w.close();
  }
  say('What this shows: a failed delivery is not a lost event; the sender keeps it and tries again (here the fake; Stripe documents the same, over hours or days). The outage turned into delay, as long as it ended before the retries ran out.');
  say();

  // ── 4 ────────────────────────────────────────────────────────────────────────────────────────
  say('## 4. The same event delivered twice');
  say('The fake Stripe sends one event a second time. Stripe documents that this can occasionally happen.');
  say('```');
  {
    const w = await makeWorld({ retryDelaysMs: T.retryDelaysMs, say });
    await w.startReceiver();
    const [pi] = await createPayments({ db: w.db, stripe: w.stripeFor('create'), count: 1, minGapMs: 0, maxGapMs: 0, phase: 'duplicate', log: () => {} });
    await waitFor(() => w.fake.attempts.length >= 1, 2000);
    const event = w.fake.events.find((e) => e.data.object.id === pi.id);
    await w.fake.resend(event.id);
    say('```');
    const d = deliveryCounts(w.db);
    check(d.total === 2 && d.duplicates === 1, 'two deliveries arrived, the second was recognised by its event ID');
    check(w.db.prepare('SELECT COUNT(*) n FROM processed_events').get().n === 1, 'the payment was processed once');
    await w.close();
  }
  say('What this shows: retries and resends reuse the event ID, so remembering processed event IDs makes a second delivery harmless.');
  say();

  // ── 5 ────────────────────────────────────────────────────────────────────────────────────────
  const giveUpMs = T.retryDelaysMs.reduce((x, y) => x + y, 0);
  say('## 5. The retries run out; the reconcile job recovers the events');
  say(`This time the endpoint stays down longer than the whole retry schedule (${giveUpMs / 1000} s in the simulation), so the fake gives up on both events.`);
  say('```');
  {
    const w = await makeWorld({ retryDelaysMs: T.retryDelaysMs, say });
    await w.startReceiver();
    await w.stopReceiver();
    w.say('receiver stopped');
    await createPayments({ db: w.db, stripe: w.stripeFor('create'), count: 2, minGapMs: 100, maxGapMs: 200, phase: 'lost', log: () => {} });
    await waitFor(() => w.fake.attempts.length >= 2 * (T.retryDelaysMs.length + 1), giveUpMs + 3000);
    await w.startReceiver();
    w.say('receiver started again; no retries are coming');
    await sleep(500);
    const lostBefore = delaySummary(paymentRows(w.db)).missedByWebhook.length;
    w.say(`payments the app doesn't know about: ${lostBefore}`);
    const stripe = w.stripeFor('reconcile');
    const first = await reconcile({ db: w.db, stripe, log: (m) => w.say(`reconcile:   ${m}`) });
    const second = await reconcile({ db: w.db, stripe, log: (m) => w.say(`reconcile:   ${m}`) });
    say('```');
    check(lostBefore === 2, 'after the retries ran out, the app had silently missed both payments');
    check(first.recovered.length === 2, 'reconcile.js found both in Stripe\'s events list and processed them');
    check(second.recovered.length === 0, 'running reconcile again changed nothing (same event-ID table)');
    await w.close();
  }
  say('What this shows: retries cover short outages only. A slow poll of the events list catches whatever the webhook path missed, and the shared event-ID table means the two paths never process a payment twice.');
  say();

  const failedChecks = checks.filter((c) => !c.ok);
  say(`**${checks.length - failedChecks.length} of ${checks.length} checks passed.**`);

  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    const header = `# Demo output (SIMULATED)\n\nGenerated by \`npm run demo\` on ${new Date().toISOString().slice(0, 10)} with Node ${process.version}.\nRe-running gives different numbers (payment gaps are random); the checks should always pass.\n\n`;
    fs.writeFileSync(path.join(outDir, 'demo-output.md'), header + md.join('\n') + '\n');
    fs.writeFileSync(path.join(outDir, 'polling-vs-webhooks.svg'), artifacts.chart);
    fs.writeFileSync(path.join(outDir, 'sample-webhook-request.txt'),
      '# One webhook request as the receiver saw it. SIMULATED: sent by fake-stripe.js, not Stripe.\n' +
      '# Like Stripe, it is a plain POST with a JSON event (id, type, data.object) and a Stripe-Signature\n' +
      '# header holding a timestamp (t=) and an HMAC signature (v1=). Other headers and fields differ.\n\n' + artifacts.request + '\n');
  }
  return { checks, ok: failedChecks.length === 0 };
}

if (isMain(import.meta.url)) {
  const outDir = path.join(PROJECT_DIR, 'demo-output');
  const { ok } = await runDemo({ outDir });
  console.log(`\nwrote ${path.relative(process.cwd(), outDir) || outDir}/ (demo-output.md, polling-vs-webhooks.svg, sample-webhook-request.txt)`);
  process.exit(ok ? 0 : 1);
}
