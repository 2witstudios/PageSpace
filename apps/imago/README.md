# Imago (`apps/imago`)

Imago is PageSpace's new interface: a separate Next.js 15 app served at `/imago`, same-origin with
classic PageSpace (`apps/web`). It adds no auth and no API of its own. It signs in with classic's
session cookie, reads the same Postgres through `@pagespace/db` and `@pagespace/lib`, and calls
`apps/web`'s `/api/*` routes from the browser. The architecture is in
[ADR 0007](../../docs/adr/0007-imago-app.md).

It ships dark: unless `IMAGO_ENABLED=true`, every `/imago` route answers 404 except
`/imago/api/health`.

## Running it locally

Imago needs the rest of the stack, because it uses classic's database, sessions and API:

| Service             | Dev origin               | Started by                          |
| ------------------- | ------------------------ | ----------------------------------- |
| Postgres            | `localhost:5432`         | `bun run dev:db` (Docker Compose)   |
| `apps/web`          | `http://localhost:3000`  | `bun run dev`                       |
| `apps/realtime`     | `http://localhost:3001`  | `bun run dev`                       |
| `apps/imago`        | `http://localhost:3006`  | `bun run dev`, or `bun run --filter @pagespace/imago dev` |

1. **Database.** Imago has no database of its own. It shares `apps/web`'s Postgres, so set the same
   `DATABASE_URL` in both apps' env. From the host, the Compose database is
   `postgresql://user:password@localhost:5432/pagespace` (the root `.env.example` names the
   in-network host `postgres`). Start, migrate and seed it with `bun run dev:db`, or run
   `bun run db:migrate` against a Postgres you already have.
2. **Env.** Copy `apps/imago/.env.example` to `apps/imago/.env.local` and set:
   - `IMAGO_ENABLED=true`. Only the exact value `true` turns Imago on, in every deployment mode.
     Imago's middleware and layout read it on each request.
     `apps/web` reads `NEXT_PUBLIC_IMAGO_ENABLED=true` at build time to show "Try Imago" in its
     user menu; set both together.
   - `WEB_APP_INTERNAL_URL`: where this server reaches `apps/web` (default
     `http://localhost:3000`). `next dev` has no edge in front of it, so it rewrites `/api/*`
     (outside the `/imago` basePath) to this origin itself. The browser then sees one origin and the
     session cookie and CSRF token work as they do in production. Production builds carry no
     rewrite, because the edge routes `/api` to `apps/web`, unless built with
     `IMAGO_API_PROXY_ORIGIN` (Docker Compose, below).
   - `NEXT_PUBLIC_WEB_APP_URL`, `WEB_APP_URL` and `NEXT_PUBLIC_REALTIME_URL`, as the example file
     explains (sign-in redirects, absolute links, the Socket.IO server).
3. **Allow Imago's origin.** In dev, Imago (`:3006`) is a different origin from `apps/web`
   (`:3000`), so `apps/web` (CSRF and origin checks) and `apps/realtime` (Socket.IO CORS) both have
   to accept it. Each reads it from a different file: `apps/web` from its own env
   (`apps/web/.env.local`, as Next.js loads it), and `apps/realtime` from the repo-root `.env`,
   the file its server loads (`dotenv.config({ path: '../../.env' })`), not `apps/realtime/.env`.
   Add it to both:

   ```bash
   # apps/web/.env.local  and  the repo-root .env (for apps/realtime)
   ADDITIONAL_ALLOWED_ORIGINS=http://localhost:3006
   ```

   Without it, `apps/web` rejects Imago's requests on origin checks and realtime refuses its
   socket.
4. **Start.** Run `bun run dev` from the repo root (every app except the control plane), then sign
   in to classic at `http://localhost:3000` and open `http://localhost:3006/imago`. A signed-out
   visit goes to classic's sign-in and comes back to the `/imago` address it came from.

## Docker Compose

`docker compose up` runs imago's standalone server on `http://localhost:3006/imago` with no edge in
front of it, so nothing else routes the browser's `/api/*` calls to `apps/web`. The `imago` service
therefore builds with `IMAGO_API_PROXY_ORIGIN=http://web:3000`, which `next build` bakes into the
routes manifest as an `/api/*` proxy (a build arg, because the server never re-reads it). Leave it
unset everywhere an edge routes `/api` (Caddy, Fly, Traefik): the published image is built without
it, and a second `/api` route there would double-route. The service also gets `apps/web`'s
`DATABASE_URL`, and the `DATABASE_SSL`, `DEPLOYMENT_MODE`, `SESSION_IDLE_TIMEOUT_MS` and `LOG_LEVEL`
values `apps/web` reads from `.env`, but not `.env` itself: imago reads no secrets.

In the repo-root `.env`, set `IMAGO_ENABLED=true` (and `NEXT_PUBLIC_IMAGO_ENABLED=true` for the
"Try Imago" link), and add imago's origin to `ADDITIONAL_ALLOWED_ORIGINS=http://localhost:3006` so
`apps/web` accepts its proxied mutating requests and `apps/realtime` its socket. Realtime stays on
its own origin (`NEXT_PUBLIC_REALTIME_URL`, `:3001`); imago's CSP allows that origin in
`connect-src`, because socket.io opens with HTTP polling, which `ws:`/`wss:` do not cover.

Sign-in happens on classic (`http://localhost:3000`, `WEB_APP_URL`), whose cookie reaches `:3006`
because localhost cookies ignore the port. With no edge, classic cannot send you back to imago: after
signing in, open `http://localhost:3006/imago` again.

## Tests

```bash
bun run --filter @pagespace/imago test              # unit and component suites (vitest), no database
bun run --filter @pagespace/imago test:integration  # *.integration.test.ts, needs a migrated Postgres
bun run --filter @pagespace/imago typecheck
bun run --filter @pagespace/imago lint              # includes the token lock (better-tailwindcss)
```

The integration suites read `DATABASE_URL` and expect a migrated, disposable database. Use the
repo's shared test Postgres (`docker-compose.test.yml`, `localhost:5433`, which
`scripts/test-with-db.sh` starts and migrates), or create a database just for the run, migrate it
with `DATABASE_URL=… bun run db:migrate`, and drop it afterwards. Never point the integration
suites at a database you want to keep.

## Layout

- `src/app/(shell)` holds every stage route under one layout that mounts the shell once. Routes are
  addresses: they render only the object slot's content, and the shell derives the stage from the
  URL. `(shell)/error.tsx` keeps the rail and panes when a route throws.
- `src/ui/frame` is the shell: rail, panes, drive switcher, and the edge states (`edge-state`,
  `not-found`) that an empty section, a failed request (with "Try again") and an unknown id render.
- `src/ui/{files,messages,tasks}` are the sections, on `apps/web`'s routes through `src/api`'s
  client and SWR.
- Class strings live in `*-class.ts` modules with exact-string tests, against the token-locked
  Tailwind 4 theme in `src/app/globals.css`.
