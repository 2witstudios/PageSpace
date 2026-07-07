# @pagespace/sdk

The one true typed client for PageSpace. SDK resource methods, `pagespace` CLI verbs, and the
`pagespace mcp` adapter all derive from a single **operation registry** (`{ name, method, path,
inputSchema, outputSchema }`), so tool drift across surfaces is structurally impossible.

The core is **pure**: request-building and response-parsing are side-effect-free functions;
`fetch`, the clock, and randomness are constructor-injected at the edges, never reached for
directly, so unit tests never touch the network.

**Zero trust end-to-end**: every server response is zod-validated against its output schema, and
no code path in this package may ever log token material.

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

Get a token by minting one in **Settings > MCP** in the app. (The [`pagespace` CLI](../cli/README.md)'s
own `pagespace keys create` stores its credential locally under a named profile instead of
printing one, so it isn't a source for a `StaticTokenProvider` string on another machine.)

## Auth providers

`PageSpaceClient` takes any `AuthProvider` (`{ getAccessToken(): Promise<string>; invalidate(): void }`):

- **`StaticTokenProvider(token: string)`** — wraps a fixed credential (an `mcp_*` token or
  `PAGESPACE_TOKEN`). Never refreshes; once the server rejects it, every subsequent call fails
  closed rather than retrying the same rejected token.

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

## The operation registry

Every domain method comes from the same registry entry shape (`defineOperation`), so the SDK
method, the CLI verb, and the `pagespace mcp` tool for a given operation always agree on inputs
and outputs:

```ts
import { defineOperation } from '@pagespace/sdk';
import { z } from 'zod';

const getWidget = defineOperation({
  name: 'widgets.get',
  method: 'GET',
  path: '/api/widgets/:widgetId',
  inputSchema: z.object({ widgetId: z.string() }),
  outputSchema: z.object({ id: z.string(), label: z.string() }),
  description: 'Get a widget.',
});
```

Every registered operation is also reachable through the fully-typed escape hatch
`client.invoke(op, input)`, which preserves that operation's own input/output types regardless of
whether it has a generated namespace method.

## Resource namespaces

`PageSpaceClient` exposes one generated method per registered operation, grouped by domain
namespace. One example per namespace:

| Namespace | Example call |
|---|---|
| `client.drives` | `client.drives.list({})` |
| `client.pages` | `client.pages.create({ driveId, title, type: 'DOCUMENT' })` |
| `client.roles` | `client.roles.setPagePermissions({ driveId, roleId, permissionsPatch })` |
| `client.tasks` | `client.tasks.create({ pageId, title })` |
| `client.agents` | `client.agents.ask({ agentId, question })` |
| `client.conversations` | `client.conversations.read({ agentId, conversationId })` |
| `client.export` | `client.export.pageMarkdown({ pageId })` |
| `client.tokens` | `client.tokens.create({ name })` |
| `client.search` | `client.search.glob({ driveId, pattern })` |
| `client.activity` | `client.activity.get({ driveId })` |
| `client.channels` | `client.channels.send({ pageId, content })` |

A handful of operations (calendar, collaborators, commands, drive members, workflows) are
registered and reachable via `pagespace mcp`, but don't yet have a generated namespace method —
call them with `client.invoke(op, input)` using the operation exported from
`@pagespace/sdk`'s `operations/*` modules.

## Errors

Every failure is a typed subclass of `PageSpaceError` (`AuthenticationError`, `ValidationError`,
`NotFoundError`, `PermissionDeniedError`, `RateLimitError`, `ServerError`, `NetworkError`,
`TimeoutError`, `IncompatibleServerError`, `ResponseValidationError`), each with a matching
`is*Error()` type guard:

```ts
import { isRateLimitError } from '@pagespace/sdk';

try {
  await client.pages.create({ driveId, title: 'Notes' });
} catch (error) {
  if (isRateLimitError(error)) {
    // error.retryAfterMs is set when the server sent one
  }
  throw error;
}
```

## Server version compatibility

`PageSpaceClient` enforces the [ADR 0001](../../docs/adr/0001-sdk-api-versioning.md) handshake:
every 2xx response is checked, lazily and once per client instance, against the SDK's compiled-in
`MIN_SERVER_API_VERSION`, and an incompatible server fails closed with `IncompatibleServerError`
(opt out only via the explicit `skipVersionCheck: true`).

## See also

- [`@pagespace/cli`](../cli/README.md) — `pagespace login`, verbs over this SDK, and `pagespace mcp`.
- [Migrating from `pagespace-mcp`](../cli/docs/migrating-from-pagespace-mcp.md) — if you're moving
  off the standalone MCP server.
- PageSpace page `ea07mt5jvw0flihsbjce1iv9` (epic architecture + non-negotiables) and `docs/adr/`
  for the binding decisions this package follows.
