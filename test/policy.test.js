// Unit tests for the post policy: no server, no database, just the rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { can } from '../src/policies/post.js';

const owner = { id: 1, role: 'user' };
const other = { id: 2, role: 'user' };
const admin = { id: 3, role: 'admin' };
const published = { id: 1, authorId: 1, status: 'published' };
const draft = { id: 2, authorId: 1, status: 'draft' };

const name = (u) => (u === null ? 'anon' : u === owner ? 'owner' : u === other ? 'other' : 'admin');

// [user, action, post, expected]
const rules = [
  [null,  'read',    published, true],
  [null,  'read',    draft,     false],
  [owner, 'read',    draft,     true],
  [other, 'read',    draft,     false],
  [admin, 'read',    draft,     false],
  [owner, 'update',  published, true],
  [other, 'update',  published, false],
  [admin, 'update',  published, false],
  [owner, 'delete',  draft,     true],
  [other, 'delete',  published, false],
  [admin, 'delete',  published, true],
  [admin, 'delete',  draft,     false], // can't delete what you can't see
  [owner, 'publish', published, false], // unknown action → deny
];

for (const [user, action, post, expected] of rules) {
  test(`policy: ${name(user)} ${action} ${post.status} → ${expected ? 'allow' : 'deny'}`, () => {
    assert.equal(can(user, action, post), expected);
  });
}
