// db.js
import Database from 'better-sqlite3';

export const db = new Database('payments.db');
db.pragma('journal_mode = WAL'); // several processes write to it

db.exec(`
  CREATE TABLE IF NOT EXISTS payments (id TEXT PRIMARY KEY, created_ms INTEGER);
  CREATE TABLE IF NOT EXISTS seen (id TEXT, method TEXT, seen_ms INTEGER, PRIMARY KEY (id, method));
  CREATE TABLE IF NOT EXISTS processed_events (event_id TEXT PRIMARY KEY, received_ms INTEGER);
  CREATE TABLE IF NOT EXISTS api_calls (source TEXT, at_ms INTEGER);
  CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT);
`);

export const markSeen = (id, method) =>
  db.prepare('INSERT OR IGNORE INTO seen (id, method, seen_ms) VALUES (?, ?, ?)')
    .run(id, method, Date.now());
