import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRELOAD = join(ROOT, 'test', 'fake-stripe-preload.js');

// A fresh working directory with the schema from db.js already created in payments.db.
export function freshDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'stripe-webhooks-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync(process.execPath, [join(ROOT, 'db.js')], { cwd: dir });
  return { dir, db: () => new Database(join(dir, 'payments.db')) };
}

// Async on purpose: the fake Stripe server lives in this process and must keep answering.
export async function run(script, { cwd, env = {}, args = [], fakeStripe } = {}) {
  const pre = fakeStripe ? ['--import', PRELOAD] : [];
  const { stdout } = await promisify(execFile)(process.execPath, [...pre, join(ROOT, script), ...args], {
    cwd,
    env: { ...process.env, STRIPE_SECRET_KEY: 'sk_test_fake', ...(fakeStripe ? { FAKE_STRIPE_URL: fakeStripe } : {}), ...env },
    timeout: 20_000,
  });
  return stdout;
}

export function startBackground(script, { cwd, env = {} }) {
  const child = execFile(process.execPath, [join(ROOT, script)], { cwd, env: { ...process.env, ...env } });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  return { child, output: () => out };
}

// Minimal fake of Stripe's list endpoints: newest first, created[gte]/[lte], type, limit, starting_after.
export async function fakeStripe(t, { paymentIntents = [], events = [] }) {
  const requests = [];
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    requests.push(u.pathname + u.search);
    const source = { '/v1/payment_intents': paymentIntents, '/v1/events': events }[u.pathname];
    if (req.method !== 'GET' || !source) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'not faked' } }));
    }
    const q = u.searchParams;
    const gte = q.get('created[gte]'), lte = q.get('created[lte]'), type = q.get('type');
    let items = [...source]
      .filter((o) => (gte == null || o.created >= +gte) && (lte == null || o.created <= +lte) && (!type || o.type === type))
      .sort((a, b) => b.created - a.created || (a.id < b.id ? 1 : -1));
    const after = q.get('starting_after');
    if (after) items = items.slice(items.findIndex((o) => o.id === after) + 1);
    const limit = Number(q.get('limit') ?? 10);
    res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_fake' });
    res.end(JSON.stringify({ object: 'list', url: u.pathname, has_more: items.length > limit, data: items.slice(0, limit) }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.closeAllConnections() || server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

export const waitFor = async (check, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out');
};
