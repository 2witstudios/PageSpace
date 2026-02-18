import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Desktop MCP Servers",
  description: "Add local MCP servers to PageSpace Desktop. Connect filesystem, GitHub, databases, and other tools to your workspace AI.",
  path: "/docs/mcp/desktop",
  keywords: ["MCP", "desktop", "local servers", "filesystem", "GitHub", "PostgreSQL"],
});

const content = `
# Desktop MCP Servers

PageSpace Desktop can connect to **local MCP servers**, giving your workspace AI access to external tools like the filesystem, GitHub, databases, and more.

## How It Works

Unlike the PageSpace MCP server (which lets external tools connect _to_ PageSpace), desktop MCP servers let PageSpace AI reach _out_ to external systems:

\`\`\`
PageSpace Desktop AI → Local MCP Server → External System
                                            ├── Filesystem
                                            ├── GitHub
                                            ├── PostgreSQL
                                            └── Any MCP server
\`\`\`

MCP servers run locally on your machine and are only accessible to the desktop app. They are not exposed to the web version or other users.

## Setup

1. Open **Settings > Local MCP Servers** in the PageSpace desktop app
2. Add servers using the standard MCP JSON configuration format
3. Servers start automatically when PageSpace Desktop launches

## Configuration Format

The configuration format is identical to Claude Desktop's \`claude_desktop_config.json\`:

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

## Example Servers

### Filesystem

Read and write local files. Useful for AI agents that need to work with local project files.

\`\`\`json
{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/you/projects"]
}
\`\`\`

### GitHub

Interact with GitHub repositories, issues, and pull requests.

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

Query and manage PostgreSQL databases.

\`\`\`json
{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/mydb"]
}
\`\`\`

### Brave Search

Web search through Brave's search API.

\`\`\`json
{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-brave-search"],
  "env": {
    "BRAVE_API_KEY": "your_key_here"
  }
}
\`\`\`

## Trust Model

Desktop MCP servers run with the **desktop app's local privileges**:

- Servers execute on your machine with your user permissions
- Filesystem access is limited to the directories you specify
- Network access depends on the server implementation
- Servers are not accessible from the web version or by other users
- AI tool calls through MCP servers are logged in the conversation history

This is a deliberate security trade-off: desktop MCP servers can do more (access local files, databases, etc.) because they run locally under your control, unlike the web version which is sandboxed to PageSpace's API.

## Desktop-Only

Local MCP servers require the PageSpace Desktop app. The web version cannot run local MCP servers because it runs in a browser sandbox.

If you need external integrations in the web version, use the [PageSpace MCP server](/docs/mcp) approach instead — external AI tools connect to PageSpace via tokens.
`;

export default function DesktopMCPPage() {
  return <DocsMarkdown content={content} />;
}
