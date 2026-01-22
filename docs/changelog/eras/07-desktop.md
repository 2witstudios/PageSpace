# Era 7: Desktop

**Dates**: November 16-30, 2025
**Commits**: 476-596
**Theme**: Device Security, Authentication Overhaul, Agent State Management

## Overview

Era 7 represents a security and authentication maturation phase. The device token system evolved from Phase 1 foundation to a comprehensive "Remember Devices" feature with stolen device handling, token revocation, and multi-device support. Meanwhile, agent state management received significant refactoring for reliability.

The commit messages show a methodical security approach: stolen device scenarios, token revocation, expired token handling. This is enterprise-grade authentication work.

## Architecture Decisions

### Complete Device Token System
**Commits**: `771522ad64d3`, `e2eb4ebe67c9`, `80d736907fa1`, `62abfa9e7f94`, `877ff7c5fb64`, `bf08458b510a`, `7c7951477acf`, `ed47c2e9017e`, `a823289b3703`
**Dates**: 2025-11-16 to 2025-11-17

**The Choice**: Implement comprehensive device token management with security edge cases.

**Why**: Real-world device auth has edge cases: stolen devices, expired tokens, concurrent logins.

**Implementation**:
- Token version revocations
- Stolen device scenario handling
- Active device token duplicate prevention
- Expired device token blocking
- Web refresh tokens linked to device tokens
- "Revoke All Other Devices" feature
- "Remember Devices" user-facing feature

**Trade-offs**: Significant complexity, but necessary for enterprise security. Users can now trust that their sessions are secure and revocable.

**PR #52**: Saved devices feature merge.

### Authentication Flow Complete Overhaul
**Commit**: `6db25739e76d`
**Date**: 2025-11-22

**The Choice**: Major authentication flow rewrite.

**Why**: The incremental device token additions needed consolidation into a coherent flow.

**What Changed**: Complete authentication architecture redesign. This is the culmination of Era 6's Phase 1 foundation.

### iOS Session-Free Authentication
**Commit**: `d5e00db66425`
**Date**: 2025-11-23

**The Choice**: Move iOS from session-based to token-based authentication.

**Why**: Consistency with desktop auth model. Sessions don't make sense for native apps.

**Implementation**: iOS now uses the same device token flow as desktop.

### iOS Compacted Tool Calls
**Commits**: `9e61d8505590`, `79f200bdbd26`
**Dates**: 2025-11-24 to 2025-11-25

**The Choice**: Port web's compacted tool calls UI to iOS.

**Why**: Feature parity. iOS users deserve the same clean AI interaction experience.

**Implementation**:
- Compacted tool calls matching web pattern
- Summary text priority aligned with group status icon

**PR #54**: Claude-assisted iOS tool call improvements.

### Agent State Refactoring
**Commits**: `6dc1b118ef27`, `a37439669eb2`, `166d7b45447a`, `e08064434b88`, `37ef06ad2181`
**Dates**: 2025-11-25 to 2025-11-26

**The Choice**: Decouple agent selection from GlobalChatContext with proper state isolation.

**Why**: Race conditions when switching agents. State was leaking between agent sessions.

**What Changed**:
- Local state for agent mode in GlobalAssistantView
- Agent selection decoupled from context
- Race condition prevention in agent switching
- Agent persisted to cookie when restored from URL
- Proper error recovery and deletion handling
- State properly cleared when switching agents

**Trade-offs**: More complex state management, but eliminates bugs.

### System Prompt Admin Viewer
**Commits**: `6aa2f4ad5ed8`, `cd3150e645ea`, `4274a4fe1e8a`
**Dates**: 2025-11-20 to 2025-11-25

**The Choice**: Add admin interface to view and manage system prompts.

**Why**: Debugging AI behavior requires seeing what system prompts agents receive.

**Implementation**:
- System prompt view
- Admin prompt viewer
- Refactored system prompt (removed roles)

### Desktop Auth Routes Fix
**Commit**: `87ea87e7184c`
**Date**: 2025-11-20

**The Choice**: Fix routes using old auth that didn't work for desktop.

