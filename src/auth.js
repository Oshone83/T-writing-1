// Authentication: who is making this request? (Not: are they allowed to do it.)
import { findUser } from './db.js';

// Demo sessions. A real app would store these server-side after login.
export const SESSIONS = { 'owner-session': 1, 'other-session': 2, 'admin-session': 3 };

const sessionId = (req) =>
  (req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).find(([k]) => k === 'sid')?.[1];

export const loadUser = (db) => (req, res, next) => {
  const userId = SESSIONS[sessionId(req)];
  req.user = userId ? findUser(db, userId) : null;
  next();
};

export const requireAuth = (req, res, next) =>
  req.user ? next() : res.status(401).json({ error: 'Log in first' });

export const requireAdmin = (req, res, next) =>
  req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admins only' });
