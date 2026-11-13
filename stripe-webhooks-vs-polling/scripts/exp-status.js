// scripts/exp-status.js — small database queries used by ./exp.
//
//   node scripts/exp-status.js status                       progress per phase
//   node scripts/exp-status.js first-payment <phase>        ms of the first payment in that phase (or nothing)
//   node scripts/exp-status.js last-stop                    ms the receiver last stopped (or nothing)
//   node scripts/exp-status.js wait-latest <phase> <timeout-s>   exit 0 once the newest payment of the
//                                                           phase was recorded by the webhook, 1 on timeout
//   node scripts/exp-status.js outage                       each outage payment: delivered or waiting
//   node scripts/exp-status.js outage-undelivered           count of outage payments not delivered by webhook
import { setTimeout as sleep } from 'node:timers/promises';
import { isMain } from '../lib/env.js';
import { openDb } from '../lib/db.js';

const iso = (ms) => (ms == null ? '-' : new Date(ms).toISOString());

export function progress(db) {
  const phases = db.prepare(`
    SELECT p.phase, COUNT(*) created,
      SUM(EXISTS(SELECT 1 FROM seen s WHERE s.id = p.id AND s.method = 'poll')) poll,
      SUM(EXISTS(SELECT 1 FROM seen s WHERE s.id = p.id AND s.method = 'webhook')) webhook,
      SUM(EXISTS(SELECT 1 FROM seen s WHERE s.id = p.id AND s.method = 'reconcile')) reconcile,
      MIN(p.created_ms) first_ms, MAX(p.created_ms) last_ms
    FROM payments p GROUP BY p.phase ORDER BY first_ms`).all();
  const lastRun = db.prepare('SELECT started_ms, stopped_ms FROM receiver_runs ORDER BY started_ms DESC LIMIT 1').get();
  const pollCalls = db.prepare("SELECT COUNT(*) n, MIN(at_ms) first, MAX(at_ms) last FROM api_calls WHERE source = 'poll'").get();
  const pending = db.prepare('SELECT snapshot_ms, pending_webhooks FROM pending_snapshots WHERE event_id IS NULL ORDER BY snapshot_ms DESC LIMIT 1').get();
  return { phases, lastRun, pollCalls, pending };
}

export function formatProgress({ phases, lastRun, pollCalls, pending }) {
  const lines = ['phase          created  poll  webhook  reconcile  first payment             last payment'];
  for (const p of phases) {
    lines.push(`${p.phase.padEnd(14)} ${String(p.created).padStart(7)} ${String(p.poll).padStart(5)} ${String(p.webhook).padStart(8)} ${String(p.reconcile).padStart(10)}  ${iso(p.first_ms).padEnd(25)} ${iso(p.last_ms)}`);
  }
  if (!phases.length) lines.push('(no payments yet)');
  lines.push(`poll requests: ${pollCalls.n} (first ${iso(pollCalls.first)}, last ${iso(pollCalls.last)})`);
  lines.push(`receiver: last started ${iso(lastRun?.started_ms)}, stopped ${iso(lastRun?.stopped_ms)}`);
  if (pending) lines.push(`Stripe pending view: ${pending.pending_webhooks} undelivered at ${iso(pending.snapshot_ms)}`);
  return lines.join('\n');
}

if (isMain(import.meta.url)) {
  const [cmd, ...args] = process.argv.slice(2);
  const db = openDb();
  if (cmd === 'status') {
    console.log(formatProgress(progress(db)));
  } else if (cmd === 'first-payment') {
    const r = db.prepare('SELECT MIN(created_ms) t FROM payments WHERE phase = ?').get(args[0]);
    if (r.t != null) console.log(r.t);
  } else if (cmd === 'last-stop') {
    const r = db.prepare('SELECT stopped_ms FROM receiver_runs ORDER BY started_ms DESC LIMIT 1').get();
    if (r?.stopped_ms != null) console.log(r.stopped_ms);
  } else if (cmd === 'wait-latest') {
    const [phase, timeout] = [args[0], Number(args[1])];
    const latest = db.prepare('SELECT id FROM payments WHERE phase = ? ORDER BY created_ms DESC LIMIT 1').get(phase);
    if (!latest) { console.log(`no '${phase}' payment was created`); process.exit(1); }
    const seen = db.prepare("SELECT seen_ms FROM seen WHERE id = ? AND method = 'webhook'");
    const until = Date.now() + timeout * 1000;
    while (!seen.get(latest.id)) {
      if (Date.now() > until) { console.log(`timed out: ${latest.id} not received by webhook after ${timeout} s`); process.exit(1); }
      await sleep(1000);
    }
    console.log(`${latest.id} received by webhook`);
  } else if (cmd === 'outage' || cmd === 'outage-undelivered') {
    const rows = db.prepare(`
      SELECT p.id, p.created_ms, MIN(d.received_ms) delivered_ms FROM payments p
      LEFT JOIN deliveries d ON d.payment_id = p.id AND d.event_type = 'payment_intent.succeeded'
      WHERE p.phase = 'outage' GROUP BY p.id ORDER BY p.created_ms`).all();
    if (cmd === 'outage-undelivered') console.log(rows.filter((r) => r.delivered_ms == null).length);
    else if (!rows.length) console.log('(no outage payments yet)');
    else for (const r of rows) {
      console.log(`${r.id}  created ${iso(r.created_ms)}  ${r.delivered_ms ? `delivered by webhook ${iso(r.delivered_ms)} (${((r.delivered_ms - r.created_ms) / 60000).toFixed(1)} min later)` : 'waiting for a retry'}`);
    }
  } else {
    console.error('usage: exp-status.js status | first-payment <phase> | last-stop | wait-latest <phase> <timeout-s> | outage | outage-undelivered');
    process.exit(2);
  }
}
