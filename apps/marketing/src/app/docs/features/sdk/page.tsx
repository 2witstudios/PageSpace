import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "PageSpace SDK",
  description: "The typed TypeScript client for the PageSpace API — install, authenticate, and call drives, pages, tasks, search, and agents from your own code.",
  path: "/docs/features/sdk",
  keywords: ["SDK", "TypeScript", "API", "client", "@pagespace/sdk", "developers"],
});

const content = `
# PageSpace SDK

\`@pagespace/sdk\` is the typed TypeScript client for the PageSpace API. Everything you can do in the app — create pages, edit documents, run searches, manage tasks, ask agents — you can do from your own code, with full type inference on every call.

It's the same client the [\`pagespace\` CLI](/docs/features/cli) and the \`pagespace mcp\` server are built on. All three surfaces are generated from one operation registry, so they can't drift apart.

## Install

\`\`\`bash
npm install @pagespace/sdk
\`\`\`

ESM only, with a single runtime dependency (\`zod\`). The current version is **2.6.0**.

## Quickstart

\`\`\`typescript
import { PageSpaceClient, StaticTokenProvider } from '@pagespace/sdk';

const client = new PageSpaceClient({
  baseUrl: 'https://pagespace.ai',
  auth: new StaticTokenProvider(process.env.PAGESPACE_TOKEN!),
});

const drives = await client.drives.list({});

const page = await client.pages.create({
  driveId: drives[0].id,
  title: 'Release Notes',
  type: 'DOCUMENT',
});

await client.pages.replaceLines({
  pageId: page.id,
  startLine: 1,
  endLine: 1,
  content: '# Release Notes\\n\\nShipped today.',
});
\`\`\`

## Authentication

The client takes an \`auth\` provider. There are two.

**\`StaticTokenProvider\`** — wraps a fixed \`mcp_\` API key. This is what you want for scripts, CI jobs, and service accounts. Mint a key with \`pagespace keys create --drive <id> --role member --show-token\`, or from **Settings > MCP** in the app, and pass it straight in:

\`\`\`typescript
new StaticTokenProvider(process.env.PAGESPACE_TOKEN!)
\`\`\`

**\`OAuthTokenProvider\`** — a user's refreshable OAuth credential. You get one from **Sign in with PageSpace** (below); it refreshes itself before the access token expires and hands you each rotated pair to persist.

An \`mcp_\` key works for every namespace except \`client.tokens\`, which manages keys themselves and requires an OAuth token.

## Sign in with PageSpace

Your app can sign a PageSpace user in and act as them — without ever holding a key. The user signs in on PageSpace (Google, Apple, passkey or magic link), sees your app's name and exactly what it asks for, and approves. Your app is a public OAuth client: it has a \`client_id\` and its exact redirect URIs registered with PageSpace, and no secret at all, so there is nothing to leak from a browser bundle, a mobile app, or a repo.

\`\`\`typescript
import { PAGESPACE_CALLBACK_PATH, PageSpaceAuth, PageSpaceClient } from '@pagespace/sdk';

const auth = new PageSpaceAuth({
  baseUrl: 'https://pagespace.ai',
  clientId: 'your-client-id',
  redirectUri: \`\${location.origin}\${PAGESPACE_CALLBACK_PATH}\`,
  scope: 'profile offline_access',
});

// On the callback page, finish the sign-in; anywhere else, pick up the current session.
const provider =
  location.pathname === PAGESPACE_CALLBACK_PATH ? await auth.handleRedirectCallback(location.href) : auth.restore();

if (provider === null) {
  await auth.signInWithRedirect(); // your "Sign in with PageSpace" button
} else {
  const client = new PageSpaceClient({ baseUrl: auth.baseUrl, auth: provider });
  const me = await client.auth.me({});
}
\`\`\`

\`signInWithRedirect\` keeps a PKCE verifier and a one-time \`state\` in \`sessionStorage\` and sends the browser to PageSpace. \`handleRedirectCallback\` checks the \`state\` before anything else, exchanges the code, and returns an \`OAuthTokenProvider\` that refreshes through PageSpace's token endpoint. \`restore()\` brings the session back after a reload, and \`signOut()\` revokes it. Failures are typed — \`isSignInError(error) && error.authorizationError === 'access_denied'\` means the user declined — and no token ever appears in an error or a log line.

**Scopes.** Ask for only what you need:

| Scope | Grants |
|-------|--------|
| \`profile\` | Who the user is — \`client.auth.me()\` returns \`{ id, name, email, image }\`. No content. A plain Allow. |
| \`drive:<driveId>:member\` (or \`:admin\`, \`:role:<roleId>\`) | That one drive at that role, and nothing outside it. The user confirms with a step-up check. |
| \`offline_access\` | A refresh token, so the session outlives the 15-minute access token. |

**Apps built in PageSpace.** An app hosted in a PageSpace environment gets \`PAGESPACE_URL\` and \`PAGESPACE_CLIENT_ID\` in its environment — two public values — and needs no other setup. The redirect URI is the page's own origin plus \`/auth/pagespace/callback\`:

\`\`\`typescript
import { PageSpaceClient } from '@pagespace/sdk';

const auth = PageSpaceClient.fromEnvironment();
await auth.signInWithRedirect();
\`\`\`

**Servers and native apps.** A server-rendered app uses the same building blocks the browser flow is made of — \`buildAuthorizeUrl\`, \`parseCallback\`, \`exchangeAuthorizationCode\`, and \`OAuthTokenProvider\` with PageSpace's token endpoint — keeping the verifier and tokens server-side; the [SDK README](https://github.com/2witstudios/PageSpace/tree/master/packages/sdk#sign-in-with-pagespace) has the full example. A native app needs no SDK: it makes [four HTTP calls](https://github.com/2witstudios/PageSpace/blob/master/docs/sdk/native-signin.md) — discovery, the authorize URL in the system browser with a private-scheme redirect like \`swipesend://callback\`, the code exchange, and refresh.

**Revocation.** The user can disconnect your app at any time from **Settings → Account → Connected Apps**; its next request fails with \`AuthenticationError\`.

## Resource namespaces

Every operation hangs off a namespace on the client. Inputs and outputs are schema-validated, so your editor knows the shape of both.

| Namespace | What it does |
|-----------|-------------|
| \`auth\` | \`me\` — the signed-in user's identity |
| \`drives\` | \`list\`, \`create\`, \`rename\`, \`updateContext\`, \`setHomePage\`, \`trash\`, \`restore\` |
| \`pages\` | \`list\`, \`listTrash\`, \`create\`, \`details\`, \`rename\`, \`move\`, \`trash\`, \`restore\` — plus content editing: \`read\`, \`replaceLines\`, \`insertLines\`, \`deleteLines\`, \`editCells\` |
| \`tasks\` | \`create\`, \`update\`, \`delete\`, \`reorder\`, \`getAssigned\`, \`createStatus\`, \`setTrigger\`, \`deleteTrigger\` |
| \`sheets\` | \`describe\`, \`queryRows\`, \`getRows\`, \`appendRows\`, \`updateCells\`, \`deleteRows\` — a spreadsheet as queryable rows; \`readFormatting\`, \`applyFormat\` — how it looks |
| \`search\` | \`regex\`, \`glob\`, \`multiDrive\` |
| \`agents\` | \`list\`, \`listMultiDrive\`, \`ask\`, \`updateConfig\`, \`listModels\` |
| \`conversations\` | \`list\`, \`read\` — full transcripts of an agent's conversations |
| \`channels\` | \`send\`, \`delete\` |
| \`calendar\` | \`list\`, \`get\`, \`create\`, \`update\`, \`delete\`, \`rsvp\`, \`inviteAttendees\`, \`removeAttendee\`, \`setTrigger\`, \`deleteTrigger\` |
| \`roles\` | \`list\`, \`get\`, \`create\`, \`update\`, \`delete\`, \`setPagePermissions\`, \`setDriveWidePermissions\`, \`removePagePermissions\` |
| \`members\` | \`list\` — who's on a drive |
| \`collaborators\` | \`list\` — people you share any drive with |
| \`commands\` | \`list\`, \`create\`, \`update\`, \`delete\` — slash commands |
| \`workflows\` | \`list\`, \`create\`, \`update\`, \`delete\` |
| \`activity\` | \`get\` — a drive's activity feed |
| \`export\` | \`pageMarkdown\`, \`sheetCsv\` |
| \`tokens\` | \`list\`, \`revoke\` — API keys (OAuth only); \`describeSelf\` — what the calling credential can do |

Reading and writing document content lives on \`pages\`, not a separate namespace:

\`\`\`typescript
// Read with line numbers, or a range
const doc = await client.pages.read({ pageId, lineStart: 1, lineEnd: 50 });

// Line-addressed edits
await client.pages.insertLines({ pageId, anchor: '## Changelog', content: '- Fixed a bug', position: 'after' });
await client.pages.deleteLines({ pageId, startLine: 10, endLine: 12 });

// Sheet cells
await client.pages.editCells({ pageId, cells: [{ address: 'A1', value: 'Hello' }] });
\`\`\`

### Spreadsheets as data

A sheet with 100,000 rows is not something you want to download to find twelve. \`sheets\` filters, sorts and pages server-side:

\`\`\`typescript
const { rows, total } = await client.sheets.queryRows({
  pageId,
  where: { and: [
    { column: 'C', op: 'eq', value: 'open' },
    { column: 'F', op: 'gt', value: 1000 },
  ]},
  orderBy: [{ column: 'F', direction: 'desc' }],
  limit: 20,
});

console.log(\`showing \${rows.length} of \${total}\`);
\`\`\`

Filters match the values you **see**: a formula column compares as its result, not its \`=\` text. Every cell carries both — \`raw\` is what was authored, \`value\` what it evaluates to.

### Spreadsheets as documents

Rows are the data; \`applyFormat\` is the presentation. The useful move is almost never formatting cells — it is declaring what an area **is**, and letting the sheet derive the rest:

\`\`\`typescript
// Read first, so you build on the tables and rules already declared
const current = await client.sheets.readFormatting({ pageId });

await client.sheets.applyFormat({
  pageId,
  ops: [
    {
      type: 'upsertRegion',
      region: {
        id: 'spend',
        range: 'A1:F',              // open-ended: covers rows you add later
        headerRows: 1,
        totalRows: [40],
        columns: [{ column: 'C', role: 'currency', currency: 'USD' }],
        theme: 'blue',
      },
    },
    { type: 'setFrozen', rows: 1 },
    {
      type: 'addConditionalRule',
      rule: {
        kind: 'cell',
        id: 'overspend',            // your id, so a retry cannot double it
        ranges: ['C2:C40'],
        condition: { operator: 'lessThan', value: '0' },
        format: { color: '#b91c1c', bold: true },
      },
    },
  ],
});
\`\`\`

A region covers rows that do not exist yet and costs nothing however tall the sheet is, which is why it beats formatting the fifty rows you happened to read. Ops apply in the order given, in one transaction, all or nothing — one bad op refuses the whole call and names its index, so a batch never half-applies.

Need an endpoint the SDK doesn't wrap? \`defineOperation\` lets you declare one with its own Zod schemas and call it through \`client.invoke\`, keeping the same typing, auth, and retry behaviour.

## Error handling

Every failure is a typed subclass of \`PageSpaceError\`, each with a matching \`is*Error()\` type guard — so you can branch on what went wrong without string-matching messages.

\`\`\`typescript
import { isRateLimitError, isPermissionDeniedError, isValidationError } from '@pagespace/sdk';

try {
  await client.pages.create({ driveId, title: 'Notes', type: 'DOCUMENT' });
} catch (error) {
  if (isValidationError(error)) {
    // 400 — input rejected; error.details has field-level info
  } else if (isPermissionDeniedError(error)) {
    // 403 — the credential's role doesn't allow this
  } else if (isRateLimitError(error)) {
    // 429 — error.retryAfterMs is set when the server sends Retry-After
  }
  throw error;
}
\`\`\`

| Error | When |
|-------|------|
| \`ValidationError\` | 400 — the input was rejected |
| \`AuthenticationError\` | 401 — token missing, invalid, or expired |
| \`PermissionDeniedError\` | 403 — the credential's role doesn't permit it |
| \`NotFoundError\` | 404 |
| \`RateLimitError\` | 429 — carries \`retryAfterMs\` |
| \`ServerError\` | 5xx |
| \`NetworkError\` | the request never left (DNS, connection refused) |
| \`TimeoutError\` | the request exceeded \`timeoutMs\` |
| \`IncompatibleServerError\` | the server's API version is too old for this SDK |
| \`ResponseValidationError\` | the server returned a shape the SDK didn't expect |
| \`HttpError\` | any other status (402, 409, …) |

## Retries

Reads retry themselves. A failed GET — network error, timeout, 429, or 5xx — is retried with full-jitter exponential backoff: 3 retries, starting at 250 ms, capped at 5 s. A \`Retry-After\` header is honoured when the server sends one, clamped to the same ceiling.

Writes are never replayed. POST, PUT, PATCH, and DELETE fail straight through to you, so a retry can never duplicate a page or a task.

Tune it per-client:

\`\`\`typescript
new PageSpaceClient({
  baseUrl,
  auth,
  retryPolicy: { maxRetries: 5, maxDelayMs: 30_000 },
  timeoutMs: 15_000,
});
\`\`\`

## Server compatibility

On its first successful response, the SDK compares the server's API version against the minimum it supports. If the server is too old, it fails closed with \`IncompatibleServerError\` rather than making calls that might silently misbehave. You can bypass the check with \`skipVersionCheck: true\`, but you generally shouldn't.

## Next steps

- **[PageSpace CLI](/docs/features/cli)** — the same operations from your shell, plus the \`pagespace mcp\` server
- **[MCP Integration](/docs/integrations/mcp)** — connect Claude Desktop, Claude Code, or Cursor to your workspace
- **[Sharing & Permissions](/docs/features/sharing)** — what a drive-scoped key can and can't reach
`;

export default function SdkPage() {
  return <DocsMarkdown content={content} />;
}
