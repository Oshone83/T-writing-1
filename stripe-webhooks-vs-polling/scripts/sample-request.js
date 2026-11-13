// scripts/sample-request.js — prints the first GENUINE Stripe webhook request from the receiver's log,
// with the signature and object IDs shortened, ready to paste into the article.
// Genuine = User-Agent starts with "Stripe/". Demo (fake Stripe) and curl/tunnel-test requests are skipped.
//
//   node scripts/sample-request.js [logs/webhook-requests.jsonl] [--lines 20]
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { isMain, DATA_DIR } from '../lib/env.js';

// Keeps the prefix and first 4 characters of Stripe IDs: pi_3Q9abcdef… -> pi_3Q9a…
export const shortenIds = (s) => s.replace(/\b((?:evt|pi|ch|pm|req|py|txn|cus|acct|ba)_[A-Za-z0-9]{4})[A-Za-z0-9]{4,}/g, '$1…');
export const redactSignature = (h) => (h ?? '').replace(/(v\d=)([0-9a-f]{8})[0-9a-f]+/g, '$1$2…');

export function findGenuine(lines) {
  for (const line of lines) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (/^Stripe\//.test(r.headers?.['user-agent'] ?? '') && r.headers?.['stripe-signature']) return r;
  }
  return null;
}

export function formatSample(r, bodyLines = 20) {
  const h = r.headers;
  return [
    `${r.method} ${r.url}    (received ${r.at})`,
    `Content-Type: ${h['content-type']}`,
    `Stripe-Signature: ${redactSignature(h['stripe-signature'])}`,
    `User-Agent: ${h['user-agent']}`,
    '',
    ...shortenIds(r.body ?? '').split('\n').slice(0, bodyLines),
    '…',
  ].join('\n');
}

if (isMain(import.meta.url)) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { lines: { type: 'string', default: '20' } } });
  const file = positionals[0] ?? path.join(DATA_DIR, 'logs', 'webhook-requests.jsonl');
  if (!fs.existsSync(file)) throw new Error(`${file} not found. Is the receiver running and has Stripe sent anything?`);
  const r = findGenuine(fs.readFileSync(file, 'utf8').split('\n'));
  if (!r) throw new Error(`no request with a Stripe/ User-Agent in ${file} yet`);
  console.log(formatSample(r, Number(values.lines)));
}