**Why**: Desktop uses Bearer tokens, web uses cookies. Routes needed to support both.

**Implementation**: Routes updated to handle bearer vs cookie authentication.

### Custom Drive Roles
**Commits**: `63f58e309863`, `bb2abd326a39`, `cb0a770b27c9`, `1fd899118e1a`, `771555fe1c71`
**Dates**: 2025-11-26 to 2025-11-27

**The Choice**: Implement custom drive roles with permission templates.

**Why**: Admin/member binary isn't enough. Teams need granular permission control.

**Implementation**:
- Custom role definitions per drive
- Permission templates for common patterns
- Drive owners can manage roles
- Role permissions deferred until page tree loads

**PR #57**: Drive settings roles feature.

### Knip Dead Code Detection
**Commits**: `c29cbcc2aac8`, `2a6ce848b55b`, `8d8dcf01d455`, `4feca154905`
**Date**: 2025-11-27

**The Choice**: Add Knip for comprehensive dead code audit.

**Why**: Codebase accumulated technical debt. Dead code obscures understanding.

**What Changed**:
- Knip integrated for dead code detection
- Comprehensive audit performed
- Dead code removed
- Outdated documentation cleaned up

**PR #58**: Claude-assisted Knip setup and audit.

### AI Codebase Semantic Reorganization
**Commits**: `f5e41faffed5`, `458264c5b9e5`, `60ce27bbb768`, `fe20f279d494`, `fa9c68e73243`, `8084b044a009`
**Date**: 2025-11-28

**The Choice**: Major reorganization of AI codebase for semantic clarity.

**Why**: AI code had grown organically. Time to reorganize by domain.

**Implementation Phases**:
- Phase 4: Reorganize stores and hooks
- Phase 5: Reorganize API routes under `/api/ai`
- Phase 6: Add barrel exports for new folders
- Test files moved and updated

**PR #61**: AI codebase reorganization.

### Full Codebase Semantic Reorganization
**Commits**: `005f17a67152`, `d58213aecad0`, `56390ff937eb`, `37a26459cb60`
**Date**: 2025-11-28

**The Choice**: Reorganize `packages/lib` and `apps/web/src/lib` into semantic directories.

**Why**: Consistency. AI reorganization showed the value of semantic structure.

**What Changed**:
- Semantic directory structure across packages
- Package exports updated
- CI updated to include apps/web tests
- Skipped tests fixed

**PR #62, #63**: Codebase semantic reorganization.

### Sidebar Agent Selection
**Commits**: `29578ac50be4`, `7a6e3fce56e7`, `2cc4afb57c5e`, `5ef6593cf476`
**Date**: 2025-11-26

**The Choice**: Add sidebar agent selection with independent state using Zustand.

**Why**: Users need quick agent access from sidebar, not just full views.

**Implementation**:
- Sidebar agent selector
- Zustand store for shared state
- AI usage monitor switched to pageId for agent mode

**PR #56**: Sidebar agent selector.

### Gemini Tool Name Sanitization
**Commit**: `747d20c9d89f`
**Date**: 2025-11-26

**The Choice**: Add Gemini-specific tool name sanitization and new AI models.

**Why**: Gemini has different tool name requirements than other providers.

**Implementation**: Provider-specific sanitization in the AI abstraction layer.

### Drive-Level AI Instructions
**Commit**: `72c4ccb6fe81`
**Date**: 2025-11-28

**The Choice**: Add drive-level AI instructions for agent inheritance.

**Why**: Teams want consistent AI behavior across a drive without configuring each page.

**Implementation**: Instructions set at drive level inherit to all agents in that drive.

### Task List Page Feature
**Commits**: `d6ac771e8d66`, `c919a72c4ebf`, `ef7727a791f6`, `56a6360c2280`, `6a3ba699da40`, `2ef918fb3598`, `243c50b23b4c`, `9f88f75262c9`, `a591d709a6bf`
**Date**: 2025-11-29

**The Choice**: Implement comprehensive task list page type.

**Why**: Tasks need first-class support. Lists in documents aren't structured enough.

