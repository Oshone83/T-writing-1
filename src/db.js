// SQLite via Node's built-in node:sqlite. Every call to createDb() returns a fresh, seeded, in-memory database.
import { DatabaseSync } from 'node:sqlite';

export function createDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL);   -- role: 'user' | 'admin'
    CREATE TABLE posts (
      id INTEGER PRIMARY KEY,
      author_id INTEGER NOT NULL REFERENCES users(id),
      title TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft'                                                 -- 'draft' | 'published'
    );
    INSERT INTO users (id, name, role) VALUES (1, 'owner', 'user'), (2, 'other', 'user'), (3, 'admin', 'admin');
    INSERT INTO posts (id, author_id, title, status) VALUES
      (1, 1, 'Hello world', 'published'),
      (2, 1, 'Work in progress', 'draft'),
      (3, 2, 'Fixed my tpyo', 'published');
  `);
  return db;
}

export const toPost = (row) =>
  row && { id: row.id, authorId: row.author_id, title: row.title, body: row.body, status: row.status };

export const findUser = (db, id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
export const listUsers = (db) => db.prepare('SELECT * FROM users ORDER BY id').all();

export function findPost(db, id) {
  if (!/^\d+$/.test(String(id))) return undefined;
  return toPost(db.prepare('SELECT * FROM posts WHERE id = ?').get(Number(id)));
}

export function createPost(db, { authorId, title = '', body = '', status = 'draft' }) {
  return toPost(
    db.prepare('INSERT INTO posts (author_id, title, body, status) VALUES (?, ?, ?, ?) RETURNING *')
      .get(authorId, title, body, status),
  );
}

// Writes every known field it receives and skips undefined values.
// Note it knows about authorId: whatever the caller passes in gets written.
const COLUMNS = { title: 'title', body: 'body', status: 'status', authorId: 'author_id' };

export function updatePost(db, id, fields) {
  const entries = Object.entries(COLUMNS).filter(([key]) => fields[key] !== undefined);
  if (entries.length) {
    const set = entries.map(([, col]) => `${col} = ?`).join(', ');
    db.prepare(`UPDATE posts SET ${set} WHERE id = ?`).run(...entries.map(([key]) => fields[key]), id);
  }
  return findPost(db, id);
}

export const deletePost = (db, id) => db.prepare('DELETE FROM posts WHERE id = ?').run(id);
