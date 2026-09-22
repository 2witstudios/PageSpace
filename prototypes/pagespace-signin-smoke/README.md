# Sign in with PageSpace — real-browser smoke (Phase 3)

A foreign-origin Vite SPA that signs a user in through `@pagespace/sdk` 2.6.0 and calls the API as
them. It is configured **only** by the two public values `PAGESPACE_URL` + `PAGESPACE_CLIENT_ID`
(exposed to Vite as `VITE_PAGESPACE_URL` / `VITE_PAGESPACE_CLIENT_ID` and mapped explicitly into
`PageSpaceClient.fromEnvironment({ env })`) — the US7 path — and exercises the
US4 acceptance: sign in from a foreign origin, read the token response cross-origin, then
`client.auth.me()` and `client.pages.list()` for the granted drive.

## Why https on 127.0.0.1:5173

ADR 0004 Decision 3: a third-party client gets **no** cleartext loopback redirect
(`http://127.0.0.1/...` is first-party only — the CLI). So the SPA serves
`https://127.0.0.1:5173` with a self-signed certificate (`@vitejs/plugin-basic-ssl`) and registers
`https://127.0.0.1:5173/auth/pagespace/callback`. Accept the certificate once in the browser.

## Run

1. Local PageSpace web app on `http://localhost:3000` (see the "Running the web app locally" notes).
2. Seed the client (local DB only):
   `psql "$DATABASE_URL" -f prototypes/pagespace-signin-smoke/seed-client.sql`
3. Build the SDK: `bun run --filter @pagespace/sdk build` (the SPA imports `packages/sdk/dist` directly)
4. In this folder: `cp .env.example .env.local && bun install && bun run dev`
5. Open `https://127.0.0.1:5173`, optionally enter a drive id you own, click **Sign in with
   PageSpace**, approve on the consent screen (a drive grant asks for a step-up).

## What passes

The page and `window.__smoke` list each step:

- `fromEnvironment` — redirect URI is `https://127.0.0.1:5173/auth/pagespace/callback`
- `handleRedirectCallback (code exchanged cross-origin)` — the token response was readable (CORS)
- `auth.me` — `{ id, name, email, image }` (profile-only body)
- `pages.list (granted drive)` — only when a drive id was entered
- reload the page → `restore` → `session restored`; **Sign out** → `signOut` → `revoked`
