# Sign in with PageSpace — the zero-config template

The smallest app that signs a PageSpace user in from inside a PageSpace **environment**, in preview and — unchanged — after publish. It is configured by exactly two **public** values the environment already provides:

| Variable | What it is |
|---|---|
| `PAGESPACE_URL` | where PageSpace is |
| `PAGESPACE_CLIENT_ID` | the environment's own OAuth client (`env_<environment id>`) |

There is no key, no secret and no registration. PageSpace creates the client with the environment and maintains its redirect URIs (the preview origin, then the published origin and any verified custom domain). The callback path is fixed: `/auth/pagespace/callback`. **Never** paste an `mcp_` key or any token into this app or a `.env` file — the flow does not use one.

## Files

- `index.html` — loads `/pagespace-config.js` (the two values) then the app.
- `src/main.ts` — `PageSpaceClient.fromEnvironment({ env })`, the callback route, `restore()`, `auth.me`, sign out.
- `pagespace-config.mjs` — turns the two values from `process.env` into `window.__PAGESPACE_ENV__`, at **request** time.
- `vite.config.ts` — dev server on port 8080 (the preview's port) serving `/pagespace-config.js`.
- `server.mjs` — production: `dist/` + `/pagespace-config.js` + SPA fallback (so the callback path renders the app). Listens on `PORT`.

## Run

Inside an environment: `bun install && bun run dev`, then open the environment's preview and click **Sign in with PageSpace**. Publish the environment: PageSpace runs `bun run build` and `bun run start`, the machine boots with the same two variables, and the published app signs in with no change.

Why runtime, not build time: the published machine sets `PAGESPACE_URL` / `PAGESPACE_CLIENT_ID` when it boots, after the build ran, so `define` / `import.meta.env` would freeze the wrong values. Keep Vite's default `envPrefix` (`VITE_`): widening it to `PAGESPACE_` would inline every `PAGESPACE_*` variable into public JS.

## Scopes

`profile` (the default here) is identity only and is approved with a plain click. Add `offline_access` when the app must keep working after the 15-minute access token expires without the user present. Add `drive:<driveId>:member` (or `:admin`) only when the app reads or writes content in that drive — the user approves it on the consent screen with a passkey or an email confirmation.

## Two dev-mode traps that are not bugs in your app (from the Phase 3 smoke)

1. **A dev-served PageSpace consent screen does not hydrate.** PageSpace's CSP carries no `unsafe-eval` in any mode and Next's dev HMR needs it, so against `bun run dev` the Allow button does nothing. A production build of PageSpace is unaffected; a test harness drives it with Playwright `bypassCSP: true`.
2. **On an onprem PageSpace the step-up email is never sent** (`onprem` disables email), so a user with no passkey cannot approve a `drive:*` grant there. `profile`-only sign-in is unaffected.

## Against a local PageSpace checkout (before the SDK release ships `fromEnvironment`)

`bun run --filter @pagespace/sdk build` in the repo, then point the dependency at it: `bun add @pagespace/sdk@file:../../packages/sdk`. Set `PAGESPACE_URL=http://localhost:3000` and `PAGESPACE_CLIENT_ID=env_<an env id>` in the shell that runs `bun run dev`; the local PageSpace must serve the preview or have `https://127.0.0.1:8080/auth/pagespace/callback` on the client row (a third-party client gets no cleartext loopback redirect).
