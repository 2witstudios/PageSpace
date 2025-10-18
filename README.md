# PageSpace: Where AI Can Actually Work

**Try it free at [www.pagespace.ai](https://www.pagespace.ai)** • Self-host with Docker • [Discord](https://discord.gg/yxDQkTHXT5)

> 🚀 PageSpace turns your projects into intelligent workspaces where AI agents collaborate alongside your team with real tools to create, edit, and organize content.

---

## What Makes PageSpace Different?

In most tools, you chat with AI *about* your work. In PageSpace, AI works *directly in* your workspace:

- **AI with real tools**: Your AI can create documents, organize projects, edit content - not just answer questions
- **External AI integration**: Connect Claude Desktop or Cursor to directly manipulate your workspace via MCP
- **Team + AI collaboration**: Multiple people and AIs working on the same pages simultaneously  
- **100+ AI models**: From free (Qwen, DeepSeek) to premium (Claude 4.1, GPT-5) - you choose
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

### Option 1: Cloud (Instant Access)
1. Visit **[www.pagespace.ai](https://www.pagespace.ai)**
2. Sign up for free
3. Start building with AI immediately

### Option 2: Desktop App (Native Experience)
Download the native desktop app that connects to your cloud instance:

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

**Build from source:**
```bash
git clone https://github.com/2witstudios/PageSpace.git
cd PageSpace
pnpm install
pnpm build:desktop
pnpm package:desktop
```

See [apps/desktop/README.md](apps/desktop/README.md) for detailed instructions.

### Option 3: Self-Host (Full Control)
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

### 🤖 AI Agent Infrastructure
- **33 workspace tools** for AI to manipulate content directly
- **Three AI personalities**: Partner (collaborative), Planner (strategic), Writer (execution-focused)
- **Tool permissions**: Control what each AI can do in your workspace

### 📄 Everything is a Page
- Documents, folders, AI chats, channels - all share the same powerful foundation
- Hierarchical context flows through your workspace
- Real-time collaboration on any page type

### 🔌 Multi-Provider AI Support
- **Built-in models** via PageSpace (no API key needed)
- **Bring your own key**: OpenAI, Anthropic, Google, OpenRouter, xAI
- **100+ models** from free tier to cutting edge

### 🔒 Privacy & Control
- **Cloud option** at www.pagespace.ai for instant access
- **Self-host option** for complete data sovereignty
- **Export anytime**: Your data is always yours

---

## Architecture

PageSpace is a monorepo with a modern, production-ready stack:

```
apps/
├── web/          # Next.js 15 main application
├── realtime/     # Socket.IO server for real-time sync
├── processor/    # File processing service
└── desktop/      # Electron desktop wrapper

packages/
├── db/           # Drizzle ORM + PostgreSQL schema
└── lib/          # Shared utilities and types
```

**Tech Stack**: Next.js 15, PostgreSQL, Socket.IO, Vercel AI SDK, TypeScript, Tailwind CSS, Turbo

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

[Try PageSpace at www.pagespace.ai →](https://www.pagespace.ai)