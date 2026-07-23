import { DocsMarkdown } from "@/components/DocsContent";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "PageSpace CLI",
  description: "The official pagespace command-line tool — log in, mint scoped keys, manage drives and pages from your shell, and run the pagespace mcp server.",
  path: "/docs/features/cli",
  keywords: ["CLI", "command line", "terminal", "@pagespace/cli", "pagespace mcp", "developers"],
});

const content = `
# PageSpace CLI

\`@pagespace/cli\` puts your workspace in your shell. Read and write pages, run searches, manage tasks, ask agents — as scriptable commands with JSON output. It also ships \`pagespace mcp\`, the MCP server that connects Claude Desktop, Claude Code, and Cursor to PageSpace.

It's built on the [PageSpace SDK](/docs/features/sdk), from the same operation registry, so the CLI, the SDK, and the MCP tool surface always match.

## Install

\`\`\`bash
npm install -g @pagespace/cli
\`\`\`

Or run it without installing:

\`\`\`bash
npx -y -p @pagespace/cli pagespace <command>
\`\`\`

The current version is **1.6.1**. Installing gives you two binaries: \`pagespace\` (the CLI) and \`pagespace-mcp\` (the MCP server).

## Sign in

\`\`\`bash
pagespace login
\`\`\`

This opens a browser, completes an OAuth login, and stores a credential locally. That credential manages keys and nothing else — it has **zero content access of its own**, and \`pagespace mcp\` will refuse to start on it. It exists so you, a human, can mint the scoped keys that actually do the work.

Check who you are at any time with \`pagespace whoami\`.

## Mint a key

Content commands need a drive-scoped key. The guided wizard walks you through it:

\`\`\`bash
pagespace keys
\`\`\`

It lists your existing keys, creates new ones, sets the active key, and revokes old ones. Prefer flags?

\`\`\`bash
# Mint a key scoped to one drive
pagespace keys create --drive <driveId> --role member --name agent

# Activate it — subsequent commands need no flags at all
pagespace keys use agent

# Print the raw mcp_ token once, for another machine or CI
pagespace keys create --drive <driveId> --role member --name ci --show-token

# Unrestricted: every drive you own, including future ones
pagespace keys create --all-drives --name ci --yes
\`\`\`

Minting always opens a browser for a one-time consent screen — it is never something an agent can do silently. \`--show-token\` prints the token exactly once; only a hash is stored server-side. Note that \`--role\` binds to the \`--drive\` immediately before it, so \`--drive a --drive b --role admin\` grants admin on \`b\` only.

Credentials resolve in this order: the \`--token\` / \`--key\` flags, then the \`PAGESPACE_TOKEN\` / \`PAGESPACE_KEY\` environment variables, then your active key. If none are present, the command refuses loudly rather than guessing.

## Core commands

Every content command takes \`--json\` for machine-readable output on stdout (status messages go to stderr, so pipes stay clean), plus \`--host\`, \`--token\`, \`--key\`, and \`--yes\`.

**Drives**

\`\`\`bash
pagespace drives list --json
pagespace drives create "My Drive"
pagespace drives rename <driveId> "New Name"
pagespace drives set-home-page <driveId> <pageId>
pagespace drives trash <driveId> --yes
\`\`\`

**Pages** — the tree, and the content inside it.

\`\`\`bash
pagespace pages list --drive <driveId> --json
pagespace pages tree --drive <driveId>
pagespace pages create "My Doc" DOCUMENT --drive <driveId>
pagespace pages read <pageId>                       # content, with line numbers
pagespace pages read <pageId> --start 5 --end 10    # a line range
pagespace pages replace-lines <pageId> --start 5 --end 10 --file content.txt
pagespace pages move <pageId> <newParentId|root> <position>
pagespace pages export <pageId> --format md --out -
pagespace pages trash <pageId> --yes
\`\`\`

Page types are \`FOLDER\`, \`DOCUMENT\`, \`CHANNEL\`, \`AI_CHAT\`, \`CANVAS\`, \`FILE\`, \`SHEET\`, \`TASK_LIST\`, \`CODE\`, and \`MACHINE\`.

**Search**

\`\`\`bash
pagespace search text "roadmap" --all-drives --json
pagespace search regex "TODO.*urgent" --drive <driveId> --in both --json
pagespace search glob "**/config*" --drive <driveId> --json
\`\`\`

**Tasks**

\`\`\`bash
pagespace tasks list <taskListPageId> --json
pagespace tasks create <taskListPageId> --title "Fix bug" --priority high
pagespace tasks update <taskListPageId> <taskId> --status done
pagespace tasks assigned --json      # your tasks across every drive
\`\`\`

**Agents**

\`\`\`bash
pagespace agents list --all-drives --json
pagespace agents ask <agentPageId> "Summarize this drive"
pagespace agents ask <agentPageId> "Follow up" --conversation-id <convId>
pagespace agents config <agentPageId> --set model=gpt-4o
\`\`\`

Also available: \`pagespace channels send\`, \`pagespace activity\`, \`pagespace trash list\`, \`pagespace sheets edit-cells\`, and \`pagespace models list\`.

Because \`--json\` is clean on stdout, commands compose:

\`\`\`bash
DRIVE_ID=$(pagespace drives list --json | jq -r '.[] | select(.name=="My Drive") | .id')
pagespace pages list --drive $DRIVE_ID --json | jq -r '.[].title'
\`\`\`

Exit codes: \`0\` success, \`1\` API or runtime error, \`2\` usage error.

## MCP server

\`pagespace mcp\` exposes every one of those operations as MCP tools over stdio, for any MCP-compatible client. Point your tool's config at it — by key name, so no secret ever lands in the config file:

\`\`\`json
{
  "mcpServers": {
    "pagespace": {
      "command": "npx",
      "args": ["-y", "-p", "@pagespace/cli", "pagespace-mcp"],
      "env": {
        "PAGESPACE_KEY": "agent"
      }
    }
  }
}
\`\`\`

Globally installed? Use \`"command": "pagespace", "args": ["mcp"]\`. On a headless machine with no keychain, pass a raw token with \`PAGESPACE_TOKEN\` instead.

The MCP server never falls back to your active key — it must be told which credential to use, explicitly, via the environment. See the [MCP Integration guide](/docs/integrations/mcp) for per-tool setup.

## A note on isolation

Minting a key requires a human in a browser. Once minted, a key is just bytes: any process running as the same OS user can read your keychain and your environment. A scoped key limits what the *server* will allow — it does not limit what a same-machine process can do with it.

To genuinely isolate an agent, run it as its own OS user or in its own container, give it exactly one scoped token via \`PAGESPACE_TOKEN\`, and never run \`pagespace login\` as that user.

## Next steps

- **[PageSpace SDK](/docs/features/sdk)** — the typed TypeScript client the CLI is built on
- **[MCP Integration](/docs/integrations/mcp)** — connect Claude Desktop, Claude Code, or Cursor
- **[Sharing & Permissions](/docs/features/sharing)** — what a drive-scoped key can reach
`;

export default function CliPage() {
  return <DocsMarkdown content={content} />;
}
