// A tiny Express-style router so the repo runs with zero installs.
// To use Express instead: swap createRouter() for express() and add app.use(express.json()).
import http from 'node:http';

export function createRouter() {
  const stack = [];
  const add = (method, path, handlers) => {
    const keys = [];
    const pattern = path.replace(/:(\w+)/g, (_, key) => (keys.push(key), '([^/]+)'));
    stack.push({ method, keys, re: path === '*' ? /^/ : new RegExp(`^${pattern}/?$`), handlers });
  };

  const app = { use: (...handlers) => (add(null, '*', handlers), app) };
  for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
    app[m] = (path, ...handlers) => (add(m.toUpperCase(), path, handlers), app);
  }

  app.handle = async (req, res) => {
    res.status = (code) => ((res.statusCode = code), res);
    res.json = (data) => (res.setHeader('content-type', 'application/json'), res.end(JSON.stringify(data)));
    res.sendStatus = (code) => ((res.statusCode = code), res.end());

    let raw = '';
    for await (const chunk of req) raw += chunk;
    try { req.body = raw ? JSON.parse(raw) : {}; } catch { req.body = null; }
    if (typeof req.body !== 'object' || req.body === null) return res.status(400).json({ error: 'Invalid JSON' });

    const { pathname } = new URL(req.url, 'http://localhost');
    const queue = stack
      .filter((l) => !l.method || l.method === req.method)
      .flatMap((l) => {
        const m = pathname.match(l.re);
        if (!m) return [];
        const params = Object.fromEntries(l.keys.map((k, i) => [k, m[i + 1]]));
        return l.handlers.map((fn) => [fn, params]);
      });

    const next = (err) => {
      if (err) return console.error(err), res.status(500).json({ error: 'Internal error' });
      const [fn, params] = queue.shift() ?? [];
      if (!fn) return res.status(404).json({ error: 'Not found' });
      req.params = params;
      try { fn(req, res, next); } catch (e) { next(e); }
    };
    next();
  };

  app.server = () => http.createServer(app.handle);
  return app;
}
