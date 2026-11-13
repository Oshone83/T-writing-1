// Article values page, template, key/secret checks and the simulated-data guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDb } from '../lib/db.js';
import { analyze } from '../analyze.js';
import { renderArticleValues } from '../lib/article.js';
import { articleTemplate } from '../scripts/article-template.js';
import { describeKey, describeSecret } from '../scripts/doctor.js';
import { assertTestKey, assertWebhookSecret } from '../lib/stripe-client.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('committed ARTICLE-RESULTS.md matches the generator (all PENDING, no numbers invented)', () => {
  const committed = fs.readFileSync(path.join(ROOT, 'ARTICLE-RESULTS.md'), 'utf8');
  assert.equal(committed, articleTemplate());
  assert.doesNotMatch(committed.replace(/\[PENDING:[^\]]*\]/g, ''), /\d+\.\d+ s\b/);
});

test('article values fill from data and leave missing evidence PENDING', () => {
  const db = openDb(':memory:');
  const T = Date.parse('2026-11-20T10:00:00Z');
  for (let t = T - 70 * 60_000; t <= T + 61 * 60_000; t += 60_000) db.prepare("INSERT INTO api_calls VALUES ('poll', ?)").run(t);
  db.prepare("INSERT INTO payments VALUES ('pi_1', ?, 0, 'side-by-side')").run(T);
  db.prepare("INSERT INTO seen VALUES ('pi_1', 'poll', ?), ('pi_1', 'webhook', ?)").run(T + 30_000, T + 1_000);
  const md = renderArticleValues(analyze(db), { versions: { node: 'v22' }, screenshots: { 'endpoint-settings': 'endpoint-settings.png' } });
  assert.match(md, /\| Median delay \| 30\.0 s \| 1\.00 s \|/);
  assert.match(md, /API calls per hour, quiet hour \| 60 \(/);
  assert.match(md, /Polling \/ webhook median ratio[^\n]*30×/);
  assert.match(md, /Endpoint settings screenshot: evidence\/screenshots\/endpoint-settings\.png/);
  assert.match(md, /\[PENDING: save as evidence\/screenshots\/outage-deliveries-failed\.png\]/);
  assert.match(md, /Outage payments: \[PENDING: outage phase\]/);
});

test('placeholder keys and secrets from .env.example are refused', () => {
  assert.throws(() => assertTestKey('sk_test_replace_me'), /placeholder/);
  assert.throws(() => assertWebhookSecret('whsec_replace_me'), /placeholder/);
  assert.doesNotThrow(() => assertWebhookSecret('whsec_abc123'));
});

test('doctor describes keys without printing them', () => {
  assert.equal(describeKey('sk_live_secretvalue').ok, false);
  assert.match(describeKey('rk_test_secretvalue').text, /test-mode restricted key/);
  assert.doesNotMatch(describeKey('rk_test_secretvalue').text, /secretvalue/);
  assert.equal(describeKey(undefined).ok, false);
  assert.equal(describeSecret('whsec_replace_me').ok, false);
  assert.equal(describeSecret('whsec_x').ok, true);
});

test('analyze.js refuses to write simulated payments into results/', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
  const dbPath = path.join(dir, 'fake.db');
  const db = openDb(dbPath);
  db.prepare("INSERT INTO payments VALUES ('pi_fake000001', 1, 0, 'side-by-side')").run();
  db.close();
  const r = spawnSync(process.execPath, ['analyze.js'], { cwd: ROOT, env: { ...process.env, DB_PATH: dbPath, DATA_DIR: '', NODE_TEST_CONTEXT: '' }, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /simulated \(fake Stripe\) payments; refusing/);
  const ok = spawnSync(process.execPath, ['analyze.js', '--out', path.join(dir, 'out')], { cwd: ROOT, env: { ...process.env, DB_PATH: dbPath, DATA_DIR: '', NODE_TEST_CONTEXT: '' }, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
});
