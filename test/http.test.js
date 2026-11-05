// The 17-row access table from the article. Each row is one HTTP request against a fresh database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db.js';

const SESSIONS = { anon: null, owner: 'owner-session', other: 'other-session', admin: 'admin-session' };
const ids = (posts) => posts.map((p) => p.id);

const cases = [
  { n: 1,  as: 'anon',  method: 'GET',    path: '/posts/1', expect: 200 },
  { n: 2,  as: 'anon',  method: 'PATCH',  path: '/posts/1', body: { title: 'pwned' }, expect: 401 },
  { n: 3,  as: 'other', method: 'GET',    path: '/admin/users', expect: 403 },
  { n: 4,  as: 'owner', method: 'PATCH',  path: '/posts/1', body: { title: 'Edited by owner' }, expect: 200,
    check: (post) => assert.equal(post.title, 'Edited by owner') },
  { n: 5,  as: 'owner', method: 'GET',    path: '/posts/2', expect: 200 },
  { n: 6,  as: 'admin', method: 'DELETE', path: '/posts/1', expect: 204 },
  { n: 7,  as: 'other', method: 'PATCH',  path: '/posts/1', body: { title: 'pwned' }, expect: 403 },
  { n: 8,  as: 'other', method: 'DELETE', path: '/posts/1', expect: 403 },
  { n: 9,  as: 'other', method: 'GET',    path: '/posts/2', expect: 404 },
  { n: 10, as: 'anon',  method: 'GET',    path: '/posts/2', expect: 404 },
  { n: 11, as: 'other', method: 'PATCH',  path: '/posts/3', body: { title: 'mine', authorId: 1 }, expect: 200,
    check: (post) => assert.equal(post.authorId, 2, 'authorId must not change') },
  { n: 12, as: 'admin', method: 'PATCH',  path: '/posts/1', body: { title: 'moderated' }, expect: 403 },
  { n: 13, as: 'other', method: 'GET',    path: '/posts', expect: 200,
    check: (posts) => assert.deepEqual(ids(posts), [1, 3], "the owner's draft must not be listed") },
  { n: 14, as: 'anon',  method: 'GET',    path: '/posts', expect: 200,
    check: (posts) => assert.deepEqual(ids(posts), [1, 3], 'only published posts are listed') },
  { n: 15, as: 'anon',  method: 'POST',   path: '/posts', body: { title: 'hi' }, expect: 401 },
  { n: 16, as: 'owner', method: 'POST',   path: '/posts', body: { title: 'New post', authorId: 2 }, expect: 201,
    check: (post) => assert.equal(post.authorId, 1, 'the server sets the author') },
  { n: 17, as: 'admin', method: 'DELETE', path: '/posts/2', expect: 404 },
];

async function startServer() {
  const server = createApp(createDb()).server();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

for (const c of cases) {
  const name = `#${String(c.n).padStart(2, '0')} ${c.as.padEnd(5)} ${c.method.padEnd(6)} ${c.path} → ${c.expect}`;
  test(name, async () => {
    const server = await startServer();
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}${c.path}`, {
        method: c.method,
        headers: {
          'content-type': 'application/json',
          ...(SESSIONS[c.as] && { cookie: `sid=${SESSIONS[c.as]}` }),
        },
        body: c.body && JSON.stringify(c.body),
      });
      assert.equal(res.status, c.expect);
      if (c.check) c.check(await res.json());
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
}
