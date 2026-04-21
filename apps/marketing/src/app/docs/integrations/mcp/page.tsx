import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "MCP Integration",
  description: "Connect AI tools like Claude Desktop, Claude Code, and Cursor to PageSpace via the Model Context Protocol. Create tokens, configure servers, and wire up external clients.",
  path: "/docs/integrations/mcp",
  keywords: ["MCP", "Model Context Protocol", "AI integration", "Claude", "Cursor", "API tokens"],
});

const content = `
# MCP Integration

PageSpace speaks the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) — an open standard for giving AI tools access to external data and actions. The companion \`pagespace-mcp\` npm package runs locally as an MCP server and lets tools like Claude Desktop, Claude Code, and Cursor read and write your PageSpace workspace.

\`\`\`
AI tool (MCP client)  →  pagespace-mcp (MCP server)  →  PageSpace API
                                                         ↓
                                                    Your workspace
\`\`\`

Tokens authenticate as your user. Every operation runs with your permissions; drive-scoped tokens restrict access further.

## Step 1: Create an MCP token

1. Open **Settings > MCP** in PageSpace.
2. Click **Create Token** and give it a name.
3. Copy the token. It starts with \`mcp_\` and is shown **once** — only the SHA-256 hash is stored server-side.
4. Optionally scope the token to specific drives. Scoped tokens cannot create new drives.

## Step 2: Configure your AI tool

The config format follows the standard MCP \`mcpServers\` schema:

\`\`\`json
{
  "mcpServers": {
    "pagespace": {
      "command": "npx",
      "args": ["-y", "pagespace-mcp@latest"],
      "env": {
        "PAGESPACE_API_URL": "https://pagespace.ai",
        "PAGESPACE_AUTH_TOKEN": "mcp_your_token_here"
      }
    }
  }
}
\`\`\`

### Claude Desktop

Edit \`claude_desktop_config.json\`:
- **macOS**: \`~/Library/Application Support/Claude/claude_desktop_config.json\`
- **Windows**: \`%APPDATA%\\\\Claude\\\\claude_desktop_config.json\`

### Claude Code

\`\`\`bash
claude mcp add pagespace -- npx -y pagespace-mcp@latest
\`\`\`

Then set \`PAGESPACE_API_URL\` and \`PAGESPACE_AUTH_TOKEN\` in your environment.

### Cursor

**Settings > MCP Servers** → add the \`mcpServers\` block above.

## Step 3: Capabilities

Once connected, \`pagespace-mcp\` exposes tools that wrap the PageSpace API. The exact tool list ships with the npm package and evolves independently; the [pagespace-mcp README](https://www.npmjs.com/package/pagespace-mcp) is the authoritative reference.

At a minimum the server covers:

- **Drives** — list accessible drives; create new drives (unscoped tokens only). Backed by \`/api/mcp/drives\`.
- **Pages** — list and navigate the page tree, create pages, read page content, perform line operations and sheet cell edits (\`read\`, \`replace\`, \`insert\`, \`delete\`, \`edit-cells\`). Backed by \`/api/mcp/documents\` and \`/api/pages\`.
- **Search** — global and multi-drive search. Backed by \`/api/search\` and \`/api/search/multi-drive\`.
- **Tasks** — query and manage tasks on \`TASK_LIST\` pages. Backed by \`/api/pages/[pageId]/tasks\`.

Every tool respects the caller's permissions. If you cannot view a page in the web UI, the MCP server cannot see it either.

## Token security

- **Scoped access** — restrict a token to specific drives at creation.
- **Instant revocation** — revoke from **Settings > MCP** or \`DELETE /api/auth/mcp-tokens/[tokenId]\`.
- **Audit logging** — token create/revoke/use events land in the audit log with the token identifier.
- **Hash-only storage** — the database stores a SHA-256 hash, never the raw token. Losing a token means creating a new one.
- **No automatic expiry** — tokens live until revoked. Rotate on whatever cadence fits your risk model.

## Troubleshooting

**Token rejected**: confirm it hasn't been revoked in **Settings > MCP** and that it starts with \`mcp_\`.

**Connection refused**: check \`PAGESPACE_API_URL\` is correct and reachable from the machine running the MCP server.

**Permission denied**: MCP inherits your user permissions. If you lost access to a drive, the token stops seeing it too.

**Server fails to start**: run \`npx -y pagespace-mcp@latest --help\` to confirm the package installs.
`;

export default function MCPPage() {
  return <DocsMarkdown content={content} />;
}
