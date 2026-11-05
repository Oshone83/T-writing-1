import { createRouter } from './router.js';
import { toPost, listUsers, findPost, createPost, updatePost, deletePost } from './db.js';
import { loadUser, requireAuth, requireAdmin } from './auth.js';
import { can, scopePosts, EDITABLE_FIELDS } from './policies/post.js';
import { pick } from './pick.js';

// If you can't even read it, it doesn't exist (404). If you can read it but not do this, 403.
const deny = (res, user, post) =>
  can(user, 'read', post)
    ? res.status(403).json({ error: 'Forbidden' })
    : res.status(404).json({ error: 'Not found' });

export function createApp(db) {
  const app = createRouter();
  app.use(loadUser(db));

  app.get('/admin/users', requireAuth, requireAdmin, (req, res) => {
    res.json(listUsers(db));
  });

  app.get('/posts', (req, res) => {
    const { where, params } = scopePosts(req.user);
    res.json(db.prepare(`SELECT * FROM posts WHERE ${where} ORDER BY id`).all(...params).map(toPost));
  });

  app.get('/posts/:id', (req, res) => {
    const post = findPost(db, req.params.id);
    if (!post || !can(req.user, 'read', post)) return res.status(404).json({ error: 'Not found' });
    res.json(post);
  });

  app.post('/posts', requireAuth, (req, res) => {
    const fields = pick(req.body, EDITABLE_FIELDS);
    res.status(201).json(createPost(db, { ...fields, authorId: req.user.id })); // session wins, always
  });

  app.patch('/posts/:id', requireAuth, (req, res) => {
    const post = findPost(db, req.params.id);
    if (!post) return res.status(404).json({ error: 'Not found' });
    if (!can(req.user, 'update', post)) return deny(res, req.user, post);
    res.json(updatePost(db, post.id, pick(req.body, EDITABLE_FIELDS)));
  });

  app.delete('/posts/:id', requireAuth, (req, res) => {
    const post = findPost(db, req.params.id);
    if (!post) return res.status(404).json({ error: 'Not found' });
    if (!can(req.user, 'delete', post)) return deny(res, req.user, post);
    deletePost(db, post.id);
    res.sendStatus(204);
  });

  return app;
}
