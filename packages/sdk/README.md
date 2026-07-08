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
  `pagespace login` stores). Takes `{ initialTokens, refreshAccessToken, now?, skewMs?,
  onTokensUpdated? }` and refreshes automatically once the access token is within `skewMs`
  (default 60s) of `accessExpiresAt`.

  ```ts
  import { OAuthTokenProvider } from '@pagespace/sdk';

  const auth = new OAuthTokenProvider({
    initialTokens: storedTokens, // { accessToken, accessExpiresAt, refreshToken, refreshExpiresAt }
    refreshAccessToken: (refreshToken) => exchangeRefreshToken(refreshToken),
    onTokensUpdated: (tokens) => saveTokens(tokens),
  });
  ```

## Resource namespaces

Every registered operation is a generated, fully-typed method under a domain namespace — no
hand-written wrappers, no second-class tier. One example per namespace:

| Namespace | Example call |
|---|---|
| `client.drives` | `client.drives.list({})` |
| `client.pages` | `client.pages.create({ driveId, title, type: 'DOCUMENT' })` |
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
