import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "MCP Integration",
  description: "Connect AI tools like Claude, Cursor, and Claude Code to PageSpace via MCP. Set up tokens, configure servers, and use available operations.",
  path: "/docs/mcp",
  keywords: ["MCP", "Model Context Protocol", "AI integration", "Claude", "Cursor", "API tokens"],
});

const content = `
# MCP Integration

PageSpace implements the **Model Context Protocol (MCP)** — an open standard for connecting AI tools to external data sources. This lets tools like Claude Desktop, Claude Code, and Cursor read and write to your PageSpace workspace.

## How It Works

MCP uses a client-server architecture:

1. **Your AI tool** (Claude, Cursor, etc.) is the MCP client
2. **PageSpace MCP server** (\`pagespace-mcp\`) runs locally and connects to PageSpace
3. The server authenticates with an **MCP token** you create in PageSpace

\`\`\`
AI Tool (Client) → pagespace-mcp (Server) → PageSpace API
                                              ↓
                                        Your workspace data
\`\`\`

## Step 1: Create an MCP Token

1. Open **Settings > MCP** in PageSpace
2. Click **Create Token** and give it a descriptive name
3. Copy the token — it starts with \`mcp_\` and is only shown once
4. Optionally scope the token to specific drives

Tokens authenticate as your user. Any operation the MCP server performs runs with your permissions.

## Step 2: Configure Your AI Tool

Add the PageSpace MCP server to your tool's configuration:

\`\`\`json
{
  "mcpServers": {
    "pagespace": {
      "command": "npx",
      "args": ["-y", "pagespace-mcp@latest"],
      "env": {
        "PAGESPACE_API_URL": "https://www.pagespace.ai",
        "PAGESPACE_AUTH_TOKEN": "mcp_your_token_here"
      }
    }
  }
}
\`\`\`

### Claude Desktop

Add the config to \`claude_desktop_config.json\`:
- **macOS**: \`~/Library/Application Support/Claude/claude_desktop_config.json\`
- **Windows**: \`%APPDATA%\\\\Claude\\\\claude_desktop_config.json\`

### Claude Code

\`\`\`bash
claude mcp add pagespace -- npx -y pagespace-mcp@latest
\`\`\`

Then set the environment variables \`PAGESPACE_API_URL\` and \`PAGESPACE_AUTH_TOKEN\`.

### Cursor

Go to **Settings > MCP Servers** and add the server configuration.

## Step 3: Available Operations

Once connected, your AI tool can use these PageSpace operations:

| Operation | Description |
|-----------|-------------|
| \`list_drives\` | List all accessible workspaces |
| \`read_page\` | Read page content (documents, sheets, code) |
| \`create_page\` | Create new pages of any type |
| \`replace_lines\` | Edit document content by line range |
| \`search\` | Find pages across drives by title or content |
| \`update_task\` | Create and manage tasks on task lists |
| \`list_pages\` | Navigate page hierarchies within drives |

All operations respect your user permissions. The MCP server cannot access drives or pages you don't have permission to view or edit.

## Token Security

- **Scoped access**: Tokens can be restricted to specific drives
- **Instant revocation**: Revoke any token from Settings > MCP
- **Audit logging**: All MCP operations are logged with the token identifier
- **No expiration**: Tokens don't expire automatically — rotate them on your own schedule
- **Hash-only storage**: Token values are stored as SHA-256 hashes in the database

## Self-Hosted Configuration

If you're self-hosting PageSpace, point the MCP server at your instance:

\`\`\`json
{
  "env": {
    "PAGESPACE_API_URL": "https://your-pagespace-instance.com",
    "PAGESPACE_AUTH_TOKEN": "mcp_your_token_here"
  }
}
\`\`\`

The MCP server communicates with the PageSpace API over HTTPS. Ensure your instance is accessible from the machine running the MCP server.

## Troubleshooting

**Token not working**: Verify the token hasn't been revoked in Settings > MCP. Tokens are prefixed with \`mcp_\`.

**Connection refused**: Check that \`PAGESPACE_API_URL\` is correct and accessible. For self-hosted instances, ensure HTTPS is configured.

**Permission denied**: MCP tokens inherit your user permissions. If you can't access a drive in the web UI, you can't access it via MCP either.

**Server not starting**: Run \`npx -y pagespace-mcp@latest --help\` to verify the package installs correctly.
`;

export default function MCPPage() {
  return <DocsMarkdown content={content} />;
}