**Implementation**:
- Task items with assignee and due date
- Database schema with pageId FK and cascade delete
- Task-page lifecycle management
- AI tool consolidation for task management
- Drag-and-drop ordering
- Real-time updates via Socket.IO

**PR #64**: Task list page feature.

### AI Sheet Cell Editing
**Commits**: `b208a70321b2`, `c25b881d1744`
**Date**: 2025-11-29

**The Choice**: Add `edit_sheet_cells` tool for structured sheet editing.

**Why**: AI needed precise spreadsheet manipulation, not just text insertion.

**Implementation**: Tool with explicit page type output for AI clarity.

**PR #65, #66**: Sheet cells editing.

### Agent Awareness Enhancement
**Commits**: `992c5b7e0498`, `5c5bcef83f48`, `6aba7638107e`, `945b2dffdc55`, `2771384d72f2`, `89b87e9a6dd7`
**Date**: 2025-11-29

**The Choice**: Enhance global assistant with workspace context awareness.

**Why**: AI assistants need to understand the workspace structure to be helpful.

**Implementation**:
- Agent awareness in global assistant system prompt
- Drive name visibility
- 500 char limit on agent definitions
- Per-drive caching for agent awareness
- Page tree context for structure awareness
- IDs in workspace structure for tool usage

### Redis Cache Infrastructure
**Commit**: `948b183d0bc2`
**Date**: 2025-11-29

**The Choice**: Add shared Redis client and improve cache services.

**Why**: Caching was inconsistent. Redis provides shared cache across services.

**Implementation**: Centralized Redis client with improved cache service abstraction.

### iOS Swift 6 Concurrency
**Commit**: `8ebc5262b60c`
**Date**: 2025-11-28

**The Choice**: Resolve Swift 6 strict concurrency errors.

**Why**: Swift 6 has stricter concurrency checking. Code needed updating.

### iOS Claude-Style UI
**Commit**: `b7e95eba9eb4`
**Date**: 2025-11-28

**The Choice**: Claude-style chat UI with larger assistant font.

**Why**: Visual polish. Users appreciate familiar, comfortable AI chat interfaces.

## Key Changes

