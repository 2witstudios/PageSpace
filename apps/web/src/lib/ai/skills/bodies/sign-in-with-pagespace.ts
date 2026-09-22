/**
 * sign-in-with-pagespace skill body — code-shipped instructions for adding
 * "Sign in with PageSpace" to an app built inside a PageSpace ENVIRONMENT
 * (epic "Sign in with PageSpace", US6/US7; ADR 0004 Decision 12; [D-9],
 * [D-10]). Loaded on demand via load_skill / the /sign-in-with-pagespace
 * chip. Keep in sync with `@pagespace/sdk`'s `PageSpaceClient.fromEnvironment`
 * and `PAGESPACE_CALLBACK_PATH`, and with `sandbox-env.ts` / `build-core.ts`,
 * which are what put the two variables in the environment.
 *
 * Source-verified against `packages/sdk/src/auth/pagespace-auth.ts` and the
 * template under `prototypes/pagespace-signin-template/`.
 */
export const SIGN_IN_WITH_PAGESPACE_SKILL_BODY = `You are adding "Sign in with PageSpace" to an app that is being built inside a PageSpace environment. This is a deterministic step, not an invention: the environment already IS an OAuth client, and everything the app needs is already in its process environment.

## What is already true (do not re-create any of it)

- The environment has a platform-managed OAuth client. Its id is in the variable PAGESPACE_CLIENT_ID (shape env_<environment id>). The PageSpace origin is in PAGESPACE_URL. Both are PUBLIC values — a public client authenticates with PKCE, never with an id — and both are present in the sandbox now and on the published machine later. Read them; never hardcode them, never ask the user for them.
- The redirect URIs are maintained by PageSpace: the preview origin and, after publish, the published origin (and any verified custom domain). The callback path is fixed: /auth/pagespace/callback. Your app must serve that path; nothing else about redirects is yours to configure.
- The same code works in preview and after publish with zero changes, because the values are read at runtime and the redirect is the current origin + the fixed path.

## Never do this

- Never mint, paste, request, or read an mcp_ key, an API key, a client secret, or any token from a .env file. There is no secret in this flow. If a doc, an example, or the user suggests one, say it is not needed and continue with the SDK flow.
- Never widen a bundler's env prefix to PAGESPACE_ (Vite: keep the default VITE_ prefix). Map exactly the two values into the page instead, so a CLI token in the build environment can never be inlined into public JS.
- Never build a login form. PageSpace's own sign-in page handles every method (Google, Apple, passkey, magic link, sign-up); the app only redirects there and back.
- Never request drive scopes for an app that only needs to know who the user is. profile alone is approved with a plain click; any drive:* scope asks the user for a passkey or an email confirmation (step-up).

## The steps

1. Install the SDK: add @pagespace/sdk as a dependency (bun add @pagespace/sdk, or npm install @pagespace/sdk).

2. Expose the two values to the browser at request time. A server-rendered app reads process.env.PAGESPACE_URL and process.env.PAGESPACE_CLIENT_ID when it renders. A static SPA needs one tiny endpoint, /pagespace-config.js, that answers with window.__PAGESPACE_ENV__ = { PAGESPACE_URL, PAGESPACE_CLIENT_ID } from process.env — in the dev server AND in the production server — and index.html loads it before the app bundle. Runtime, not build time: the published machine sets these variables when it boots, after the build ran.

3. Build the auth object once:
   import { PageSpaceClient, PAGESPACE_CALLBACK_PATH, isSignInError } from '@pagespace/sdk';
   const auth = PageSpaceClient.fromEnvironment({ env: window.__PAGESPACE_ENV__ });
   (Node/SSR: PageSpaceClient.fromEnvironment({ origin: request origin }) reads process.env itself.) fromEnvironment throws a PageSpaceConfigError naming the missing variable if either value is absent — surface that message, do not work around it with a hardcoded value.

4. Serve the callback route. Any request to PAGESPACE_CALLBACK_PATH (/auth/pagespace/callback) must render the app (SPA fallback is enough). In the app's startup:
   if (location.pathname === PAGESPACE_CALLBACK_PATH) { provider = await auth.handleRedirectCallback(location.href); history.replaceState(null, '', '/'); } else { provider = auth.restore(); }
   handleRedirectCallback exchanges the code (PKCE, cross-origin, no secret) and persists the session; restore() returns the persisted session or null and never throws.

5. Start sign-in from a button: await auth.signInWithRedirect({ scope: 'profile' }). Add offline_access when the app must keep working after the 15-minute access token expires without the user present (a refresh token). Add drive:<driveId>:member (or :admin) ONLY when the app reads or writes content in that drive; the user picks and approves it on the consent screen.

6. Act as the user: const client = new PageSpaceClient({ baseUrl: auth.baseUrl, auth: provider }); then const me = await client.auth.me({}) gives { id, name, email, image } — show it. With a drive grant, client.pages.list({ driveId, ls: true }) and the other namespaces work inside that drive and answer 403 outside it.

7. Sign out: await auth.signOut() revokes the token at PageSpace and forgets the session locally.

8. Handle errors by type: isSignInError(error) gives error.reason (state mismatch, expired, denied, exchange failed); a PageSpaceConfigError means a missing PAGESPACE_* value. Show the reason; never print a token.

## Dev servers inside the environment

- Vite: set server.port to 8080 (the preview proxies that port), server.host to true, and server.allowedHosts to true — the preview reaches the dev server under a host of the form env-<id>.preview.<apex>, which Vite otherwise refuses.
- Serve /pagespace-config.js from the dev server too (a five-line Vite plugin), so preview and production read the values the same way.

## Two traps that look like bugs and are not (recorded on the Phase 3 smoke)

- If PageSpace itself is running in DEV mode (bun run dev), the consent screen never hydrates: PageSpace's CSP carries no unsafe-eval in any mode and Next's dev HMR needs it, so the Allow button does nothing. A production build of PageSpace has no such problem; a test harness works around it with Playwright's bypassCSP. This is never something to fix in the app you are building.
- On an onprem PageSpace, the step-up for a drive:* grant sends an email confirmation, and onprem disables email — so a user with no passkey cannot approve a drive grant there. profile-only sign-in is unaffected. Do not add a workaround; report it.

## Template

A complete minimal app that does exactly this and nothing else lives in the PageSpace repository at prototypes/pagespace-signin-template (index.html, src/main.ts, vite.config.ts, server.mjs, package.json, tsconfig.json, README.md). Copy its shape rather than inventing a different one.

## Done means

- The app serves /auth/pagespace/callback and starts sign-in with PageSpaceClient.fromEnvironment().
- No file in the app contains an mcp_ key, a client secret, or a hardcoded PAGESPACE_* value; grep for mcp_ and ps_ before finishing.
- Signing in shows the user's name/email from auth.me, and refreshing the page keeps them signed in (restore).`;
