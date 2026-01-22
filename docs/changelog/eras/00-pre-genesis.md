# Era 00: Pre-Genesis

**Dates**: June 22 - August 18, 2025
**Commits**: 175 commits across 4 repositories
**Theme**: The Birth of SamePage → PageSpace

## Overview

Before PageSpace existed as a single repository, the project evolved through multiple repositories and names. This era documents the early development that laid the foundation for everything that followed.

**Repository Timeline:**
1. `DaisyDebate/samepage` (true origin): June 22-27, 2025 (28 commits)
2. `DaisyDebate/samepage-main`: June 27-30, 2025 (47 commits)
3. `2witstudios/samepage.team`: July 12-14, 2025 (16 commits)
4. `2witstudios/PageSpace.Team-dev`: July 29 - August 18, 2025 (84 commits)

The project started as "SamePage" under the DaisyDebate organization before being renamed to "PageSpace" and moved to 2witstudios.

## Phase 1: The True Origin (daisy-samepage)

**Repository**: `DaisyDebate/samepage`
**Dates**: June 22-27, 2025
**Commits**: 28

### The Very First Commits

| Commit | Date | Summary |
|--------|------|---------|
| `770b1b4e4a9b` | 2025-06-22 | **init** - The very first commit |
| `4e9b267bca89` | 2025-06-22 | **layout** - Initial layout structure |
| `9aaf9670df1d` | 2025-06-22 | **drive implementation** - Core concept established |
| `aa5c1d18d9f7` | 2025-06-23 | **sidebar all the way down** - Navigation pattern |
| `4ec918ea502e` | 2025-06-24 | **tiptap editor start** - Rich text begins |
| `f3ca62f48880` | 2025-06-24 | **fixed slug errors** - URL routing |
| `a859f5381094` | 2025-06-25 | **doc editor finally works** - First working editor |
| `cf8f177e853b` | 2025-06-25 | **Working chat** - Chat feature begins |
| `5c2cc54a0d14` | 2025-06-26 | **fixed nesting** - Page hierarchy |
| `ebe210fba13d` | 2025-06-26 | **security additions** - Auth foundations |
| `0210c73e19cd` | 2025-06-26 | **sharing permissions backend** - Collaboration starts |
| `8cdab998dfe3` | 2025-06-26 | **changing someone to editor works!** - Permissions working |
| `58fb6aff7165` | 2025-06-27 | **repo switch to separate concerns** - Architecture refactor |

### Architecture Decisions

**Drive-Based Architecture**: From the very first day (commit 3), the concept of "drives" as workspaces was established. This fundamental architecture persists to today.

**TipTap Choice**: TipTap was chosen as the rich text editor on June 24, 2025. This decision has remained constant throughout PageSpace's development.

**Permission System**: Sharing and permissions were implemented within the first week. The "editor" role concept appears as early as commit `8cdab998dfe3`.

## Phase 2: Feature Expansion (daisy-main)

**Repository**: `DaisyDebate/samepage-main`
**Dates**: June 27-30, 2025
**Commits**: 47

### Key Developments

| Commit | Date | Summary |
|--------|------|---------|
| `745db4705db2` | 2025-06-27 | **init** - Fresh start for main branch |
| `68efc08e38e8` | 2025-06-27 | **signin/signup pages** - Auth UI |
| `77d580cdab1d` | 2025-06-27 | **landing page** - Public face |
| `f05cc9fb3e55` | 2025-06-28 | **dark mode** - Theme support |
| `62b73f2a0aac` | 2025-06-28 | **Component full refactor** - Architecture improvement |
| `6638ec64a17d` | 2025-06-28 | **Trash implemented with saved hierarchy** - Soft delete |
| `0e2ebbd886d0` | 2025-06-28 | **AI Chatbot refactor/streaming/edit** - AI foundations |
| `7d06f7635ce1` | 2025-06-28 | **mentioning works** - @mentions feature |
| `1857e8e73eb9` | 2025-06-28 | **mentions work in tiptap** - Editor integration |
| `12d0d3b589aa` | 2025-06-29 | **real time as its own server** - Socket.IO separation |
| `b33c939b7a3f` | 2025-06-29 | **fixed socket server** - Real-time stability |
| `e65d03bbc86a` | 2025-06-29 | **folder view and page state consolidation** - Navigation |
| `c46f6271449c` | 2025-06-30 | **drive search** - Search feature |
| `1cbbfecc78ed` | 2025-06-30 | **Mentions in ai chats partially setup** - AI+mentions |

### Architecture Decisions

**Real-time Service Separation**: On June 29, 2025, the decision was made to run Socket.IO as its own server. This architecture persists today in the monorepo structure.

**AI Streaming**: AI with streaming responses was implemented on June 28, 2025 - less than a week after the project started.

**Dark Mode**: Theme support was added June 28, showing early attention to user preferences.

## Phase 3: Drizzle Migration (samepage-team)

**Repository**: `2witstudios/samepage.team`
**Dates**: July 12-14, 2025
**Commits**: 16

### Key Developments

