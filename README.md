# Posts API: object-level authorization

Companion repo for *Authorization rules that stop users editing each other's posts*.

A small posts API with three users and three posts, built on SQLite (`node:sqlite`) and Node's
built-in modules. There are no dependencies, so `npm test` works on a fresh clone (Node 22.13+).

## Stages

Each stage is a git tag. Check one out and run the tests to see that stage's results.

| Tag      | What changed                                    | HTTP rows passing |
| -------- | ----------------------------------------------- | ----------------- |
| `before` | login + `isAdmin` only                          | 7 of 17           |
| `fix-1`  | ownership check inline in `PATCH`               | 10 of 17          |
| `after`  | `can()`, `deny()`, `scopePosts()`, server-set author | 17 of 17     |

```sh
git checkout before   # or fix-1, after
npm test
```

## Users and sessions

| User    | id | role  | Owns                                 | Cookie              |
| ------- | -- | ----- | ------------------------------------ | ------------------- |
| `owner` | 1  | user  | post 1 (published), post 2 (draft)   | `sid=owner-session` |
| `other` | 2  | user  | post 3 (published)                   | `sid=other-session` |
| `admin` | 3  | admin | nothing                              | `sid=admin-session` |

## Try it with curl

```sh
npm start   # http://localhost:3000, fresh in-memory database on every start

curl -X PATCH localhost:3000/posts/1 \
  -H "cookie: sid=other-session" -H "content-type: application/json" \
  -d '{"title":"pwned"}'
```

## Layout

- `src/router.js`: a tiny Express-style router. To use Express, swap `createRouter()` for
  `express()` and add `app.use(express.json())`. In the tests, replace `.server()` with
  `http.createServer(createApp(db))`.
- `src/db.js`: schema, seed data and query helpers.
- `src/auth.js`: sessions, `requireAuth` (401) and `requireAdmin` (403).
- `src/app.js`: the routes.
- `test/http.test.js`: the 17-row access table, one HTTP request per row, with a fresh database for each.
