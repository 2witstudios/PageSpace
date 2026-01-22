# MCP Integration

> Model Context Protocol - External AI tool integration

## The Decision

MCP (Model Context Protocol) was integrated from PageSpace's first commits, making it a first-class citizen rather than an afterthought.

## What is MCP?

MCP is a protocol that enables external AI tools (like Claude Code) to interact with applications. It provides:
- Standardized tool definitions
- Authentication flow
- Document operations
- Bi-directional communication

## Key Architectural Choices

### Day-One Integration

**The Choice**: Build MCP support into the core architecture from commit 1.

**Why**:
- PageSpace is AI-native, not AI-added
- External AI tools can extend PageSpace capabilities
- Enables workflows like "Claude Code updates my PageSpace docs"

**Trade-offs**:
- Added complexity early
- Protocol was evolving (required fixes in later eras)
- Not all users need this capability

### Token-Based Authentication

**The Choice**: MCP tokens for secure external access.

**Why**:
- Scoped permissions per token
- Revocable access
- Audit trail possible
- Works with CLI tools that can't do OAuth

### Document Operations via MCP

**The Choice**: Expose page CRUD through MCP.

**Why**:
- AI tools can read and write PageSpace documents
- Enables automation workflows
- Makes PageSpace part of the AI toolchain

**Operations Exposed**:
- Read pages
- Create pages
- Update content
- Search documents
- *More to be documented from commit analysis*

## Evolution Through Commits

### Era 1: Genesis (Aug 2025)
Early commits show MCP as foundational but requiring iteration:

| Commit | Note |
|--------|------|
| `809e5e5a` | "MCP Config Update" - Initial setup |
| `0d0411bb` | "restore mcp" - Early fix |

### Era 3: AI Awakening (Sep 2025)
Major MCP consolidation and maturity:

| Commit | Date | Note |
|--------|------|------|
| `8bbfbfe75b56` | 2025-09-21 | "MCP Updated and consolidated" - Architecture cleanup |
| `e22abc3031ea` | 2025-09-22 | "fixed ai routes for mcp" - Route reliability |
| `7316d7317ba9` | 2025-09-22 | Follow-up fixes |
| `bf51e05e06b2` | 2025-09-22 | "MCP ask agent works now" - Agent integration |
| `3dcf12d97699` | 2025-09-22 | "MCP fixed without the broken web stuff too" - Stability |

**Key Insight**: The number of MCP-related fixes in Era 3 reveals the challenge of maintaining a protocol integration. External tools depend on stability, requiring more careful iteration than internal features.

### Era 6+
*To be documented as commits are processed:*
- Additional stability fixes
- Tool expansion

## Integration Points

### MCP Token Management

Tokens are managed through the PageSpace UI, stored in the database, and validated on each MCP request.

### External Tool Configuration

External tools (like Claude Code) configure MCP connection:
- Server URL
- Token
- Available tools

---

*Last updated: 2026-01-21 | Version: 2*
