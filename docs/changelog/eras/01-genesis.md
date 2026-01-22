# Era 1: Genesis

**Dates**: August 21-26, 2025
**Commits**: 1-15
**Theme**: Open Beta Init

## Overview

PageSpace began its current repository with a focused sprint: get an MVP into users' hands. The first commits reveal a system that already had ambitious foundations - MCP (Model Context Protocol) integration, admin authentication, and drive-based organization from day one.

This wasn't starting from scratch. The "Open Beta Init" commit marked the transition from nearly two months of prior development across four repositories (see [00-pre-genesis](./00-pre-genesis.md)). The project had already evolved from "SamePage" under DaisyDebate through several iterations:
- Drive-based architecture was established June 22, 2025
- TipTap editor integration was decided June 24, 2025
- Drizzle ORM migration happened July 13, 2025
- Turborepo structure was adopted August 12, 2025
- MCP protocol integration began August 12, 2025

What's notable is that all these foundational choices were made before commit 1 of this repository. This era represents production deployment, not project inception.

## Architecture Decisions

### MCP Integration from Day One
**Commits**: `809e5e5a`, `0d0411bb`, `a6887983`
**Dates**: 2025-08-21 to 2025-08-24

**The Choice**: Build MCP (Model Context Protocol) support into the core architecture from the start.

**Why**: PageSpace was designed for AI-first workflows. MCP enables external AI tools (like Claude Code) to interact with PageSpace documents, making the system an extension of AI capabilities rather than just a container for content.

**Trade-offs**: Added complexity early. MCP was still evolving, requiring later fixes. But it established PageSpace as an AI-native platform.

### ID-Based Architecture
**Commit**: `7796da6445a64bf3f12a57cefb374c11e2bdd45e`
**Date**: 2025-08-21

**The Choice**: Refactor from slug-based to ID-based resource identification.

**Why**: Slugs are human-readable but problematic for renames, uniqueness, and API consistency. IDs provide stable references that survive content changes.

**Trade-offs**: Less pretty URLs, but more robust API design.

### Real-time from the Start
**Commit**: `26b8fea9a0285c06f7994641c4d0ca93f2aed103`
**Date**: 2025-08-24

**The Choice**: Socket.IO for real-time updates, as a separate service.

**Why**: Collaboration was a core goal. Separating real-time into its own service (apps/realtime) allows independent scaling and deployment.

**Trade-offs**: Additional infrastructure complexity, but cleaner separation of concerns.

## Key Changes

| Commit | Date | Summary |
|--------|------|---------|
| `36a0d18f` | 2025-08-21 | **Open Beta Init** - First public-ready commit |
| `9d63a049` | 2025-08-21 | Admin authentication system |
| `809e5e5a` | 2025-08-21 | MCP configuration setup |
| `b3b5d961` | 2025-08-21 | Tool calling fixes |
| `7796da64` | 2025-08-21 | Slug to ID refactor |
| `bc1c3734` | 2025-08-24 | Drive rename and delete |
| `6b5489e3` | 2025-08-24 | Drive soft delete and restore |
| `0d0411bb` | 2025-08-24 | MCP restoration |
| `8e8ca6bd` | 2025-08-24 | AI tools update |
| `a6887983` | 2025-08-24 | Layout fix, tool file split |
| `26b8fea9` | 2025-08-24 | Real-time fixes |
| `68eeb411` | 2025-08-24 | Sidebar starts closed (UX) |
| `83857d31` | 2025-08-24 | SWR provider setup |
| `18c38910` | 2025-08-26 | Auth refresh issue fix |
| `76b801fe` | 2025-08-26 | Save skipping lines fix |

## Evolution Notes

The commit messages in this era are informal and terse ("fixed tool calling again", "MCP Config Update"). This reflects rapid iteration mode - getting things working rather than documenting for posterity.

Patterns that emerge:
- **Fix-iterate cycles**: Problems surface and get fixed quickly
- **Infrastructure first**: Auth, real-time, MCP before features
- **Drive-centric model**: Organization around drives from the start

The "again" in "fixed tool calling again" hints at the challenges of integrating AI capabilities - this would be a recurring theme throughout development.

## What This Era Established

1. **Monorepo structure** with apps/web, apps/realtime
2. **MCP protocol** as first-class citizen
3. **Drive-based organization** for content
4. **SWR** for client-side data fetching
5. **Real-time infrastructure** for collaboration
6. **JWT authentication** foundation

---

*Previous: [00-pre-genesis](./00-pre-genesis.md) | Next: [02-foundation](./02-foundation.md)*
