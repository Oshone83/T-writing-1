// scripts/demo.js — runs the whole experiment end to end against a LOCAL FAKE Stripe, on a
// compressed timescale (poll every 10 s, payments 1–4 s apart, retries after 5/10/20 s).
// It proves the scripts work together; its numbers say NOTHING about real Stripe.
// Everything it writes stays in demo.db and demo-results/: the real logs/ and payments.db are never touched.
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

// Guard: the demo must never write to the real request log or database.
const REAL = [path.join(ROOT, 'logs', 'webhook-requests.jsonl'), path.join(ROOT, 'payments.db')];
const fingerprint = () => REAL.map((f) => (fs.existsSync(f) ? `${f}:${fs.statSync(f).size}:${fs.statSync(f).mtimeMs}` : `${f}:absent`)).join('|');
const before = fingerprint();

for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) fs.rmSync(f, { force: true });
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'logs'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'README.md'), `# ⚠️ Simulated output: not Stripe data

Produced by \`npm run demo\` against \`test/support/fake-stripe.js\`, a local stand-in for Stripe,
on a compressed timescale (payments 1–4 s apart, poller every 10 s, retries after 5/10/20 s).

It shows that the scripts work together end to end and what each output file looks like.
**None of these numbers belong in the article.** Real results go in \`../results/\` after you run
the experiment against Stripe test mode (see the main README).
`);

const fake = createFakeStripe({ webhookUrl: `http://127.0.0.1:${PORT}/webhooks/stripe`, webhookSecret: SECRET, retryDelaysMs: [5000, 10000, 20000] });
const env = {
  ...process.env, DB_PATH: DB, PORT: String(PORT), HOST: '127.0.0.1',
  REQUEST_LOG_PATH: path.join(OUT, 'logs', 'webhook-requests.jsonl'),
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

step('outage: poller off, receiver stopped (SIGTERM), pending snapshots every 4 s');
poller.kill('SIGTERM'); await poller.done;
receiver.kill('SIGTERM'); await receiver.done;
const snapshot = run('snapshot', ['snapshot-pending.js', '--every', '4']);
assertOk(await run('create-outage', ['create-payments.js', '--count', '3', '--min-gap', '1', '--max-gap', '2', '--phase', 'outage']).done);
await sleep(12_000); // first attempt + first retry fail

step('receiver back up; waiting for automatic retries');
receiver = run('receiver', ['receiver.js']);
await sleep(25_000);
snapshot.kill('SIGTERM'); await snapshot.done;

step('fake Stripe resends one event (duplicate on purpose)');
await fake.redeliver(fake.events[0].id);
await sleep(500);

step('try to forget an OUTAGE event: must be refused');
const refused = await run('lose-refused', ['simulate-lost-event.js', '--event', fake.events.at(-1).id]).done;
if (refused === 0) { console.error('simulate-lost-event.js forgot a measured payment'); process.exit(1); }

step('lost-event demo on its own payment: create, forget, reconcile twice');
assertOk(await run('create-lost', ['create-payments.js', '--count', '1', '--phase', 'lost-event']).done);
await sleep(1000);
assertOk(await run('lose-one', ['simulate-lost-event.js']).done);
assertOk(await run('reconcile', ['reconcile.js', '--since-hours', '1']).done);
assertOk(await run('reconcile-again', ['reconcile.js', '--since-hours', '1']).done);

receiver.kill('SIGTERM'); await receiver.done;
await fake.stop();

fs.writeFileSync(path.join(OUT, 'logs', 'fake-stripe-delivery-attempts.json'),
  JSON.stringify(fake.attempts.map((a) => ({ ...a, at: new Date(a.at_ms).toISOString() })), null, 2));

step('analyze');
assertOk(await run('analyze', ['analyze.js', '--out', OUT, '--label', LABEL]).done);

if (fingerprint() !== before) { console.error('demo touched the real logs/ or payments.db'); process.exit(1); }
console.log('\nreal logs/webhook-requests.jsonl and payments.db untouched by the demo');

function assertOk(code) { if (code !== 0) { console.error(`step failed with exit code ${code}`); process.exit(1); } }
