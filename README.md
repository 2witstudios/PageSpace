# PageSpace: Where AI Can Actually Work

**[www.pagespace.ai](https://www.pagespace.ai)** • Desktop Apps • [Discord](https://discord.gg/yxDQkTHXT5)

> PageSpace turns your projects into intelligent workspaces where AI agents collaborate alongside your team with real tools to create, edit, and organize content.

---

## What Makes PageSpace Different?

In most tools, you chat with AI *about* your work. In PageSpace, AI works *directly in* your workspace:

- **AI with real tools**: Your AI can create documents, organize projects, edit content - not just answer questions
- **External AI integration**: Connect Claude Desktop or Cursor to directly manipulate your workspace via MCP
- **Team + AI collaboration**: Multiple people and AIs working on the same pages simultaneously
- **100+ AI models**: From free (Qwen, DeepSeek) to premium (Claude Opus 4.5, GPT-5, Gemini 3) - you choose
- **Zero-trust direction (cloud)**: Opaque tokens, per-event authorization, and tamper-evident audit trails
- **Your workspace understands context**: AI intelligence flows through your project hierarchy

## Preview

![PageSpace Demo](https://github.com/user-attachments/assets/ae068cf3-06fa-4d37-b5f4-b25121598a6f)

---

## See It In Action

### One prompt creates entire projects
```
You: "Create a complete documentation site for our API"
AI: *Creates 24 nested documents with actual content in your workspace*
```

### Your team collaborates with AI
```
Team Member A: "Can you analyze our Q3 metrics?"
AI: *Reads relevant documents, creates analysis page*
Team Member B: *Sees the conversation and analysis in real-time*
```

### External AI edits your workspace
```bash
# Install MCP server
npm install -g pagespace-mcp@latest

# In Claude Desktop
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

## Connect External AI (Claude, Cursor)

PageSpace includes an MCP server that lets Claude Desktop and other AI tools directly manipulate your workspace:

### Quick Setup
1. **Install the MCP server**
   ```bash
   npm install -g pagespace-mcp@latest
   ```

2. **Get your token** from [www.pagespace.ai/dashboard/settings/mcp](https://www.pagespace.ai/dashboard/settings/mcp)

3. **Configure Claude Desktop** (add to MCP settings):
   ```json
   {
     "mcpServers": {
       "pagespace": {
         "command": "npx",
         "args": ["-y", "pagespace-mcp@latest"],
         "env": {
           "PAGESPACE_API_URL": "https://www.pagespace.ai",
           "PAGESPACE_AUTH_TOKEN": "your-mcp-token"
         }
       }
     }
   }
   ```

4. **Claude can now work in your PageSpace!**
   - "Show me my drives and pages"
   - "Create a new project structure"
   - "Edit line 42 in the requirements document"

[Full MCP documentation →](https://www.npmjs.com/package/pagespace-mcp)

---

## Core Features

### AI Agent Infrastructure
- **37 workspace tools** for AI to manipulate content directly
- **Tool permissions**: Control what each AI can do in your workspace
- **MCP protocol support**: Connect external AI tools like Claude Desktop and Cursor

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

- Hierarchical context flows through your workspace
- Real-time collaboration is built into collaborative page types

### Multi-Provider AI Support
- **Built-in models** via PageSpace (no API key needed)
- **Bring your own key**: OpenAI, Anthropic, Google, OpenRouter, xAI, and more
- **100+ models** including Claude Opus 4.5, GPT-5, Gemini 3, Grok 4, and open-source alternatives
- **Local models**: Connect Ollama or LM Studio on the desktop app for local inference

### Unified Messaging & Inbox
- **Unified inbox**: DMs and channels in one view across dashboard and drives
- **Channel collaboration**: Agent mentions, read status tracking, unread indicators, and attachments
- **Conversation controls**: Message edit/delete support with richer tool-call rendering

### Tasks & Calendar Workspace
- **Task operations**: Custom status categories, multiple assignees, and mobile-friendly task views
- **Native calendar views**: Month, week, day, and agenda layouts for personal or drive contexts
- **Google Calendar sync**: OAuth connection, two-way sync, push updates, and attendee mapping
- **Calendar AI tools**: Create, update, RSVP, and manage events from natural-language prompts

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

- **Opaque session tokens**: Server-validated tokens with SHA3-256 hash-only storage — raw tokens never persisted
- **Per-event authorization**: Every sensitive operation re-validates permissions against the database
- **Instant token revocation**: Token versioning enables immediate session invalidation across all devices
- **Device fingerprinting**: Trust scoring detects token theft via IP/User-Agent anomalies
- **Tamper-evident audit trails**: Hash-chained security logs for compliance and forensics
- **Scoped external access**: MCP tokens enforce drive/page scope with strict auth validation
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
- **Creative Workflows**: Brainstorm with AI that can actually implement ideas

---

## Community & Support

- **[Discord](https://discord.gg/yxDQkTHXT5)** — community support and discussion
- **[GitHub Issues](https://github.com/2witstudios/PageSpace/issues)** — bug reports and feature requests

---

## License

PageSpace is proprietary software. Copyright © 2025-2026 Jonathan Woodall, d/b/a 2witstudios. All rights reserved. See [LICENSE](./LICENSE) for full terms.

This repository is public for transparency and issue tracking. The source code is **not** open-source: no license is granted to copy, modify, redistribute, self-host, or otherwise use the code without the prior written permission of the copyright holder. External contributions are not currently accepted.

Third-party open-source components retained in the dependency tree remain under their own licenses; see the [`LICENSES/`](./LICENSES/) directory for the full texts of those where attribution is required.

---

**Built by people who believe AI should work with you, not just talk to you.**

[Get started at www.pagespace.ai →](https://www.pagespace.ai)
