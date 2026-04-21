import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "MCP API",
  description: "PageSpace MCP API: document and sheet operations, drive listing, and drive creation for MCP clients.",
  path: "/docs/api/mcp",
  keywords: ["API", "MCP", "Model Context Protocol", "document operations", "drives"],
});

const content = `
# MCP API

Endpoints for MCP (Model Context Protocol) clients such as the \`pagespace-mcp\` npm package. All routes authenticate via \`Authorization: Bearer mcp_...\`. See [MCP integration](/docs/mcp) for token setup.

MCP tokens authenticate as the owning user and inherit that user's permissions. A token may be scoped to specific drives; scoped tokens cannot create new drives and cannot touch pages outside their allow-list.

## Document and sheet operations

### POST /api/mcp/documents

Perform line or cell operations on a page's content. Works for document, code, and sheet pages.

**Body:**
\`\`\`json
{
  "operation": "read | replace | insert | delete | edit-cells",
  "pageId": "string",
  "startLine": 1,
  "endLine": 10,
  "content": "string",
  "cells": [{ "address": "A1", "value": "string" }]
}
\`\`\`

If \`pageId\` is omitted, the server falls back to the user's most recently updated page they own.

**Operations:**
- \`read\` — Return content with line numbers.
- \`replace\` — Replace lines in \`[startLine, endLine]\`.
- \`insert\` — Insert \`content\` starting at \`startLine\`.
- \`delete\` — Delete lines in \`[startLine, endLine]\`.
- \`edit-cells\` — Update named cells on a sheet page via \`cells\`. Addresses are validated (e.g. \`A1\`, \`BC42\`).

Edits broadcast a \`page:updated\` event to the drive's Socket.IO room. Page edits are revision-checked and will return a mismatch error if another writer has moved past the expected revision.

## Drives

### GET /api/mcp/drives

List drives the token can access. Scoped tokens return only the drives in their allow-list; unscoped tokens return every drive the owning user can see (owned + member).

---

### POST /api/mcp/drives

Create a new drive.

**Body:**
\`\`\`json
{ "name": "string" }
\`\`\`

Scoped tokens are rejected with \`403\`. The name \`Personal\` is reserved.

## Authentication

Send the token in the \`Authorization\` header:

\`\`\`
Authorization: Bearer mcp_abc123...
\`\`\`

Tokens are created via [\`POST /api/auth/mcp-tokens\`](/docs/api/auth#mcp-tokens) or **Settings > MCP** in the web UI. The raw token is returned once at creation; only the SHA-256 hash is persisted.

MCP-authenticated calls skip CSRF (Bearer tokens are not vulnerable to CSRF).
`;

export default function McpApiPage() {
  return <DocsMarkdown content={content} />;
}
