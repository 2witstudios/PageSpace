# PageSpace: The AI-Native Workspace for Everything You Do

**[www.pagespace.ai](https://www.pagespace.ai)** • Desktop Apps • [CLI](https://www.npmjs.com/package/@pagespace/cli) & [SDK](https://www.npmjs.com/package/@pagespace/sdk) • [AI Agent Hub](https://pagespace.ai/s/ps_share_oihl5ivoscf0tzx26g0t74degxwi028t)

> PageSpace is one workspace for everything you'd otherwise scatter across a docs tool, a task
> tracker, a calendar, a team chat app, a dev environment, and a website builder. AI agents work
> directly inside all of it: documents, sheets, code, tasks, calendar, team channels, cloud dev
> machines, and published sites all live as pages in the same hierarchy, editable by people and AI
> together in real time, and scriptable from a CLI, an SDK, or any MCP client.

---

## What Makes PageSpace Different?

In most tools, you chat with AI *about* your work, in a window bolted onto the side. In PageSpace,
AI works *directly in* your workspace, and so does everything else you use to get things done:

- **AI with real tools**: Your AI can create documents, run spreadsheet formulas, manage tasks,
  schedule calendar events, and work inside an actual dev environment, not just answer questions
- **One hierarchy, not five apps**: Docs, sheets, code, tasks, calendar, team channels, cloud dev
  machines, and published sites are all pages in the same drive, not separate tools you swivel-chair between
- **Build on it, not just in it**: A CLI, a typed SDK, and an MCP server are generated from one
  shared operation registry, so external AI (Claude Desktop, Cursor, Claude Code) and your own
  scripts get the exact same capabilities the web app has, and can never drift out of sync
- **Publish anything**: Turn any Document, Code, Sheet, or Canvas page into a live public site on
  a free subdomain or your own custom domain
- **Cloud dev machines**: Spin up a sandboxed terminal on a git branch and hand it to a coding
  agent that can read, edit, run, commit, and open a PR without leaving PageSpace
- **100+ AI models**: From free (Qwen, DeepSeek) to premium (Claude Opus 4.5, GPT-5, Gemini 3),
  you choose, or bring your own API key
- **Pay for what you actually use**: AI and cloud-machine usage are metered against real provider
  cost, not a flat per-seat guess
- **Zero-trust direction (cloud)**: OAuth-based auth, opaque tokens, per-event authorization, and
  tamper-evident audit trails

## Preview

![PageSpace Demo](https://github.com/user-attachments/assets/ae068cf3-06fa-4d37-b5f4-b25121598a6f)

---

## See It In Action

### One prompt creates entire projects
```text
You: "Create a complete documentation site for our API"
AI: *Creates 24 nested documents with actual content in your workspace*
```

### Your team collaborates with AI
```text
Team Member A: "Can you analyze our Q3 metrics?"
AI: *Reads relevant documents, creates analysis page*
Team Member B: *Sees the conversation and analysis in real-time*
```

### Script or terminal, same workspace
```bash
$ pagespace tasks create <listId> --title "Ship the Q3 report" --priority high
$ pagespace agents ask <agentId> "Summarize what changed on the roadmap this week"
```

### An agent that can actually ship code
```text
You: "Spin up a machine on feature/pricing-v2 and fix the failing test"
AI: *Opens a real terminal, reproduces the failure, edits the code, commits, opens a PR*
```

### External AI edits your workspace
```bash
# Zero-install MCP — add to Claude Desktop, Claude Code, or Cursor's config
npx -y -p @pagespace/cli pagespace-mcp
```

```text
Claude: "Update all meeting notes in my PageSpace"
*Claude directly edits documents at www.pagespace.ai*
```

---

## Get Started

### Cloud
The fastest way to get started — no setup required:

1. Visit **[www.pagespace.ai](https://www.pagespace.ai)**
2. Sign up for free
3. Start building with AI immediately

Automatic updates, zero maintenance, built-in AI models, team collaboration, and enterprise-grade security controls.

### Desktop Apps
Native desktop apps that connect to your PageSpace cloud workspace.

**macOS** (Signed & Notarized)
- [Download DMG](https://github.com/2witstudios/PageSpace/releases/latest/download/PageSpace.dmg) — Universal (Intel & Apple Silicon)
- [Download ZIP](https://github.com/2witstudios/PageSpace/releases/latest/download/PageSpace.zip) — Universal archive

**Windows** ⚠️ *Unsigned software - security warning expected*
- [Download EXE](https://github.com/2witstudios/PageSpace/releases/latest/download/PageSpace.exe)

**Linux**
- [Download AppImage](https://github.com/2witstudios/PageSpace/releases/latest/download/PageSpace.AppImage) — Universal (no installation)
- [Download DEB](https://github.com/2witstudios/PageSpace/releases/latest/download/PageSpace.deb) — Debian/Ubuntu
- [Download RPM](https://github.com/2witstudios/PageSpace/releases/latest/download/PageSpace.rpm) — Fedora/RHEL

**Mobile**
- **iOS** — Available via [TestFlight](https://www.pagespace.ai/downloads)
- **Android** — In progress

**Features:**
- Native desktop integration with system tray
- Minimize to tray, deep linking support
- Automatic updates (macOS only — signed builds)
- Works with your cloud PageSpace workspace
- **Local MCP server support** (desktop-only): Run MCP servers on your own machine, using the same local trust-boundary model as Claude Desktop (Context7, Figma, Notion, etc.)

---

## Build on PageSpace

A CLI, a typed SDK, and an MCP server, all generated from **one shared operation registry**, so
a CLI verb, an SDK method, and an MCP tool can never drift apart from each other.

### CLI
Script your workspace from a terminal.
```bash
npm install -g @pagespace/cli
pagespace login              # browser OAuth login
pagespace keys                # mint a drive-scoped access key
pagespace keys use <name>     # activate it for this machine
pagespace drives list
pagespace search text "roadmap" --all-drives
```

### SDK
Build your own integrations.
```bash
npm install @pagespace/sdk
```
```ts
import { PageSpaceClient, StaticTokenProvider } from '@pagespace/sdk';

const client = new PageSpaceClient({
  baseUrl: 'https://pagespace.ai',
  auth: new StaticTokenProvider(process.env.PAGESPACE_TOKEN!),
});

const drives = await client.drives.list({});
```

### MCP
Connect Claude Desktop, Claude Code, or Cursor.
```json
{
  "mcpServers": {
    "pagespace": {
      "command": "npx",
      "args": ["-y", "-p", "@pagespace/cli", "pagespace-mcp"],
      "env": { "PAGESPACE_KEY": "agent" }
    }
  }
}
```

Auth is OAuth-based. `pagespace login` identifies *you* but grants no content access on its own;
actual read/write access comes from a separately minted, drive-scoped key, and every grant (the
CLI or an MCP client) is visible and revocable from Settings → Connected Apps. See
[`packages/cli/README.md`](./packages/cli/README.md) and
[`packages/sdk/README.md`](./packages/sdk/README.md) for the full command reference, auth model,
and error handling, or the [PageSpace MCP docs](https://pagespace.ai/docs/integrations/mcp) for
client-by-client setup. (Coming from the standalone `pagespace-mcp` npm package? It's deprecated
in favor of `pagespace mcp`, part of `@pagespace/cli`; see the
[migration guide](./packages/cli/docs/migrating-from-pagespace-mcp.md).)

---

## Core Features

### AI Agent Infrastructure
- **76 workspace tools** for AI to manipulate content directly. The same operation registry
  generates every `pagespace` CLI verb, SDK method, and MCP tool, so none of the three can drift
- **Tool permissions**: Control what each AI can do in your workspace
- **MCP protocol support**: Connect external AI tools like Claude Desktop, Cursor, and Claude Code

### Everything Is a Drive Page
Each item in a drive is a typed page with a specific role:

- **Document**: Rich text editor that also supports markdown editing workflows
- **Code**: Dedicated Monaco code editor, separate from document editing
- **Sheet**: Spreadsheet page with formulas and structured data workflows
- **Canvas**: Custom HTML/CSS canvas page for visual layouts
- **Task List**: Task management page for statuses, assignees, and planning
- **Channel**: Team conversation page for shared messaging in a drive
- **AI Chat**: Tool-enabled AI conversation page with persistent context
- **File**: Uploaded file page for preview, download, and file-to-page linking
- **Folder**: Hierarchical container page for organizing everything else
- **Machine**: Cloud dev sandbox with a terminal, git, and agent execution

- Hierarchical context flows through your workspace
- Real-time collaboration is built into collaborative page types

### Cloud Dev Machines
- **Sandboxed terminals**: Isolated dev environments (Fly Sprites microVMs), one per branch, with
  a working directory, file tree, diff view, and an actual shell
- **Agent-run terminals**: Spawn a named, pluggable coding agent (Claude Code and others) into a
  machine to work it autonomously: read, edit, run, commit, and push
- **Scoped AI access**: Grant a specific AI page-agent access to a specific machine, no more
- **Deep GitHub tooling**: Agents can open/merge PRs, manage issues, search code, inspect commits,
  rerun CI, and recover from conflicted merges/rebases, with or without a full code-execution
  sandbox
- **Metered like everything else**: Machine/terminal time bills through the same credit system as
  AI usage, settled in short heartbeats so a mid-session deploy can't drop your usage

### Publish Anything
- **Publish any page**: Document, Code, Sheet, and Canvas pages can all be published as live public
  sites, not just Canvas
- **Your domain or ours**: Serve from a free `*.pagespace.site` subdomain or connect a custom
  domain with managed TLS
- **SEO controls**: Per-page title, description, OG image, and robots/noindex overrides
- **Site details**: Custom 404 page, drive-wide favicon, and pick an uploaded file as your OG
  image instead of hosting one elsewhere

### Multi-Provider AI Support
- **Built-in models** via PageSpace (no API key needed)
- **Bring your own key**: OpenAI, Anthropic, Google, OpenRouter, xAI, and more
- **100+ models** including Claude Opus 4.5, GPT-5, Gemini 3, Grok 4, and open-source alternatives
- **Local models**: Connect Ollama or LM Studio on the desktop app for local inference

### Unified Messaging & Inbox
- **Unified inbox**: DMs and channels in one view across dashboard and drives
- **Channel collaboration**: Agent mentions (with image-attachment context for vision-capable
  models), read status tracking, unread indicators, and attachments
- **Conversation controls**: Message edit/delete support with richer tool-call rendering

### Tasks & Calendar Workspace
- **Task operations**: Custom status categories, multiple assignees, and mobile-friendly task views
- **Native calendar views**: Month, week, day, and agenda layouts for personal or drive contexts
- **Google Calendar sync**: OAuth connection, two-way sync, push updates, and attendee mapping
- **Calendar AI tools**: Create, update, RSVP, and manage events from natural-language prompts

### Integrations
- **Built-in providers**: GitHub, Slack, Notion, and generic webhooks, plus a native Google
  Calendar sync (see Tasks & Calendar above)
- **Two doors, one workspace**: MCP is how external AI (Claude Desktop, Cursor, Claude Code) comes
  *into* PageSpace; the CLI, SDK, and these integrations are how PageSpace reaches *out*
- **Custom integrations**: Register your own webhook-backed tool providers alongside the built-ins

### Metered AI Billing
- **Pay for what you use**: Every plan includes a monthly credit allowance metered against real AI
  usage, not a flat per-seat price
- **Metered on model cost**: Credits are consumed on actual provider cost, with a live usage
  breakdown by model, feature, and cloud machine
- **Buy more anytime**: Stripe-backed subscriptions, with credit top-ups available on any plan

### Editing Experience
- **Documents**: Built as rich text pages that also support markdown-based authoring
- **Separate editing surfaces**: Code, Sheet, and Canvas each use dedicated editors
- **Upload your own files**: Any uploaded file becomes a first-class FILE page in the drive
- **Export & formatting**: Markdown export/download, improved print output, and editor theme controls

### Voice & Multimodal AI
- **Voice mode**: Speech-to-text + text-to-speech chat workflows
- **Desktop-safe media permissions**: Secure microphone/media handling in Electron
- **Vision input**: Image attachments for multimodal AI conversations

### Security Architecture
PageSpace is built around a zero-trust model for cloud deployment. One explicit exception is desktop-local MCP server hosting, which runs inside the user's local trust boundary (same model as Claude Desktop).

- **OAuth 2.1 authorization server**: `pagespace login` and every scoped access key are minted
  through a real browser consent flow, not handed out as a fixed, unrotatable static token. The
  resulting key is still a bearer secret once issued, so it gets the same handling and revocation
  expectations as any other credential — see Connected Apps below
- **Connected Apps**: See every OAuth grant on your account, including the CLI and any MCP
  client, from Settings, and revoke one instantly. Minting and revoking both require a fresh
  step-up confirmation (passkey, or a confirmation email if you have no passkey)
- **Opaque session tokens**: Server-validated tokens with SHA3-256 hash-only storage — raw tokens never persisted
- **Per-event authorization**: Every sensitive operation re-validates permissions against the database
- **Instant token revocation**: Token versioning enables immediate session invalidation across all devices
- **Device fingerprinting**: Trust scoring detects token theft via IP/User-Agent anomalies
- **Tamper-evident audit trails**: Hash-chained security logs for compliance and forensics
- **Scoped external access**: Access keys enforce drive/page scope with strict auth validation
- **Defense-in-depth**: SameSite cookies + CSRF tokens + origin validation + rate limiting
- **Comprehensive security headers**: CSP with nonces, HSTS, X-Frame-Options, and more

---

## Version History & Recovery

PageSpace provides comprehensive data protection so you never lose work:

### Version History
- **30-day automatic versioning**: Every save creates a recoverable version
- **Pin important versions**: Pinned versions never expire
- **Version comparison**: See exactly what changed between versions
- **One-click restore**: Restore any previous version instantly

### Rollback & Undo
- **Individual activity rollback**: Undo any single change with conflict detection
- **Bulk rollback**: Revert all changes from a specific point forward
- **AI conversation undo**: Undo AI messages and optionally all content changes they made
- **Atomic transactions**: Rollbacks are all-or-nothing for consistency

### Trash & Recovery
- **Soft delete**: Deleted pages and drives go to trash first
- **Restore anytime**: Recover trashed items with full hierarchy intact
- **Recursive restoration**: Restoring a page restores its children too

### Drive Backups
- **Full drive snapshots**: Backup entire drives including pages, permissions, members, and files
- **Manual or scheduled**: Create backups on-demand or automatically
- **Complete state capture**: Restore drives to exact previous states

---

## Data & Privacy

- **Your data stays yours**: Export anytime, no lock-in
- **Encrypted at rest**: All sensitive data encrypted in the database
- **API key security**: Your provider keys are encrypted and never logged
- **Complete audit trail**: Every operation logged with who/what/when for compliance
- **Retention lifecycle controls**: Automated cleanup for sessions, logs, backups, versions, and tokens
- **GDPR support**: Self-service data export and deletion lifecycle tooling

---

## Use Cases

- **Living Documentation**: Docs that update themselves based on project changes
- **Team Knowledge Base**: Where your team's collective intelligence lives and grows
- **Unified Team Comms**: DMs + channels + AI in one inbox workflow
- **Planning & Scheduling**: Tasks and calendars with AI-assisted event operations
- **Project Management**: AI handles routine updates while your team focuses on decisions
- **Agentic Development**: Hand a cloud dev machine to a coding agent and get a PR back
- **Publish From Your Workspace**: Turn internal docs or a Canvas page into a live public site
- **Build Your Own Tools**: Script your workspace with the CLI/SDK, or wire up your own MCP client
- **Creative Workflows**: Brainstorm with AI that can actually implement ideas

---

## Community & Support

- **[AI Agent Hub](https://pagespace.ai/s/ps_share_oihl5ivoscf0tzx26g0t74degxwi028t)** — community hub for AI agents and skills
- **[GitHub Issues](https://github.com/2witstudios/PageSpace/issues)** — bug reports and feature requests

---

## License

PageSpace is proprietary software. Copyright © 2025-2026 Jonathan Woodall, d/b/a 2witstudios. All rights reserved. See [LICENSE](./LICENSE) for full terms.

This repository is public for transparency and issue tracking. The source code is **not** open-source: no license is granted to copy, modify, redistribute, self-host, or otherwise use the code without the prior written permission of the copyright holder. External contributions are not currently accepted.

Third-party open-source components retained in the dependency tree remain under their own licenses; see the [`LICENSES/`](./LICENSES/) directory for the full texts of those where attribution is required.

---

**Built by people who believe AI should work with you: in your documents, your tasks, your calendar, your codebase, and your published sites, not just in a chat window beside them.**

[Get started at www.pagespace.ai →](https://www.pagespace.ai)
