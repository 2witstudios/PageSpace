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
   PageSpace**, approve on the consent screen. A drive grant asks for a step-up; add `?offline=1`
   to the SPA URL to request `offline_access` (a refresh token) as well.

Two things a dev-mode server needs that production does not:

- **Hydration.** The app's CSP has no `unsafe-eval` in any mode, and Next's dev HMR needs it, so a
  dev-served consent screen never hydrates and its Allow button does nothing. Drive it with
  Playwright's `bypassCSP: true` (or use a production build). The bypass is a harness workaround,
  not a product change.
- **The step-up email.** `onprem` disables email sending outright
  (`packages/lib/src/services/email-service.ts`), so the magic-link step-up a `drive:*` grant
  requires is never delivered. Mint the link straight into `verification_tokens` (the same row
  `requestMagicLinkStepUp` writes) and open the verify URL.

## What passes

The page and `window.__smoke` list each step:

- `fromEnvironment` — redirect URI is `https://127.0.0.1:5173/auth/pagespace/callback`
- `handleRedirectCallback (code exchanged cross-origin)` — the token response was readable (CORS)
- `auth.me` — `{ id, name, email, image }` (profile-only body)
- `pages.list (granted drive)` — only when a drive id was entered
- reload the page → `restore` → `session restored`; **Sign out** → `signOut` → `revoked`
