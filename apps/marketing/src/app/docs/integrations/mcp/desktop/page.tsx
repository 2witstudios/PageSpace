import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Desktop MCP Servers",
  description: "Run local MCP servers from PageSpace Desktop — filesystem access, documentation lookup, and any other MCP-compatible tool.",
  path: "/docs/integrations/mcp/desktop",
  keywords: ["MCP", "desktop", "local servers", "filesystem", "context7", "npx"],
});

const content = `
# Desktop MCP Servers

PageSpace Desktop can run **local MCP servers**, giving your workspace AI access to external tools — files on your machine, library documentation lookup, web fetch, or anything else in the MCP ecosystem.

This is the inverse of the [PageSpace MCP server](/docs/integrations/mcp): that flow lets external tools read your PageSpace; this flow lets PageSpace call out to external tools.

\`\`\`
PageSpace Desktop AI  →  Local MCP server  →  External tool
                                               ├── Filesystem
                                               ├── Documentation (Context7)
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
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/directory"]
    },
    "context7": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp"]
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

### Context7

Up-to-date library documentation lookup — the agent can pull current docs for the framework or package it's working with instead of guessing from its training data.

\`\`\`json
{
  "command": "npx",
  "args": ["-y", "@upstash/context7-mcp"]
}
\`\`\`

### Anything else

The [MCP ecosystem](https://github.com/modelcontextprotocol/servers) has servers for databases, code hosts, search, email, and more. Any server that speaks MCP and runs as a subprocess can drop into the config above — \`command\` + \`args\` + an optional \`env\` block for credentials. If a server needs an API key or token, it goes in \`env\`.

## Trust model

Local MCP servers inherit the desktop app's privileges on your machine:

- Processes run as your OS user.
- Filesystem access is limited to the directories you pass each server.
- Network access depends on the server's own implementation.
- Servers are unreachable from the web app or from other users.
- Tool calls and results are logged in the conversation history.

This is a deliberate trade-off: the desktop app can do things the browser sandbox cannot, in exchange for your local authority over what it runs.

## Desktop-only

The web app cannot spawn local MCP servers. If you need to integrate external services from the web, use the [PageSpace MCP server](/docs/integrations/mcp) — external AI clients connect to your PageSpace with a token.
`;

export default function DesktopMCPPage() {
  return <DocsMarkdown content={content} />;
}
