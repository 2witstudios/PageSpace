# @pagespace/sdk

The typed TypeScript/JavaScript client for the [PageSpace](https://pagespace.ai) API — drives,
pages, tasks, roles, search, calendar, AI agents, and more, with full type inference on every
call.

Three guarantees the design enforces, not just promises:

- **One source of truth.** SDK methods, `pagespace` CLI verbs, and `pagespace mcp` tools are all
  generated from a single operation registry, so the three surfaces can't drift apart.
- **Validated I/O.** Inputs are checked before a request is built; every server response is
  zod-validated against its output schema before you see it.
- **No secret leaks.** No code path in this package logs or embeds token material — not in
  errors, not in output.

## Install

```bash
npm install @pagespace/sdk
# or: bun add @pagespace/sdk
```

## Quickstart

```ts
import { PageSpaceClient, StaticTokenProvider } from '@pagespace/sdk';

const client = new PageSpaceClient({
  baseUrl: 'https://pagespace.ai',
  auth: new StaticTokenProvider(process.env.PAGESPACE_TOKEN!),
});

const drives = await client.drives.list({});
console.log(drives.map((d) => d.name));
```

Get an `mcp_` token from **Settings → MCP** in the app, or from the CLI:
`pagespace keys create --drive <id> --role member --show-token` (prints the token once). An
`mcp_` token works for every namespace except `client.tokens` — see
[the `tokens` namespace](#the-tokens-namespace-needs-an-oauth-credential).

## Auth providers

`PageSpaceClient` takes any `AuthProvider` (`{ getAccessToken(): Promise<string>; invalidate(): void }`).
Two ship with the SDK:

- **`StaticTokenProvider(token: string)`** — wraps a fixed credential (an `mcp_*` token or
  `PAGESPACE_TOKEN`). Never refreshes. When the server rejects it, the in-flight call fails
  closed instead of retrying the same rejected token — but the rejection is one-shot, not
  sticky: the next call presents the same token again, so a transient 401 doesn't permanently
  brick a long-lived client.

  ```ts
  import { StaticTokenProvider } from '@pagespace/sdk';
  const auth = new StaticTokenProvider(process.env.PAGESPACE_TOKEN!);
  ```

- **`OAuthTokenProvider(options)`** — manages a refreshable OAuth 2.1 credential (what
  `pagespace login` stores, and what [Sign in with PageSpace](#sign-in-with-pagespace) returns).
  Takes `{ initialTokens, now?, skewMs?, onTokensUpdated? }` plus either your own
  `refreshAccessToken` or `{ tokenEndpoint, clientId, fetch? }` to refresh through PageSpace's
  token endpoint, and refreshes automatically once the access token is within `skewMs` (default
  60s) of `accessExpiresAt`.

  ```ts
  import { OAuthTokenProvider } from '@pagespace/sdk';

  const auth = new OAuthTokenProvider({
    initialTokens: storedTokens, // { accessToken, accessExpiresAt, refreshToken, refreshExpiresAt }
    refreshAccessToken: (refreshToken) => exchangeRefreshToken(refreshToken),
    onTokensUpdated: (tokens) => saveTokens(tokens),
  });
  ```

## Sign in with PageSpace

An app can sign a PageSpace user in and act as them — without ever holding a key. It is OAuth 2.1
authorization code + PKCE with a **public client**: your app has a `client_id` and its exact
redirect URIs registered with PageSpace, and no secret at all, so there is nothing to leak from a
browser bundle, a mobile app or a repo. The user signs in on PageSpace (Google, Apple, passkey or
magic link — whatever their account uses), sees your app's name and exactly what it asks for, and
approves. Your app never sees a password.

### Scopes

| Scope | Grants | Consent |
|---|---|---|
| `profile` | Who the user is: `client.auth.me()` returns `{ id, name, email, image }`. No content. | A plain Allow |
| `drive:<driveId>:member` / `:admin` / `:role:<roleId>`, or `drive:<driveId>` | That one drive, at that role (or with the user's own access in it). Nothing outside it, ever. | Allow, confirmed with a step-up check |
| `offline_access` | A refresh token, so the session outlives the 15-minute access token. | — |

Scopes combine (`profile drive:abc123:member offline_access`); `profile` cannot be combined with
`account`. A grant never widens on refresh.

### In a browser app

`PageSpaceAuth` runs the whole flow: it keeps the PKCE verifier and the `state` in
`sessionStorage`, sends the browser to PageSpace, and on your callback page checks the `state`,
exchanges the code and hands back an `OAuthTokenProvider` that refreshes itself.

```ts
import { PAGESPACE_CALLBACK_PATH, PageSpaceAuth, PageSpaceClient } from '@pagespace/sdk';

const auth = new PageSpaceAuth({
  baseUrl: 'https://pagespace.ai',
  clientId: 'your-client-id',
  redirectUri: `${location.origin}${PAGESPACE_CALLBACK_PATH}`, // registered exactly
  scope: 'profile offline_access',
});

// On the callback page, finish the sign-in; anywhere else, pick up the current session.
const provider =
  location.pathname === PAGESPACE_CALLBACK_PATH ? await auth.handleRedirectCallback(location.href) : auth.restore();

if (provider === null) {
  await auth.signInWithRedirect(); // wire this to your "Sign in with PageSpace" button
} else {
  const client = new PageSpaceClient({ baseUrl: auth.baseUrl, auth: provider });
  const me = await client.auth.me({});
  console.log(`Signed in as ${me.name} <${me.email}>`);
}
```

`PAGESPACE_CALLBACK_PATH` is `/auth/pagespace/callback`, the path PageSpace-hosted apps use.
`handleRedirectCallback` removes the pending sign-in before anything else, so a callback URL can be
redeemed once; a forged or replayed callback never reaches the token endpoint. Failures are typed:

```ts
import { isSignInError, PageSpaceAuth } from '@pagespace/sdk';

const auth = new PageSpaceAuth({
  baseUrl: 'https://pagespace.ai',
  clientId: 'your-client-id',
  redirectUri: 'https://app.example.com/auth/pagespace/callback',
});

try {
  await auth.handleRedirectCallback(location.href);
} catch (error) {
  if (isSignInError(error) && error.authorizationError === 'access_denied') {
    // The user declined. Anything else — a state mismatch, an expired sign-in, a rejected
    // code (ValidationError), a network failure (NetworkError) — is a different, typed error.
  } else {
    throw error;
  }
}
```

No token ever appears in an error message or a log line from this package.

### Where tokens live

By default `PageSpaceAuth` keeps the pending sign-in and the signed-in session — the access token,
and the refresh token when `offline_access` was granted — in `sessionStorage`. That storage is
scoped to the tab and gone when the tab closes, but **any script running on your page can read
it**: an XSS bug in your app exposes the session. So:

- Request `offline_access` only when the app needs sessions longer than the 15-minute access
  token. Without it there is no refresh token to steal, and the session simply ends.
- To keep nothing at rest, pass your own storage — for example an in-memory one. The sign-in then
  lasts only as long as the page, and a full-page redirect would lose the pending sign-in, so use
  it with a popup: this page keeps the verifier in memory, and the popup's callback page hands its
  URL back (e.g. `window.opener.postMessage(location.href, origin)`) for this page to finish:

  ```ts
  import { PageSpaceAuth, type AuthStorage } from '@pagespace/sdk';

  const memory = new Map<string, string>();
  const inMemory: AuthStorage = {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => {
      memory.set(key, value);
    },
    removeItem: (key) => {
      memory.delete(key);
    },
  };

  const auth = new PageSpaceAuth({
    baseUrl: 'https://pagespace.ai',
    clientId: 'your-client-id',
    redirectUri: 'https://app.example.com/auth/pagespace/callback',
    storage: inMemory,
  });
  window.open(await auth.createSignInUrl(), 'pagespace-sign-in', 'popup'); // from your button's click handler
  window.addEventListener('message', async (event) => {
    if (event.origin !== location.origin || typeof event.data !== 'string') return;
    const provider = await auth.handleRedirectCallback(event.data); // state is still checked here
    console.log('signed in', provider.canRefresh);
  });
  ```

- A server-rendered app should keep tokens on the server (a backend-for-frontend, see
  [On a server](#on-a-server)) and never ship them to the browser at all — the browser holds only
  your own session cookie.

### In a PageSpace environment

An app built and hosted in a PageSpace environment gets two public values in its environment,
`PAGESPACE_URL` and `PAGESPACE_CLIENT_ID`, and needs no other configuration:

```ts
import { PageSpaceClient } from '@pagespace/sdk';

// Redirect URI: this page's origin + /auth/pagespace/callback.
const auth = PageSpaceClient.fromEnvironment();
await auth.signInWithRedirect();
```

`fromEnvironment()` reads `process.env` and `location.origin`; in a browser bundle, pass the values
your bundler exposes (with Vite: `envPrefix: ['VITE_', 'PAGESPACE_']`, then
`fromEnvironment({ env: import.meta.env })`). If either variable is missing it throws a
`PageSpaceConfigError` naming it, before any request.

### On a server

A server-rendered app keeps the verifier and `state` in its own session and the tokens server-side.
The building blocks are exported individually:

```ts
import { randomBytes } from 'node:crypto';
import {
  buildAuthorizeUrl,
  deriveCodeChallenge,
  exchangeAuthorizationCode,
  generateCodeVerifier,
  pageSpaceOAuthEndpoints,
  parseCallback,
} from '@pagespace/sdk';

const BASE_URL = 'https://pagespace.ai';
const CLIENT_ID = 'your-client-id';
const REDIRECT_URI = 'https://app.example.com/auth/pagespace/callback';

/** Returns the URL to redirect the user to; the session keeps what the callback needs. */
export async function startSignIn(session: Map<string, string>): Promise<string> {
  const codeVerifier = generateCodeVerifier(randomBytes(32));
  const state = randomBytes(32).toString('base64url');
  session.set('pagespace.state', state);
  session.set('pagespace.verifier', codeVerifier);
  return buildAuthorizeUrl({
    baseUrl: BASE_URL,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    scope: 'profile offline_access',
    state,
    codeChallenge: await deriveCodeChallenge(codeVerifier),
  });
}

export async function finishSignIn(session: Map<string, string>, callbackUrl: string) {
  const state = session.get('pagespace.state') ?? '';
  const codeVerifier = session.get('pagespace.verifier') ?? '';
  session.delete('pagespace.state');
  session.delete('pagespace.verifier');

  const callback = parseCallback(callbackUrl, state); // never throws; state is compared first
  if (!callback.ok) throw new Error(`Sign-in failed: ${callback.error.reason}`);

  const tokens = await exchangeAuthorizationCode({
    tokenEndpoint: pageSpaceOAuthEndpoints(BASE_URL).tokenEndpoint,
    clientId: CLIENT_ID,
    code: callback.code,
    redirectUri: REDIRECT_URI,
    codeVerifier,
  });
  if (tokens.kind !== 'oauth') throw new Error('Unexpected token response');
  return tokens; // { accessToken, refreshToken?, expiresIn, scope } — keep these server-side
}
```

Acting as the user afterwards is an `OAuthTokenProvider` that refreshes through the token endpoint
and tells you when to persist the rotated pair (each refresh token is single-use):

```ts
import { OAuthTokenProvider, PageSpaceClient, pageSpaceOAuthEndpoints, type OAuthTokens } from '@pagespace/sdk';

export function clientFor(tokens: OAuthTokens, save: (tokens: OAuthTokens) => Promise<void>): PageSpaceClient {
  const baseUrl = 'https://pagespace.ai';
  const auth = new OAuthTokenProvider({
    initialTokens: tokens,
    tokenEndpoint: pageSpaceOAuthEndpoints(baseUrl).tokenEndpoint,
    clientId: 'your-client-id',
    onTokensUpdated: save, // awaited before the new access token is used
  });
  return new PageSpaceClient({ baseUrl, auth });
}
```

### Native apps

No SDK is required: a native app makes four HTTP calls — discovery, the authorize URL (opened in the
system browser, e.g. `ASWebAuthenticationSession`, with a private-scheme redirect such as
`swipesend://callback`), the code exchange, and refresh. They are written out in
[Sign in with PageSpace from a native app](https://github.com/2witstudios/PageSpace/blob/master/docs/sdk/native-signin.md).

### Signing out and revocation

```ts
import { PageSpaceClient } from '@pagespace/sdk';

const auth = PageSpaceClient.fromEnvironment();
const result = await auth.signOut(); // revokes the refresh token, forgets the session
if (result?.outcome === 'failed' && result.retryable) {
  // The local session is already gone; the server can be asked again later.
}
```

`revokeToken` does the same for a token you hold yourself. The user can also cut your app off at
any time from **Settings → Account → Connected Apps** in PageSpace, and **Revoke all devices**
there ends every app's access at once. Your next request then fails with an
`AuthenticationError`: the provider tries one refresh, the server refuses it, and the provider
stops presenting the credential.

## Resource namespaces

Every registered operation is a generated, fully-typed method under a domain namespace — no
hand-written wrappers, no second-class tier. One example per namespace:

| Namespace | Example call |
|---|---|
| `client.drives` | `client.drives.list({})` |
| `client.pages` | `client.pages.create({ driveId, title, type: 'DOCUMENT' })` |
| `client.sheets` | `client.sheets.queryRows({ pageId, where: { column: 'A', op: 'eq', value: 'open' } })` |
| `client.sheets` (formatting) | `client.sheets.applyFormat({ pageId, ops: [{ type: 'upsertRegion', region: { id: 'spend', range: 'A1:F', headerRows: 1 } }] })` |
| `client.roles` | `client.roles.setPagePermissions({ driveId, roleId, permissionsPatch })` |
| `client.tasks` | `client.tasks.create({ pageId, title })` |
| `client.agents` | `client.agents.ask({ agentId, question })` |
| `client.conversations` | `client.conversations.read({ agentId, conversationId })` |
| `client.export` | `client.export.pageMarkdown({ pageId })` |
| `client.tokens` | `client.tokens.list({})` |
| `client.search` | `client.search.glob({ driveId, pattern })` |
| `client.activity` | `client.activity.get({ driveId })` |
| `client.channels` | `client.channels.send({ pageId, content })` |
| `client.calendar` | `client.calendar.list({ startDate, endDate })` |
| `client.collaborators` | `client.collaborators.list({})` |
| `client.commands` | `client.commands.list({})` |
| `client.members` | `client.members.list({ driveId })` |
| `client.workflows` | `client.workflows.list({ driveId })` |
| `client.uploads` | `client.uploads.presign({ contentHash, driveId, filename, mimeType, fileSize })` |

### Uploading a file

Reach for `uploadFile` rather than the `uploads` operations directly — an upload is three
legs, and the middle one is a binary `PUT` to object storage that deliberately does not go
through the SDK transport (its body is a string and its response parser reads JSON or text):

```ts
import { PageSpaceClient, StaticTokenProvider, uploadFile } from '@pagespace/sdk';

const client = new PageSpaceClient({ baseUrl, auth: new StaticTokenProvider(token) });

const { page, deduplicated } = await uploadFile(client, {
  driveId,
  bytes: await file.arrayBuffer(),
  filename: 'clip.mp4',
  mimeType: 'video/mp4',
  parentId,            // optional: where in the tree it lands
});
```

Storage is a **global content-addressed namespace**, which produces two outcomes worth
handling explicitly:

- `deduplicated: true` — the caller already references these exact bytes, so no upload was
  needed. The page was still created. This is a success.
- A **409 from presign** — the bytes exist globally but this caller has never referenced
  them. That is the cross-tenant claim guard, not deduplication; possession has to be proven
  by uploading the original file under a caller that legitimately holds it.

Any failure after the reservation releases the upload slot via `uploads.cancel`, so an
abandoned upload does not count against the caller's concurrent-upload limit.

The bytes are sent with `redirect: 'error'` — a presigned `PUT` is terminal, and following a
redirect would forward the file to a host the signature was never issued for. A plaintext
`http://` storage target is refused unless it is loopback (local MinIO and friends) or you
opt in with `allowInsecureStorageUrl: true`, which a deployment reaching its object storage
over http at an internal hostname will need.

### The `tokens` namespace needs an OAuth credential

`client.tokens.list` / `client.tokens.revoke` manage `mcp_` API keys, but the server only
accepts a **`ps_at_` OAuth access token** (what `pagespace login` / the OAuth authorize flow
issues) — or a web session — on those routes. An `mcp_` token in a `StaticTokenProvider` works
for every other namespace yet gets a 401 here. There is deliberately no `client.tokens.create`:
key **minting** is session-only server-side, so new keys come only from the OAuth
authorize/consent flow (`pagespace keys create`) or the web UI — never from the SDK.

## Custom operations

Operations are plain data (`defineOperation`), and `client.invoke(op, input)` runs any of them —
including ones you define yourself — through the same validated pipeline, preserving the
operation's own input/output types:

```ts
import { defineOperation } from '@pagespace/sdk';
import { z } from 'zod'; // zod v4 — schemas from zod v3 are not assignable

const getWidget = defineOperation({
  name: 'widgets.get',
  method: 'GET',
  path: '/api/widgets/:widgetId',
  inputSchema: z.object({ widgetId: z.string() }),
  outputSchema: z.object({ id: z.string(), label: z.string() }),
  description: 'Get a widget.',
});

const widget = await client.invoke(getWidget, { widgetId: 'w1' });
```

## Errors

Every failure is a typed subclass of `PageSpaceError` (`AuthenticationError`, `ValidationError`,
`NotFoundError`, `PermissionDeniedError`, `RateLimitError`, `ServerError`, `NetworkError`,
`TimeoutError`, `IncompatibleServerError`, `ResponseValidationError`, and `HttpError` — the
fallback for any HTTP status not otherwise classified, e.g. 402, 409, or an unexpected 3xx),
each with a matching `is*Error()` type guard:

```ts
import { isRateLimitError } from '@pagespace/sdk';

try {
  await client.pages.create({ driveId, title: 'Notes', type: 'DOCUMENT' });
} catch (error) {
  if (isRateLimitError(error)) {
    // error.retryAfterMs is set when the server sent one
  }
  throw error;
}
```

Failed GETs are retried automatically (network errors, timeouts, 429s, 5xx) with jittered
exponential backoff — a 429's `Retry-After` is honored when the server sends one, capped at
`retryPolicy.maxDelayMs`; mutating methods are never replayed. Tune via
`PageSpaceClientOptions.retryPolicy`.

## Server version compatibility

`PageSpaceClient` enforces the
[ADR 0001](https://github.com/2witstudios/PageSpace/blob/master/docs/adr/0001-sdk-api-versioning.md)
handshake: on the first successful 2xx response for a client instance, the SDK checks the
server's API version against its compiled-in `MIN_SERVER_API_VERSION` — later responses aren't
rechecked — and an incompatible server fails closed with `IncompatibleServerError` (opt out only
via the explicit `skipVersionCheck: true`).

## See also

- [`@pagespace/cli`](https://github.com/2witstudios/PageSpace/tree/master/packages/cli) —
  `pagespace login`, CLI verbs over this SDK, and the `pagespace mcp` server.
- [PageSpace MCP integration docs](https://pagespace.ai/docs/integrations/mcp)
- [Migrating from `pagespace-mcp`](https://github.com/2witstudios/PageSpace/blob/master/packages/cli/docs/migrating-from-pagespace-mcp.md)
- [CHANGELOG](https://github.com/2witstudios/PageSpace/blob/master/packages/sdk/CHANGELOG.md)
