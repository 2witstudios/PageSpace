import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "MCP Integration",
  description: "Connect AI tools like Claude Desktop, Claude Code, and Cursor to PageSpace via the Model Context Protocol. Log in with the pagespace CLI, or use a scoped token for agents and CI.",
  path: "/docs/integrations/mcp",
  keywords: ["MCP", "Model Context Protocol", "AI integration", "Claude", "Cursor", "API tokens", "pagespace CLI"],
});

const content = `
# MCP Integration

PageSpace speaks the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) — an open standard for giving AI tools access to external data and actions. The \`pagespace\` CLI runs \`pagespace mcp\`, a local MCP server that lets tools like Claude Desktop, Claude Code, and Cursor read and write your PageSpace workspace.

\`\`\`
AI tool (MCP client)  →  pagespace mcp (MCP server)  →  PageSpace API
                                                         ↓
                                                    Your workspace
\`\`\`

Every operation runs with the permissions of whoever (or whatever) authenticated — always a scoped credential naming specific drives, never your full personal account: \`pagespace mcp\` refuses to start on nothing but a bare \`pagespace login\`, by design (see below).

## Step 1: Install the CLI and authenticate

\`\`\`bash
npm install -g @pagespace/cli
pagespace login
\`\`\`

(The full command reference lives in the [PageSpace CLI](/docs/features/cli) docs.)

\`pagespace login\` opens a browser, completes an OAuth login, and stores a credential locally — but that credential is scoped to key management only, with **zero content access of its own**. It's for you, personally, to create/list/edit/revoke your own scoped keys; \`pagespace mcp\` won't run on it alone.

Mint the drive-scoped key \`pagespace mcp\` actually needs with the guided wizard:

\`\`\`bash
pagespace keys
\`\`\`

Or, flag-driven (same thing, no interactive wizard prompts — for scripting the *setup* step itself, run once by a human):

\`\`\`bash
pagespace keys create --drive <driveId> --role member --name agent
\`\`\`

Either way opens a browser for a one-time consent screen (minting is always a deliberate, human-approved step, never a silent agent-runnable call) and stores the result locally under the key name you chose. Need a portable \`mcp_...\` token for a *different* machine, CI, or a service account? Add \`--show-token\` to the mint — it prints the token **exactly once** (never again; only a SHA3-256 hash is stored server-side) — or mint one from **Settings > MCP** in the app. Either way, scoping to specific drives joins those drives as an **app** on the member list, governed by the role you give it there; scoped credentials cannot create new drives.

## Step 2: Configure your AI tool

Minted a key with the CLI on *this* machine? Point the config at it by name with \`PAGESPACE_KEY\` — no secret ever appears in the config file:

\`\`\`json
{
  "mcpServers": {
    "pagespace": {
      "command": "pagespace",
      "args": ["mcp"],
      "env": {
        "PAGESPACE_KEY": "agent"
      }
    }
  }
}
\`\`\`

Using a portable token instead (minted from **Settings > MCP**, for a different machine, CI, headless):

\`\`\`json
{
  "mcpServers": {
    "pagespace": {
      "command": "pagespace",
      "args": ["mcp"],
      "env": {
        "PAGESPACE_TOKEN": "mcp_your_token_here"
      }
    }
  }
}
\`\`\`

\`PAGESPACE_API_URL\` overrides the default \`https://pagespace.ai\` host for self-hosted instances.

### Claude Desktop

Edit \`claude_desktop_config.json\`:
- **macOS**: \`~/Library/Application Support/Claude/claude_desktop_config.json\`
- **Windows**: \`%APPDATA%\\\\Claude\\\\claude_desktop_config.json\`

### Claude Code

\`\`\`bash
claude mcp add pagespace -- pagespace mcp
\`\`\`

### Cursor

**Settings > MCP Servers** → add the \`mcpServers\` block above.

## Step 3: Capabilities

\`pagespace mcp\` generates its tool list mechanically from the same operation registry that powers the \`pagespace\` CLI and [\`@pagespace/sdk\`](/docs/features/sdk), so the tool surface can't drift from what the CLI itself supports.

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

Any token also unlocks an **OpenAI-compatible API**, so any tool that speaks the OpenAI Chat Completions format can talk to one of your PageSpace agents as if it were a model.

- **Base URL** — \`https://pagespace.ai/api/v1\`
- **API key** — your token (\`mcp_...\`)
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

- **Scoped access** — restrict a key to specific drives at creation, from the CLI (\`pagespace keys\` or \`pagespace keys create --drive <id>\`) or **Settings > MCP**.
- **Instant revocation** — \`pagespace keys revoke <tokenId>\`, or revoke from **Settings > MCP**, cuts a key off immediately.
- **Audit logging** — token create/revoke/use events land in the audit log with the token identifier.
- **Hash-only storage** — the database stores a SHA3-256 hash, never the raw token. Losing a token means creating a new one.
- **No automatic expiry** — tokens live until revoked. Rotate on whatever cadence fits your risk model.

## Troubleshooting

**Token rejected**: confirm it hasn't been revoked (\`pagespace keys list\` or **Settings > MCP**) and that it starts with \`mcp_\`.

**Connection refused**: check \`PAGESPACE_API_URL\` (or \`--host\`) is correct and reachable from the machine running \`pagespace mcp\`.

**Permission denied**: MCP inherits the caller's permissions. If you lost access to a drive, the key or token stops seeing it too.

**Server fails to start**: \`pagespace mcp\` refuses to start unless the invocation names an explicit credential — \`PAGESPACE_KEY\`/\`--key\` (a key minted by \`pagespace keys\`) or \`PAGESPACE_TOKEN\`/\`--token\` (a portable token). A bare \`pagespace login\` is never enough, and the machine's *active* key (\`pagespace keys use\`) deliberately does not apply to MCP configs — name the credential explicitly so the config is portable and self-describing. Run \`pagespace whoami\` to confirm you're authenticated, and \`pagespace --version\` to confirm the CLI installed correctly.

## Using the older \`pagespace-mcp\` package?

\`pagespace-mcp\` still works — it now prints a one-line deprecation notice to stderr pointing at the migration guide in the [\`@pagespace/cli\` repository](https://github.com/2witstudios/PageSpace/blob/master/packages/cli/docs/migrating-from-pagespace-mcp.md). Move to \`@pagespace/cli\` on your own schedule; the tool surface is unchanged, only how you install and authenticate it is.
`;

export default function MCPPage() {
  return <DocsMarkdown content={content} />;
}
