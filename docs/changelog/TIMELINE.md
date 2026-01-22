# PageSpace Development Timeline

> Visual journey through 7 months of development (including pre-genesis)

## 2025

```
June 2025 (Pre-Genesis)
=======================
22 ----[TRUE ORIGIN]----> 27 ----[EXPANSION]--------------> 30
     |                         |                             |
     v                         v                             v
     DaisyDebate/samepage      samepage-main              ~75 commits
     First "init" commit       Dark mode, AI chat        Permissions
     Drive architecture        Real-time separation       @mentions

July 2025 (Pre-Genesis)
=======================
12 ----[DRIZZLE]----> 14          29 ----[TEAM-DEV]-------> 31
     |                 |               |                      |
     v                 v               v                      v
     2witstudios/      OpenRouter      PageSpace name        MCP begins
     samepage.team     BYO API keys    Turborepo setup       AI SDK v5
     Drizzle ORM       ~16 commits     Monorepo starts       AI tools

August 2025 (Pre-Genesis → Genesis)
===================================
01 ----[PRE-LAUNCH]----> 18     21 ----[GENESIS]---------> 31
     |                    |          |                      |
     v                    v          v                      v
     team-dev repo        MCP tools  Current repo begins    ~15 commits
     ~84 commits          Security   "Open Beta Init"       Auth setup
     AI tool calling      Socket.IO  Production ready       Early drives

September 2025
==============
01 ---[FOUNDATION]---> 15 ---[AI AWAKENING]----------------> 30
     |                      |                                 |
     v                      v                                 v
     Core features         AI-to-AI comms                ~172 commits
     Task system           Agent system                  PDF processing
     File uploads          MCP integration               Multi-model AI

October 2025
============
01 ---[COLLABORATION]--> 15 ---[POLISH]--------------------> 31
     |                       |                               |
     v                       v                               v
     Real-time sync         Stripe billing              ~349 commits
     Canvas dashboard       Rate limiting               Storage system
     DM system              UX refinements              Performance

November 2025
=============
01 ---[ENTERPRISE]----> 15 ---[DESKTOP]--------------------> 30
     |                       |                               |
     v                       v                               v
     Permissions RBAC       Electron app                ~596 commits
     Security hardening     Desktop auth                Peak velocity
     MCP stability          Cross-platform              247 commits/mo

December 2025
=============
01 ---[REFINEMENT]----> 15 ---[MATURITY]------------------> 31
     |                       |                               |
     v                       v                               v
     Bug fixes              Testing infra               ~888 commits
     Stability              CI/CD pipeline              Conventional
     Edge cases             Coverage goals              commits adopted
```

## 2026

```
January 2026
============
01 ----------------------[TODAY]--------------------------> 21
                            |                               |
                            v                               v
                        Latest features              974 commits
                        Notifications                   CURRENT
                        AI enhancements                  STATE
```

## Major Milestones

### Architecture Decisions

| Date | Decision | Impact |
|------|----------|--------|
| Jun 22 | Drive-based architecture | Workspaces as organizational unit from day one |
| Jun 24 | TipTap editor choice | Rich text foundation that persists today |
| Jun 26 | Permission system | Editor/viewer roles established early |
| Jun 28 | AI chat with streaming | AI-native from week one |
| Jun 29 | Socket.IO separation | Real-time as dedicated service |
| Jul 13 | Drizzle ORM migration | Type-safe database access |
| Jul 14 | OpenRouter integration | Multi-provider AI flexibility begins |
| Aug 5 | AI SDK v5 upgrade | Streaming-first AI architecture |
| Aug 12 | Turborepo migration | Monorepo structure established |
| Aug 12 | MCP protocol integration | External AI tools support |
| Aug 14 | AI tool calling | AI interacts with PageSpace |
| Aug 21 | Current repo begins | "Open Beta Init" - production launch |
| Sep ~15 | Provider factory pattern | Multi-model abstraction |
| Oct ~1 | Canvas with Shadow DOM | Secure custom HTML dashboards |
| Nov ~16 | Electron desktop app | Cross-platform native experience |
| Dec ~15 | Conventional commits | Structured commit history |
| Jan ~8 | P1 Security (JTI, rate limiting) | Production security hardening |

### Version Tags

| Tag | Date | Significance |
|-----|------|--------------|
| v1.0.0 | TBD | Main app stable release |
| desktop-v1.0.0 | Nov 2025 | Desktop app initial release |
| desktop-v1.0.1+ | Dec 2025 | Desktop iteration |

### Commit Velocity

```
Commits per Month (including pre-genesis):

 300 |                                        ****
     |                                   ****
 250 |                              ****
     |                         ****
 200 |                    ****
     |               ****
 150 |          ****
     |     ****
 100 |****
     |****
  50 |
     |
   0 +--------------------------------------------
     Jun  Jul  Aug  Sep  Oct  Nov  Dec  Jan

     |-Pre-Genesis-|          |---Main Repo---|
```

## Reading the Eras

Each era document follows this structure:

1. **Overview**: What was the focus during this period?
2. **Architecture Decisions**: Why were things built this way?
3. **Key Changes**: Significant commits with context
4. **Evolution Notes**: How understanding changed

Start with the era that interests you, or read chronologically to understand how PageSpace evolved.

---

*Timeline includes pre-genesis history from 4 repositories: DaisyDebate/samepage, DaisyDebate/samepage-main, 2witstudios/samepage.team, and 2witstudios/PageSpace.Team-dev*

*Last updated: 2026-01-22*
