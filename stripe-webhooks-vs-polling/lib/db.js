// lib/db.js — one shared SQLite file for every process in the experiment.
import Database from 'better-sqlite3';
import { DATA_DIR } from './env.js';
import path from 'node:path';

export const DEFAULT_DB_PATH = path.join(DATA_DIR, 'payments.db');

export function openDb(file = process.env.DB_PATH || DEFAULT_DB_PATH) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL'); // several processes write to it
  // Fix vs. the article: WAL alone isn't enough. Without a busy timeout, a write that collides
  // with another process's write fails at once with SQLITE_BUSY instead of waiting its turn.
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      created_ms INTEGER NOT NULL,       -- Date.now() when the create call returned
      stripe_created_s INTEGER,          -- Stripe's own 'created' (whole seconds)
      phase TEXT NOT NULL DEFAULT 'side-by-side'
    );
    CREATE TABLE IF NOT EXISTS seen (
      id TEXT, method TEXT, seen_ms INTEGER,
      PRIMARY KEY (id, method)
    );
    CREATE TABLE IF NOT EXISTS processed_events (
      event_id TEXT PRIMARY KEY, received_ms INTEGER, source TEXT
    );
    -- Every webhook POST that passed the signature check, duplicates included.
    -- This is the raw evidence for the retry table, duplicate count and ordering.
    CREATE TABLE IF NOT EXISTS deliveries (
      event_id TEXT, event_type TEXT, payment_id TEXT,
      event_created_s INTEGER, signature_t INTEGER,
      received_ms INTEGER, duplicate INTEGER
    );
    -- When receiver.js was up. Gaps between rows are the outage windows.
    CREATE TABLE IF NOT EXISTS receiver_runs (started_ms INTEGER, stopped_ms INTEGER);
    -- Events deliberately "forgotten" by simulate-lost-event.js (lost-event phase only).
    CREATE TABLE IF NOT EXISTS simulated_losses (event_id TEXT, payment_id TEXT, forgotten_ms INTEGER);
    -- snapshot-pending.js: Stripe's own view of undelivered events (events.list delivery_success=false).
    CREATE TABLE IF NOT EXISTS pending_snapshots (snapshot_ms INTEGER, event_id TEXT, payment_id TEXT, pending_webhooks INTEGER);
    CREATE TABLE IF NOT EXISTS api_calls (source TEXT, at_ms INTEGER);
    CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT);
  `);
  return db;
}

export function makeHelpers(db) {
  const seenStmt = db.prepare('INSERT OR IGNORE INTO seen (id, method, seen_ms) VALUES (?, ?, ?)');
  const rememberStmt = db.prepare(
    'INSERT OR IGNORE INTO processed_events (event_id, received_ms, source) VALUES (?, ?, ?)'
  );
  const apiCallStmt = db.prepare('INSERT INTO api_calls (source, at_ms) VALUES (?, ?)');

  const markSeen = (id, method, at = Date.now()) => seenStmt.run(id, method, at);

  // Fix vs. the article: recording the event ID and doing the work happen in ONE transaction.
  // In the article's version the event ID is committed first; if the work then throws, the event
  // is marked processed but the work never happened, and every retry is skipped as a duplicate.
  const processEventOnce = db.transaction((eventId, source, work) => {
    const isNew = rememberStmt.run(eventId, Date.now(), source).changes === 1;
    if (isNew) work();
    return isNew;
  });

  const logApiCall = (source) => apiCallStmt.run(source, Date.now());
  return { markSeen, processEventOnce, logApiCall };
}
