// scripts/demo.js — runs the whole experiment end to end against a LOCAL FAKE Stripe, on a
// compressed timescale (poll every 10 s, payments 1–4 s apart, retries after 5/10/20 s).
// It proves the scripts work together; its numbers say NOTHING about real Stripe.
//
//   npm run demo      → demo-results/ (and demo.db)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createFakeStripe } from '../test/support/fake-stripe.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = path.join(ROOT, 'demo.db');
const OUT = path.join(ROOT, 'demo-results');
const PORT = 3999;
const SECRET = 'whsec_demo_only_not_a_real_secret';
const LABEL = 'SIMULATED against a local fake Stripe on a compressed timescale. NOT real Stripe data; do not publish these numbers.';

for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) fs.rmSync(f, { force: true });
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'logs'), { recursive: true });

const fake = createFakeStripe({ webhookUrl: `http://127.0.0.1:${PORT}/webhooks/stripe`, webhookSecret: SECRET, retryDelaysMs: [5000, 10000, 20000] });
const env = {
  ...process.env, DB_PATH: DB, PORT: String(PORT),
  STRIPE_API_BASE: await fake.start(),
  STRIPE_SECRET_KEY: 'sk_test_demo_fake', STRIPE_WEBHOOK_SECRET: SECRET,
};

const run = (name, args) => {
  const log = fs.createWriteStream(path.join(OUT, 'logs', `${name}.log`), { flags: 'a' });
  const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log); child.stderr.pipe(log);
  child.stdout.on('data', (d) => process.stdout.write(`[${name}] ${d}`));
  child.stderr.on('data', (d) => process.stdout.write(`[${name}!] ${d}`));
  child.done = new Promise((r) => child.on('exit', (code) => r(code)));
  return child;
};
const step = (s) => console.log(`\n=== ${new Date().toISOString()} ${s}`);

step('start receiver + poller (every 10 s)');
let receiver = run('receiver', ['receiver.js']);
const poller = run('poll', ['poll.js', '--every', '10']);
await sleep(1500);

step('side-by-side: 20 payments, 1–4 s apart');
assertOk(await run('create', ['create-payments.js', '--count', '20', '--min-gap', '1', '--max-gap', '4', '--phase', 'side-by-side']).done);
await sleep(11_000); // let the poller catch the last ones

step('outage: poller off, receiver stopped (SIGTERM)');
poller.kill('SIGTERM'); await poller.done;
receiver.kill('SIGTERM'); await receiver.done;
assertOk(await run('create-outage', ['create-payments.js', '--count', '3', '--min-gap', '1', '--max-gap', '2', '--phase', 'outage']).done);
await sleep(12_000); // first attempt + first retry fail

step('receiver back up; waiting for automatic retries');
receiver = run('receiver', ['receiver.js']);
await sleep(25_000);

step('fake Stripe resends one event (duplicate on purpose)');
await fake.redeliver(fake.events[0].id);
await sleep(500);

step('simulate a lost event, then reconcile');
assertOk(await run('lose-one', ['simulate-lost-event.js', '--event', fake.events.at(-1).id]).done);
assertOk(await run('reconcile', ['reconcile.js', '--since-hours', '1']).done);
assertOk(await run('reconcile-again', ['reconcile.js', '--since-hours', '1']).done);

receiver.kill('SIGTERM'); await receiver.done;
await fake.stop();

fs.writeFileSync(path.join(OUT, 'logs', 'fake-stripe-delivery-attempts.json'),
  JSON.stringify(fake.attempts.map((a) => ({ ...a, at: new Date(a.at_ms).toISOString() })), null, 2));

step('analyze');
assertOk(await run('analyze', ['analyze.js', '--out', OUT, '--label', LABEL]).done);

function assertOk(code) { if (code !== 0) { console.error(`step failed with exit code ${code}`); process.exit(1); } }
