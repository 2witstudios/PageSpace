# PageSpace: Where AI Can Actually Work

**[www.pagespace.ai](https://www.pagespace.ai)** • Desktop Apps • Self-Host • [Discord](https://discord.gg/yxDQkTHXT5)

> PageSpace turns your projects into intelligent workspaces where AI agents collaborate alongside your team with real tools to create, edit, and organize content.

---

## What Makes PageSpace Different?

In most tools, you chat with AI *about* your work. In PageSpace, AI works *directly in* your workspace:

- **AI with real tools**: Your AI can create documents, organize projects, edit content - not just answer questions
- **External AI integration**: Connect Claude Desktop or Cursor to directly manipulate your workspace via MCP
- **Team + AI collaboration**: Multiple people and AIs working on the same pages simultaneously
- **100+ AI models**: From free (Qwen, DeepSeek) to premium (Claude Opus 4.5, GPT-5, Gemini 3) - you choose
- **Zero-trust security**: Enterprise-grade security with opaque tokens, per-event authorization, and tamper-evident audit trails
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

## Quick Start

### Cloud (Recommended)
The fastest way to get started - no setup required:
1. Visit **[www.pagespace.ai](https://www.pagespace.ai)**
2. Sign up for free
3. Start building with AI immediately

**Cloud features**: Automatic updates, zero maintenance, built-in AI models, team collaboration, and enterprise security out of the box.

### Desktop Apps
Native desktop apps that connect to your PageSpace cloud instance:

**macOS** (Signed & Notarized)
- [Download DMG](https://github.com/2witstudios/PageSpace/releases/latest/download/PageSpace.dmg) - Universal (Intel & Apple Silicon)
- [Download ZIP](https://github.com/2witstudios/PageSpace/releases/latest/download/PageSpace.zip) - Universal archive

**Windows** ⚠️ *Unsigned software - security warning expected*
- [Download Installer](https://github.com/2witstudios/PageSpace/releases/latest/download/PageSpace.exe) - NSIS installer with wizard
- [Download Portable](https://github.com/2witstudios/PageSpace/releases/latest/download/PageSpace.exe) - Portable executable

**Linux**
- [Download AppImage](https://github.com/2witstudios/PageSpace/releases/latest/download/PageSpace.AppImage) - Universal (no installation)
- [Download DEB](https://github.com/2witstudios/PageSpace/releases/latest/download/PageSpace.deb) - Debian/Ubuntu
- [Download RPM](https://github.com/2witstudios/PageSpace/releases/latest/download/PageSpace.rpm) - Fedora/RHEL

**Features:**
- Native desktop integration with system tray
- Minimize to tray, deep linking support
- Automatic updates (macOS only - signed builds)
- Works with your cloud PageSpace instance
- **Local MCP server support** (desktop-only) - Run MCP servers locally on your computer like Claude Desktop (Context7, Figma, Notion, etc.)

**Build from source:**
```bash
git clone https://github.com/2witstudios/PageSpace.git
cd PageSpace
pnpm install
pnpm build:desktop
pnpm package:desktop
```

See [apps/desktop/README.md](apps/desktop/README.md) for detailed instructions.

### Self-Host (Advanced)
For complete data sovereignty and custom deployments:
```bash
# Clone and setup
git clone https://github.com/2witstudios/PageSpace.git
cd PageSpace
pnpm install

# Configure environment
cp .env.example .env
cp apps/web/.env.example apps/web/.env
# Add your ENCRYPTION_KEY to .env (use: openssl rand -base64 32)

# Launch database
docker-compose up -d

# Run database migrations
pnpm db:generate
pnpm db:migrate

# Start development server
pnpm dev

# Visit http://localhost:3000
```

**When to self-host**: Air-gapped environments, compliance requirements, or when you need to run local AI models exclusively.

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
- **33 workspace tools** for AI to manipulate content directly
- **Three AI personalities**: Partner (collaborative), Planner (strategic), Writer (execution-focused)
- **Tool permissions**: Control what each AI can do in your workspace
- **MCP protocol support**: Connect external AI tools like Claude Desktop and Cursor

### Everything is a Page
- Documents, folders, AI chats, channels - all share the same powerful foundation
- Hierarchical context flows through your workspace
- Real-time collaboration on any page type

### Multi-Provider AI Support
- **Built-in models** via PageSpace (no API key needed)
- **Bring your own key**: OpenAI, Anthropic, Google, OpenRouter, xAI, and more
- **100+ models** including Claude Opus 4.5, GPT-5, Gemini 3, Grok 4, and open-source alternatives
- **Local models**: Connect Ollama or LM Studio for air-gapped deployments

### Zero-Trust Security Architecture
PageSpace implements enterprise-grade security designed for cloud-first deployment:

- **Opaque session tokens**: Server-validated tokens with SHA-256 hash-only storage - raw tokens never persisted
- **Per-event authorization**: Every sensitive operation re-validates permissions against the database
- **Instant token revocation**: Token versioning enables immediate session invalidation across all devices
- **Device fingerprinting**: Trust scoring detects token theft via IP/User-Agent anomalies
- **Tamper-evident audit trails**: Hash-chained security logs for compliance and forensics
- **Defense-in-depth**: SameSite cookies + CSRF tokens + origin validation + rate limiting
- **Comprehensive security headers**: CSP with nonces, HSTS, X-Frame-Options, and more

[Security architecture details →](./docs/3.0-guides-and-tools/cloud-security-analysis.md)

---

## Architecture

PageSpace is a cloud-native monorepo designed for scalability and security:

```
apps/
├── web/          # Next.js 15 App Router (main application)
├── realtime/     # Socket.IO server (real-time collaboration)
├── processor/    # File processing service (uploads, optimization)
├── desktop/      # Electron desktop wrapper
└── mobile/       # Capacitor mobile apps (iOS/Android)

packages/
├── db/           # Drizzle ORM + PostgreSQL schema
└── lib/          # Shared auth, permissions, utilities
```

### Tech Stack
- **Frontend**: Next.js 15, React 19, TypeScript, Tailwind CSS 4, shadcn/ui
- **Backend**: Next.js API routes, PostgreSQL, Drizzle ORM, Redis
- **AI**: Vercel AI SDK, 10+ provider integrations
- **Real-time**: Socket.IO with Redis pub/sub for horizontal scaling
- **Auth**: Opaque session tokens, OAuth (Google, Apple), MCP tokens
- **Build**: pnpm workspaces, Turbo, Docker

### Cloud Infrastructure
- **Database**: Any PostgreSQL (Neon, Supabase, RDS, or self-hosted)
- **Cache**: Redis for sessions, rate limiting, and distributed state
- **Storage**: Content-addressed file storage with optimization pipeline
- **Deployment**: Docker containers, CI/CD via GitHub Actions

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
- **Self-host option**: Run entirely on your infrastructure for complete sovereignty

---

## Use Cases

- **Living Documentation**: Docs that update themselves based on project changes
- **Team Knowledge Base**: Where your team's collective intelligence lives and grows
- **Project Management**: AI handles routine updates while your team focuses on decisions
- **Creative Workflows**: Brainstorm with AI that can actually implement ideas

---

## Community & Support

- **[Discord](https://discord.gg/yxDQkTHXT5)**: Join our community for support and discussions
- **[Documentation](./docs/1.0-overview/1.1-table-of-contents.md)**: Deep dive into architecture and guides
- **[GitHub Issues](https://github.com/2witstudios/PageSpace/issues)**: Report bugs and request features

---

## Contributing

We welcome contributions! See our [Contributing Guide](./CONTRIBUTING.md) for details.

PageSpace is built in public. Our roadmap, documentation, and development all happen in the open.

---

## License

CC BY-NC-SA 4.0 (Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International) - see [LICENSE](./LICENSE) for details.

This means you can use, modify, and share PageSpace for non-commercial purposes.

---

**Built by people who believe AI should work with you, not just talk to you.**

[Get started at www.pagespace.ai →](https://www.pagespace.ai)