| Commit | Date | Summary |
|--------|------|---------|
| `e9d9f7933e93` | 2025-07-12 | **init** - New organization repo |
| `c26840e665a7` | 2025-07-13 | **drizzle permissions refactor** - ORM migration |
| `48333706faee` | 2025-07-13 | **organized and drizzled** - Schema migration |
| `219b0e33cf23` | 2025-07-13 | **documentation and cleanup overhaul** - Code quality |
| `1debfde9d3f2` | 2025-07-14 | **message/mention renders and scaffold byo model** - BYO models |
| `47739f3207f8` | 2025-07-14 | **api key byo works** - Bring Your Own Key |
| `40fd8cf3be08` | 2025-07-14 | **ai settings and open router** - OpenRouter integration |
| `75b6dc48a7b3` | 2025-07-14 | **prepping deployment** - Production readiness |

### Architecture Decisions

**Drizzle ORM Migration**: The shift from Prisma to Drizzle happened in this phase (July 13). This was a major architectural decision that improved type safety and query flexibility.

**OpenRouter Integration**: OpenRouter was integrated on July 14, establishing the multi-provider AI architecture that would expand significantly.

**Bring Your Own Key**: The BYO API key pattern was implemented, allowing users to use their own AI provider credentials.

## Phase 4: Pre-Launch Development (team-dev)

**Repository**: `2witstudios/PageSpace.Team-dev`
**Dates**: July 29 - August 18, 2025
**Commits**: 84

### Key Developments

| Commit | Date | Summary |
|--------|------|---------|
| `25aa74c112b4` | 2025-07-29 | **init** - PageSpace name appears |
| `912b2e2ee509` | 2025-08-05 | **docker updated, ai sdk v5, zod 4** - Major deps update |
| `fd73019a07e7` | 2025-08-12 | **turbo repo** - Monorepo structure |
| `1206298a6819` | 2025-08-12 | **mcp connects** - MCP protocol begins |
| `e71d1fff9680` | 2025-08-12 | **MCP Settings** - Configuration UI |
| `48f9c0b74dff` | 2025-08-12 | **MCP semantic page tree** - MCP integration |
| `e6f2c4eaa208` | 2025-08-14 | **TOOL CALLING** - AI tools feature |
| `9e8c3b046218` | 2025-08-14 | **All tool calls work** - Tools complete |
| `db1ab544de11` | 2025-08-15 | **dashboard/drive assistants** - AI per drive |
| `1108671b727b` | 2025-08-15 | **realtime fixed** - Socket.IO stability |
| `195a55753c8e` | 2025-08-15 | **Socket fixed** - Final real-time fixes |
| `10042dd3f9dc` | 2025-08-17 | **tools respect permissions** - Security |
| `3265ee442720` | 2025-08-18 | **Other providers** - Multi-provider AI |
| `4979670af21d` | 2025-08-18 | **Auth update** - Authentication changes |
| `40a2a8f1668f` | 2025-08-18 | **non logged in user session spam fix** - Final pre-launch fix |

### Architecture Decisions

**Turborepo Migration**: On August 12, 2025, the project became a monorepo using Turborepo. This structure persists today.

**MCP Protocol**: MCP (Model Context Protocol) integration began August 12, 2025, establishing PageSpace's ability to work with external AI tools like Claude Code.

**AI Tool Calling**: Full tool calling was implemented August 14, 2025, enabling AI to interact with PageSpace (create pages, search, etc.).

**AI SDK v5**: The upgrade to Vercel AI SDK v5 on August 5, 2025 established the streaming-first AI architecture.

## Evolution Summary

### The Name Journey
- **SamePage** (June 2025) → **PageSpace** (July 2025)

### Technology Stack Evolution
- **ORM**: Unknown → Drizzle (July 13)
- **Monorepo**: Single app → Turborepo (August 12)
- **AI SDK**: Earlier version → v5 (August 5)
- **Real-time**: Integrated → Separate service (June 29)

### Feature Timeline
| Feature | First Appeared | Repository |
|---------|---------------|------------|
| Drives | June 22, 2025 | daisy-samepage |
| TipTap Editor | June 24, 2025 | daisy-samepage |
| Permissions | June 26, 2025 | daisy-samepage |
| AI Chat | June 28, 2025 | daisy-main |
| Dark Mode | June 28, 2025 | daisy-main |
| @Mentions | June 28, 2025 | daisy-main |
| Real-time Service | June 29, 2025 | daisy-main |
| Drizzle ORM | July 13, 2025 | samepage-team |
| OpenRouter | July 14, 2025 | samepage-team |
| BYO API Keys | July 14, 2025 | samepage-team |
| Turborepo | August 12, 2025 | team-dev |
| MCP Protocol | August 12, 2025 | team-dev |
| AI Tool Calling | August 14, 2025 | team-dev |

### Patterns Established

- **Drive-Centric Design**: Workspaces (drives) as the organizational unit
- **Real-time First**: Socket.IO for live collaboration from week one
- **AI Native**: AI chat was added within the first week
- **Multi-Provider AI**: OpenRouter established early provider flexibility
- **Permission Model**: Editor/viewer roles from the start

## Commit Messages

The early commit messages are informal and personal:
- "cooleo bro"
- "finally fixed my drive name"
- "tried to fix...."
- "SO CLOSE"
- "All tool calls work"

This contrasts with the conventional commits (`feat:`, `fix:`) that emerge by Era 8-10, showing the evolution from solo hacking to professional development practices.

---

*Next: [01-genesis](./01-genesis.md) (August 21, 2025 - Current repo begins)*
