import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "MCP API",
  description: "PageSpace MCP API: document operations, drive listing, and path detection for MCP clients.",
  path: "/docs/api/mcp",
  keywords: ["API", "MCP", "Model Context Protocol", "document operations"],
});

const content = `
# MCP API

API endpoints for MCP (Model Context Protocol) clients. These routes are used by the \`pagespace-mcp\` server to interact with PageSpace.

All MCP routes authenticate via \`Authorization: Bearer mcp_...\` header.

## Document Operations

### POST /api/mcp/documents

Perform line operations on document content.

**Body:**
\`\`\`json
{
  "pageId": "string",
  "operation": "read | replace | insert | delete",
  "startLine": 1,
  "endLine": 10,
  "content": "string (for replace/insert)"
}
\`\`\`

**Operations:**
- \`read\` — Read content with line numbers
- \`replace\` — Replace lines in a range
- \`insert\` — Insert content at a line
- \`delete\` — Delete lines in a range

Content is automatically formatted and validated.

## Drive Discovery

### GET /api/mcp/drives

List drives accessible via the MCP token.

**Response:**
\`\`\`json
[{
  "id": "string",
  "name": "string",
  "slug": "string",
  "pageCount": 23
}]
\`\`\`

If the token is scoped to specific drives, only those drives are returned.

## Path Detection

### GET /api/mcp/detect-paths

Detect and resolve MCP paths for integrations. Used by the MCP server to resolve page references.

## Authentication

MCP API routes use Bearer token authentication:

\`\`\`
Authorization: Bearer mcp_abc123...
\`\`\`

Tokens are created via \`POST /api/auth/mcp-tokens\` or Settings > MCP in the web UI. Each token authenticates as a specific user with that user's permissions.
`;

export default function McpApiPage() {
  return <DocsMarkdown content={content} />;
}
