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

ESM only, with a single runtime dependency (\`zod\`). The current version is **2.1.0**.

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

**\`OAuthTokenProvider\`** — for apps that log a *user* in and act on their behalf. You give it an initial token pair and a refresh function; it refreshes proactively before expiry and hands you the new pair to persist.

\`\`\`typescript
import { OAuthTokenProvider } from '@pagespace/sdk';

const auth = new OAuthTokenProvider({
  initialTokens: { accessToken, accessExpiresAt, refreshToken, refreshExpiresAt },
  refreshAccessToken: (refreshToken) => exchangeRefreshToken(refreshToken),
  onTokensUpdated: (tokens) => saveTokens(tokens),
});
\`\`\`

Building your own browser-based login? The SDK ships the PKCE helpers too — \`generateCodeVerifier\` and \`deriveCodeChallenge\` (async; it runs on Web Crypto so it works in a browser bundle).

An \`mcp_\` key works for every namespace except \`client.tokens\`, which manages keys themselves and requires an OAuth token.

## Resource namespaces

Every operation hangs off a namespace on the client. Inputs and outputs are schema-validated, so your editor knows the shape of both.

| Namespace | What it does |
|-----------|-------------|
| \`drives\` | \`list\`, \`create\`, \`rename\`, \`updateContext\`, \`setHomePage\`, \`trash\`, \`restore\` |
| \`pages\` | \`list\`, \`listTrash\`, \`create\`, \`details\`, \`rename\`, \`move\`, \`trash\`, \`restore\` — plus content editing: \`read\`, \`replaceLines\`, \`insertLines\`, \`deleteLines\`, \`editCells\` |
| \`tasks\` | \`create\`, \`update\`, \`delete\`, \`reorder\`, \`getAssigned\`, \`createStatus\`, \`setTrigger\`, \`deleteTrigger\` |
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
| \`tokens\` | \`list\`, \`revoke\` — API keys (OAuth only) |

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
