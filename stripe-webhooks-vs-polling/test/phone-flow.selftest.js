// test/phone-flow.selftest.js — runs the real ./exp commands, in runbook order, against the local
// fake Stripe. Uses a temporary DATA_DIR, so the real payments.db, logs/ and results/ are never
// touched. The poller runs at the experiment's real 60 s interval, so this takes about 3 minutes.
//
//   npm run selftest
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createFakeStripe } from './support/fake-stripe.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-selftest-'));
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const PORT = await freePort();
const SECRET = 'whsec_selftest_only';

const REAL = ['payments.db', 'logs', 'results', 'run', '.env'].map((f) => path.join(ROOT, f));
const fingerprint = () => REAL.map((f) => (fs.existsSync(f) ? `${f}:${fs.statSync(f).mtimeMs}` : `${f}:absent`)).join('|');
const before = fingerprint();

const fake = createFakeStripe({ webhookUrl: `http://127.0.0.1:${PORT}/webhooks/stripe`, webhookSecret: SECRET, retryDelaysMs: [5000, 30000, 60000] }); // outlasts the longest possible outage below (~45 s)
const env = {
  ...process.env, DATA_DIR: DATA, PORT: String(PORT), STRIPE_API_BASE: await fake.start(),
  STRIPE_SECRET_KEY: 'sk_test_selftest_fake', STRIPE_WEBHOOK_SECRET: SECRET,
  CODESPACE_NAME: '', GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: '',
};

let failures = 0;
async function exp(args, { expectFail = false } = {}) {
  const started = Date.now();
  try {
    const { stdout, stderr } = await run(path.join(ROOT, 'exp'), args, { cwd: ROOT, env, timeout: 240_000 });
    if (expectFail) throw new Error(`expected ./exp ${args.join(' ')} to fail`);
    console.log(`✓ ./exp ${args.join(' ')} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
    return stdout + stderr;
  } catch (err) {
    if (expectFail && err.code) { console.log(`✓ ./exp ${args.join(' ')} refused as expected: ${(err.stderr || '').trim().split('\n').at(-1)}`); return err.stdout + err.stderr; }
    throw new Error(`./exp ${args.join(' ')} failed:\n${err.stdout ?? ''}${err.stderr ?? err.message}`);
  }
}
const check = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { failures++; console.log(`  ✗ ${msg}`); } };

try {
  await exp(['help']);
  await exp(['payments', '3'], { expectFail: true });                     // poller not running
  await exp(['receiver']);
  const doctor = await exp(['doctor']);
  check(/✓ STRIPE_SECRET_KEY is a test-mode secret key/.test(doctor), 'doctor: key recognised as test mode');
  check(/✓ Stripe API reachable/.test(doctor) && /✓ PaymentIntents can be listed/.test(doctor), 'doctor: Stripe API calls work');
  check(/✓ receiver running and healthy/.test(doctor), 'doctor: receiver healthy');
  const smoke = await exp(['smoke']);
  check(/received by webhook/.test(smoke), 'smoke: payment received by webhook');
  const tunnel = await exp(['tunnel', `http://127.0.0.1:${PORT}`]);
  check(/tunnel adds about/.test(tunnel), 'tunnel: latency measured');

  await exp(['quiet']);
  await exp(['payments', '3'], { expectFail: true });                     // quiet hour too short
  await exp(['payments', '3', '--force']);
  for (let i = 0; i < 90 && fs.existsSync(path.join(DATA, 'run', 'create.pid')); i++) {
    if (!(await exp(['status'])).includes('create: running')) break;
    await sleep(2000);
  }
  console.log('  waiting 65 s for the next 60-second poll…');
  await sleep(65_000);

  await exp(['outage-start', '2'], { expectFail: true });                 // poller hasn't run 60 min after the first payment
  await exp(['outage-start', '2', '--force']);
  for (let i = 0; i < 60; i++) { if (!(await exp(['status'])).includes('create: running')) break; await sleep(2000); }
  await exp(['outage-end'], { expectFail: true });                        // down < 10 min
  await sleep(4000);                                                     // let the first retry fail too
  await exp(['outage-end', '--force']);
  for (let i = 0; i < 60; i++) { if ((await exp(['outage-status'])).includes('undelivered: 0')) break; await sleep(2000); }
  await exp(['outage-finish']);
  const lost = await exp(['lost-event']);
  check(/recovered evt_/.test(lost) && /0 recovered/.test(lost), 'lost-event: recovered once, second reconcile recovers 0');
  await exp(['analyze']);
  await exp(['stop-all']);

  const summary = fs.readFileSync(path.join(DATA, 'results', 'summary.md'), 'utf8');
  const article = fs.readFileSync(path.join(DATA, 'results', 'article-values.md'), 'utf8');
  const timeline = fs.readFileSync(path.join(DATA, 'logs', 'timeline.log'), 'utf8');
  check(/Payments measured \| 3 of 3 \| 3 of 3/.test(summary), 'summary: 3 side-by-side payments seen by both methods');
  check(/Poll interval actually used: median 60\.\d s/.test(summary), 'summary: measured poll interval is 60 s');
  check(/Every outage payment was eventually delivered by a webhook retry: \*\*yes\*\*/.test(summary), 'summary: outage payments delivered by retry');
  check(/Lost-event demonstration[\s\S]*\| evt_fake/.test(summary), 'summary: lost-event table filled');
  check(/smoke 1/.test(summary), 'summary: smoke payment kept out of the statistics but listed');
  check(/\[PENDING: save as evidence\/screenshots\/endpoint-settings\.png\]/.test(article), 'article values: missing screenshot stays PENDING');
  check(/Tunnel delay[^\n]*adds about/.test(article), 'article values: tunnel latency picked up');
  check(/Median delay \| \d+\.\d s \| \d+\.\d\d s/.test(article), 'article values: medians filled from the data');
  check(timeline.split('\n').filter(Boolean).length >= 10, 'timeline.log records each step');
  check(fingerprint() === before, 'real payments.db, logs/, results/, run/ and .env untouched');
} finally {
  await run(path.join(ROOT, 'exp'), ['stop-all'], { cwd: ROOT, env }).catch(() => {});
  await fake.stop();
}

console.log(failures ? `\n${failures} check(s) FAILED (data kept in ${DATA})` : `\nphone-flow self-test passed (data in ${DATA})`);
process.exit(failures ? 1 : 0);
