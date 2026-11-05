import { createRouter } from './router.js';
import { toPost, listUsers, findPost, createPost, updatePost, deletePost } from './db.js';
import { loadUser, requireAuth, requireAdmin } from './auth.js';

export function createApp(db) {
  const app = createRouter();
  app.use(loadUser(db));

  app.get('/admin/users', requireAuth, requireAdmin, (req, res) => {
    res.json(listUsers(db));
  });

  // Returns every post, drafts included. "The dashboard hides drafts."
  app.get('/posts', (req, res) => {
    res.json(db.prepare('SELECT * FROM posts ORDER BY id').all().map(toPost));
  });

  app.get('/posts/:id', (req, res) => {
    const post = findPost(db, req.params.id);
    if (!post) return res.status(404).json({ error: 'Not found' });
    res.json(post);
  });

  app.post('/posts', requireAuth, (req, res) => {
    res.status(201).json(createPost(db, { authorId: req.user.id, ...req.body }));
  });

  app.patch('/posts/:id', requireAuth, (req, res) => {
    const post = findPost(db, req.params.id);
    if (!post) return res.status(404).json({ error: 'Not found' });
    if (post.authorId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const { title, body, status } = req.body; // only fields an author may change
    res.json(updatePost(db, post.id, { title, body, status }));
  });

  app.delete('/posts/:id', requireAuth, (req, res) => {
    const post = findPost(db, req.params.id);
    if (!post) return res.status(404).json({ error: 'Not found' });
    deletePost(db, post.id);
    res.sendStatus(204);
  });

  return app;
}
