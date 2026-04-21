import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Desktop MCP Servers",
  description: "Run local MCP servers from PageSpace Desktop — filesystem, GitHub, databases, and any other MCP-compatible tool.",
  path: "/docs/mcp/desktop",
  keywords: ["MCP", "desktop", "local servers", "filesystem", "GitHub", "PostgreSQL"],
});

const content = `
# Desktop MCP Servers

PageSpace Desktop can run **local MCP servers**, giving your workspace AI access to external systems like the filesystem, GitHub, and databases.

This is the inverse of the [PageSpace MCP server](/docs/mcp): that flow lets external tools read your PageSpace; this flow lets PageSpace call out to external tools.

\`\`\`
PageSpace Desktop AI  →  Local MCP server  →  External system
                                               ├── Filesystem
                                               ├── GitHub
                                               ├── PostgreSQL
                                               └── Any MCP server
\`\`\`

Local MCP servers are bound to the desktop app on your machine. They are not exposed to the web version and cannot be triggered by other users.

## Setup

1. Open **Settings > Local MCP Servers** in PageSpace Desktop.
2. Paste a standard MCP \`mcpServers\` configuration (same shape as Claude Desktop's \`claude_desktop_config.json\`).
3. Servers start on launch and shut down with the app.

The desktop app stores the config at \`~/.pagespace/local-mcp-config.json\` (or the platform userData equivalent) and validates every entry before spawning a subprocess.

## Configuration format

\`\`\`json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/directory"],
      "env": {}
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "ghp_your_token_here"
      }
    }
  }
}
\`\`\`

## Example servers

### Filesystem

Read and write local files. Scope the directory you pass.

\`\`\`json
{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/you/projects"]
}
\`\`\`

### GitHub

Repositories, issues, and pull requests.

\`\`\`json
{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "env": {
    "GITHUB_TOKEN": "ghp_your_token_here"
  }
}
\`\`\`

### PostgreSQL

Query and mutate PostgreSQL databases.

\`\`\`json
{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/mydb"]
}
\`\`\`

### Brave Search

Web search via Brave's API.

\`\`\`json
{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-brave-search"],
  "env": {
    "BRAVE_API_KEY": "your_key_here"
  }
}
\`\`\`

## Trust model

Local MCP servers inherit the desktop app's privileges on your machine:

- Processes run as your OS user.
- Filesystem access is limited to the directories you pass each server.
- Network access depends on the server's own implementation.
- Servers are unreachable from the web app or from other users.
- Tool calls and results are logged in the conversation history.

This is a deliberate trade-off: the desktop app can do things the browser sandbox cannot, in exchange for your local authority over what it runs.

## Desktop-only

The web app cannot spawn local MCP servers. If you need to integrate external services from the web, use the [PageSpace MCP server](/docs/mcp) — external AI clients connect to your PageSpace with a token.
`;

export default function DesktopMCPPage() {
  return <DocsMarkdown content={content} />;
}
