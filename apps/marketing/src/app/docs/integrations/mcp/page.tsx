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
3. Copy the token. It starts with \`mcp_\` and is shown **once** — only a SHA3-256 hash is stored server-side.
4. Optionally scope the token to specific drives, and give it a role. A scoped token joins those drives as an **app** — it appears on each drive's member list, and its access is governed by the role you give it there. Scoped tokens cannot create new drives.

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

- **Drives** — list accessible drives; create new drives (unscoped tokens only).
- **Pages** — list and navigate the page tree, create pages, read page content, perform line operations and sheet cell edits (\`read\`, \`replace\`, \`insert\`, \`delete\`, \`edit-cells\`).
- **Search** — global and multi-drive search.
- **Tasks** — query and manage tasks on \`TASK_LIST\` pages.
- **Calendar** — read availability, schedule events, invite attendees, RSVP, and set agent triggers on calendar events.
- **Slash Commands** — create and manage \`/commands\` that invoke pages as executable skills.
- **Role Management** — drive role CRUD and per-page permission assignment.
- **Agent Triggers** — attach agent runs to calendar events and tasks so agents fire automatically when those events occur.
- **Scheduled Workflows** — cron-based recurring agent automation.
- **Drive Members** — list drive members and connections/collaborators.
- **AI Models** — list available AI providers and models for dynamic model selection.

Every tool respects the caller's permissions. If you cannot view a page in the web UI, the MCP server cannot see it either.

## Use an agent as an OpenAI-compatible model

The same MCP token also unlocks an **OpenAI-compatible API**, so any tool that speaks the OpenAI Chat Completions format can talk to one of your PageSpace agents as if it were a model.

- **Base URL** — \`https://pagespace.ai/api/v1\`
- **API key** — your MCP token (\`mcp_...\`)
- **Model** — \`ps-agent://<pageId>\`, the id of the AI Chat page you want to run. Copy it from the agent's settings tab.

\`\`\`bash
curl https://pagespace.ai/api/v1/chat/completions \\
  -H "Authorization: Bearer mcp_your_token_here" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "ps-agent://<pageId>",
    "stream": true,
    "messages": [{ "role": "user", "content": "Summarize the latest notes in this drive." }]
  }'
\`\`\`

The agent replies with its own system prompt and tools, and runs those tools server-side under the same permissions you'd have in the app — it can search the drive, read pages, and write back, all within the token's scope. Responses are **streamed**, so set \`stream: true\` (non-streaming requests are rejected). Pass an optional \`conversation_id\` to continue a thread across calls, and \`GET /api/v1/models\` lists the agents a token can reach.

## Token security

- **Scoped access** — restrict a token to specific drives at creation.
- **Instant revocation** — revoke from **Settings > MCP** to cut a token off immediately.
- **Audit logging** — token create/revoke/use events land in the audit log with the token identifier.
- **Hash-only storage** — the database stores a SHA3-256 hash, never the raw token. Losing a token means creating a new one.
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