| Commit | Date | Summary |
|--------|------|---------|
| `f7462ac74258` | 2025-11-16 | **Build errors** - Era 6 cleanup |
| `771522ad64d3` | 2025-11-16 | **Token revocations** - Security layer |
| `7fd38842f085` | 2025-11-17 | **Saved devices UI** - User interface |
| `80d736907fa1` | 2025-11-17 | **Stolen device handling** - Security |
| `62abfa9e7f94` | 2025-11-17 | **Active token duplicate check** - Edge case |
| `877ff7c5fb64` | 2025-11-17 | **Expired token blocking** - Security |
| `ed47c2e9017e` | 2025-11-17 | **Revoke All Other Devices** - Feature |
| `a823289b3703` | 2025-11-17 | **Remember Devices** - User feature |
| `f9318060c252` | 2025-11-18 | **Device list view** - Desktop |
| `d36dced17b9b` | 2025-11-18 | **Multi-desktop support** - Cross-device |
| `87ea87e7184c` | 2025-11-20 | **Bearer vs cookies fix** - Desktop auth |
| `6aa2f4ad5ed8` | 2025-11-20 | **System prompt view** - Admin tool |
| `6db25739e76d` | 2025-11-22 | **Auth flow overhaul** - Complete rewrite |
| `63cbb90245f3` | 2025-11-23 | **PR #52 Saved devices** - Feature merge |
| `d5e00db66425` | 2025-11-23 | **iOS token-based auth** - No sessions |
| `9e61d8505590` | 2025-11-24 | **iOS compacted tool calls** - Feature parity |
| `fa40ddd65ab6` | 2025-11-24 | **PR #54 iOS tool calls** - Claude-assisted |
| `6dc1b118ef27` | 2025-11-26 | **Agent state refactor** - Decouple context |
| `a37439669eb2` | 2025-11-26 | **Agent race conditions** - Prevention |
| `37ef06ad2181` | 2025-11-26 | **Agent state clearing** - Proper cleanup |
| `c2b412107457` | 2025-11-26 | **All agents in root drive** - Discovery |
| `747d20c9d89f` | 2025-11-26 | **Gemini sanitization** - Provider quirks |
| `29578ac50be4` | 2025-11-26 | **Sidebar agent selection** - Quick access |
| `63f58e309863` | 2025-11-26 | **Custom drive roles** - Permissions |
| `c29cbcc2aac8` | 2025-11-27 | **Knip dead code detection** - Audit |
| `2a6ce848b55b` | 2025-11-27 | **Dead code removed** - Cleanup |
| `14ba946da883` | 2025-11-27 | **Shared AI components** - Extraction |
| `dad625b48ec4` | 2025-11-27 | **PR #58 Knip audit** - Claude-assisted |
| `e8b8c8d6ed6f` | 2025-11-27 | **PR #57 Drive roles** - Feature merge |
| `72c4ccb6fe81` | 2025-11-28 | **Drive-level AI instructions** - Inheritance |
| `f5e41faffed5` | 2025-11-28 | **AI codebase reorganization** - Semantic |
| `60ce27bbb768` | 2025-11-28 | **API routes under /api/ai** - Structure |
| `1fdb7a3daff6` | 2025-11-28 | **PR #61 AI reorganization** - Complete |
| `005f17a67152` | 2025-11-28 | **Full semantic reorganization** - Packages |
| `31580e634a23` | 2025-11-28 | **PR #62 Codebase reorganization** - Complete |
| `8ebc5262b60c` | 2025-11-28 | **Swift 6 concurrency** - iOS update |
| `b7e95eba9eb4` | 2025-11-28 | **Claude-style UI** - iOS polish |
| `d6ac771e8d66` | 2025-11-29 | **Task assignee/due date** - Features |
| `c919a72c4ebf` | 2025-11-29 | **AI task tools consolidation** - Cleanup |
| `56a6360c2280` | 2025-11-29 | **Task pageId FK** - Database schema |
| `3d909b319596` | 2025-11-29 | **PR #64 Task list page** - Feature |
| `b208a70321b2` | 2025-11-29 | **edit_sheet_cells tool** - AI sheets |
| `992c5b7e0498` | 2025-11-29 | **Agent awareness prompt** - AI context |
| `948b183d0bc2` | 2025-11-29 | **Shared Redis client** - Cache infra |
| `2771384d72f2` | 2025-11-29 | **Page tree context** - AI awareness |
| `9c86a6b7e226` | 2025-11-30 | **Remove prompt injections** - AI cleanup |

## Evolution Notes

This era shows security becoming a first-class concern:

1. **Device Security Maturity**: From "add device tokens" to "handle stolen devices" shows progression from feature to production-ready security.

2. **Auth Unification**: Web, desktop, and iOS now share a coherent authentication architecture.

3. **Edge Case Coverage**: Expired tokens, duplicate tokens, concurrent logins - all handled explicitly.

4. **Agent Reliability**: Race conditions and state leaks fixed through architectural refactoring.

### Patterns Emerging

- **Security-First Thinking**: Stolen device scenarios considered upfront.
- **Cross-Platform Consistency**: Same auth model across web, desktop, iOS.
- **State Isolation**: Agents properly isolated from global state.
- **Admin Tooling**: System prompt viewer for debugging AI behavior.
- **Claude-Assisted QA**: PR #54 shows Claude helping with feature parity work.
- **Technical Debt Payoff**: Knip audit and semantic reorganization show commitment to maintainability.
- **Granular Permissions**: Custom drive roles show enterprise feature maturity.
- **Inheritance Patterns**: Drive-level AI instructions cascade to children.
- **Structured Data**: Task lists as first-class pages, not just document content.
- **AI Workspace Context**: Agents now understand workspace structure for better assistance.
- **Infrastructure Investment**: Redis caching for cross-service consistency.

---

*Previous: [06-enterprise](./06-enterprise.md) | Next: [08-refinement](./08-refinement.md)*
