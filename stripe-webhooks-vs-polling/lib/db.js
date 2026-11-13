// lib/db.js — one SQLite file shared by the receiver, the poller and the reconcile job.
import Database from 'better-sqlite3';
import path from 'node:path';
import { PROJECT_DIR } from './env.js';

export function openDb(file = process.env.DB_PATH || path.join(PROJECT_DIR, 'payments.db')) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL'); // lets several processes read and write the same file
  db.pragma('busy_timeout = 5000'); // wait (up to 5 s) instead of failing when another process is writing

  db.exec(`
    -- Payments we created, and the moment our app considered them paid.
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      created_ms INTEGER NOT NULL,
      phase TEXT NOT NULL DEFAULT 'manual'        -- which demo scenario created it
    );
    -- "The app knows about this payment": one row per payment per method that found it.
    CREATE TABLE IF NOT EXISTS seen (
      id TEXT, method TEXT, seen_ms INTEGER,      -- method: 'poll', 'webhook' or 'reconcile'
      PRIMARY KEY (id, method)
    );
    -- Every event ID we have processed. This table is what makes duplicate deliveries harmless.
    CREATE TABLE IF NOT EXISTS processed_events (
      event_id TEXT PRIMARY KEY, received_ms INTEGER, source TEXT
    );
    -- Every webhook delivery that passed the signature check, duplicates included.
    CREATE TABLE IF NOT EXISTS deliveries (
      event_id TEXT, event_type TEXT, payment_id TEXT, received_ms INTEGER, duplicate INTEGER
    );
    -- One row per HTTP request our code made to Stripe, so polling's cost can be counted.
    CREATE TABLE IF NOT EXISTS api_calls (source TEXT, at_ms INTEGER);
    -- Small key/value store; the poller keeps its cursor here.
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

  // Record that `method` found payment `id`. A second call for the same pair does nothing.
  const markSeen = (id, method, at = Date.now()) => seenStmt.run(id, method, at);

  // Run `work` exactly once per event ID, in one transaction with recording the ID.
  // If `work` throws, the ID is NOT recorded, so a later retry of the same event can still succeed.
  // Returns true if the event was new (work ran), false if it was a duplicate.
  const processEventOnce = db.transaction((eventId, source, work) => {
    const isNew = rememberStmt.run(eventId, Date.now(), source).changes === 1;
    if (isNew) work();
    return isNew;
  });

  const logApiCall = (source) => apiCallStmt.run(source, Date.now());
  return { markSeen, processEventOnce, logApiCall };
}
