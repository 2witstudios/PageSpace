# Era 6: Enterprise

**Dates**: November 1-15, 2025
**Commits**: 350-475
**Theme**: iOS App, Agent Architecture, Legal Compliance

## Overview

Era 6 marks a platform expansion: PageSpace goes mobile with an iOS Swift app scaffold. Simultaneously, the agent architecture received a major overhaul for both Global AI and Page AI. Legal compliance (TOS/Privacy) also became a focus.

The commit messages show a mature development process with conventional commit prefixes emerging: "feat:", "fix:". Claude-assisted development continues with "claude/" branch prefixes.

## Architecture Decisions

### TOS/Privacy Agreement System
**Commits**: `f4b3e3aea619`, `ba882777a2dd`, `a93c7b2e7601`, `c1fe03edb40e`
**Date**: 2025-11-01

**The Choice**: Add Terms of Service and Privacy Policy agreement checkbox to signup.

**Why**: Legal compliance. Users must agree to terms before using the service.

**Implementation**:
- Agreement checkbox on signup
- Notification system integration
- Date tracking for agreement

**PR #28**: TOS/notifications integration (Claude-assisted).

### iOS Mobile App Scaffold
**Commits**: `b9922f8f08f9`, `5d343f29e2b1`, `4afc60574c74`, `de77f9831c83`, `82f01313aa03`, `5f5d45157afb`, `22647b6958a0`, `328b9a8649d8`, `8355cbb2d441`
**Date**: 2025-11-01

**The Choice**: Begin Swift iOS mobile app development.

**Why**: Mobile is essential. Users expect to access their workspace from phones.

**Implementation**:
- Swift iOS scaffold
- Agent-based architecture mirroring web
- Global AI and Page AI navigation
- Security imports
- Message handling and empty response fixes
- Global assistant UI
- Sidebar migration
- Conversation list

**Trade-offs**: Native iOS development is resource-intensive. Could have chosen React Native for code sharing, but native Swift offers better performance and iOS-native feel.

### Agent-Based Architecture Overhaul
**Commits**: `bc8c1fe79c0f`, `5d343f29e2b1`
**Date**: 2025-11-01

**The Choice**: Implement agent-based architecture for both Global AI and Page AI.

**Why**: Cleaner separation of concerns. Global AI operates workspace-wide, Page AI operates on specific pages.

**What Changed**:
- Distinct Global AI and Page AI agents
- NavigationStack fixes for agent navigation
- Architecture mirrored across web and iOS

### iOS Feature Parity Push
**Commits**: `050556e3ee64`, `1c737d643f86`, `22d143a459ee`, `d084d211623e`, `c6b3aa3d6b1c`, `fe97afe987b6`, `aa7595e874d3`, `9703f5b8f730`, `c2ce8b38d63e`
**Dates**: 2025-11-02 to 2025-11-03

**The Choice**: Rapidly build iOS feature parity with web.

**Why**: A scaffold isn't enough. Users need the same functionality on mobile.

**Implementation**:
- Conversation switching and history
- Markdown rendering
- Streaming tool calls with stop indicator
- Model picker
- Socket.IO messaging scaffold
- Messages and thread API integration
- Mobile-specific scaffold adjustments

**Challenges**:
- "streaming fixed?" - Real-time streaming on iOS required iteration
- "fixed the race condition in the conversation switching logic" - Concurrent state management
- "clears convo on agent selection" - UX refinements

### Google OAuth Mobile
**Commit**: `dfecf70165dd`
**Date**: 2025-11-03

**The Choice**: Implement Google OAuth for iOS app.

**Why**: Users expect single sign-on. Web OAuth flow needed mobile adaptation.

**Implementation**: OAuth deep linking for iOS with callback handling.

### iOS File System and Canvas
**Commits**: `eae9308b0104`, `8344636a0d81`, `e3a43d63f5d4`, `acec61947850`, `b8504ab22774`, `14380c0d2338`
**Dates**: 2025-11-03 to 2025-11-04

**The Choice**: Port file system and canvas views to iOS.

**Why**: Files and canvas are core PageSpace features.

**Implementation**:
- File system browser
- Folder view navigation
- Canvas rendering on mobile
- Markdown document rendering
- Image viewing with zoom
- File sharing and downloading

### GLM Web Search Integration
**Commits**: `43d6851a6223`, `a960ea778b2a`, `3c9c9fe4751e`
**Date**: 2025-11-04

**The Choice**: Add web search capability using GLM Web Search API.

**Why**: AI agents need access to current information beyond training data.

**Implementation**:
- GLM Web Search API integration
- OpenAPI spec compliance fixes
- Claude-assisted PR #31 for web search integration

**Trade-offs**: External API dependency for search, but essential for AI utility.

### iOS Polish and Bug Fixes
**Commits**: `e11a936d7de0`, `47de6abe1f4b`, `b9e748a949fc`, `e63fd840ebd9`, `cc8939e5b8a6`, `e2e1358b05ba`, `6d964ea0bbb0`, `03000d1cef22`, `e354d12af031`, `31bcb2aeb519`
**Dates**: 2025-11-03 to 2025-11-05

**The Choice**: Polish iOS app with UX refinements.

**What Changed**:
- Icon improvements
- Color fixes for iOS design language
- Model saving persistence
- Date format standardization
- Keyboard dismissal on sidebar
- Scroll behavior fixes
- Retry and edit functionality on iOS and web

**PR #30**: Major mobile feature merge.

### AI Usage Monitoring System
**Commits**: `2805493940653`, `f5a59c722aa9`, `572876440fb1`, `ab1838abd34e`
**Dates**: 2025-11-06 to 2025-11-08

**The Choice**: Implement real-time AI usage tracking with token counting.

**Why**: Usage transparency and cost management. Users need to understand their AI consumption.

**Implementation**:
- Real-time token tracking
- Usage counter in UI
- Mobile usage display
- Proper context/token counting calculations

**PR #33**: Claude-assisted AI usage monitor implementation.

### Device Token Authentication (Phase 1)
**Commits**: `a24be4b27e86`, `c3d772ff9232`, `a0b0044a9f20`, `af9e78161ced`, `263146a0611f`, `d1828172083c`
**Dates**: 2025-11-14 to 2025-11-15

**The Choice**: Implement device token foundation for persistent authentication.

**Why**: Mobile and desktop apps need to stay logged in between sessions. Simple refresh tokens aren't enough for native apps.

**Implementation**:
- Device token foundation
- Configurable refresh token TTL
- Desktop-specific null handling
- Clear desktop auth on expiry
- Cross-platform token system

**Trade-offs**: Added complexity in auth flow, but necessary for native app UX. Users expect to stay logged in.

**PR #44, #46, #47**: Device token system across platforms.

### Agent Conversation History
**Commit**: `b2743abfc72f`
**Date**: 2025-11-13

**The Choice**: Add persistent conversation support to `ask_agent` tool.

**Why**: Agents need memory. Without conversation history, each interaction starts from scratch.

**Implementation**: Agents now maintain conversation context across tool calls.

**PR #39**: Claude-assisted agent conversation history.

### Tool Call UI Redesign
**Commits**: `563da278a444`, `d818b5352900`, `9eb30372988c`, `3a1433a0b307`, `abb00670ad9d`, `e15044aa475d`
**Dates**: 2025-11-13 to 2025-11-15

**The Choice**: Redesign consecutive tool calls with grouped collapsible pattern.

**Why**: Too many tool calls cluttered the AI chat UI. Users couldn't follow what the AI was doing.

**Implementation**:
- Grouped collapsible tool calls
- Auto-expand behavior fixes
- Tool consolidation to reduce cognitive overhead
- Removed redundant tools during consolidation

**PR #40, #42, #49**: Tool call UI improvements.

### iOS Maintainability Refactor
**Commit**: `0a22b186dc33`
**Date**: 2025-11-07

**The Choice**: Major iOS codebase refactor for maintainability.

**Why**: Rapid feature development created technical debt. Time to clean up.

**What Changed**: Architectural improvements for long-term iOS maintainability.

## Key Changes

| Commit | Date | Summary |
|--------|------|---------|
| `f4b3e3aea619` | 2025-11-01 | **TOS/Privacy checkbox** - Legal compliance |
| `b9922f8f08f9` | 2025-11-01 | **Swift iOS scaffold** - Mobile app begins |
| `bc8c1fe79c0f` | 2025-11-01 | **Agent architecture** - Global AI + Page AI |
| `5d343f29e2b1` | 2025-11-01 | **NavigationStack fix** - iOS navigation |
| `4afc60574c74` | 2025-11-01 | **Message/response fixes** - iOS stability |
| `82f01313aa03` | 2025-11-01 | **Global assistant shows** - iOS UI |
| `5f5d45157afb` | 2025-11-01 | **Working messages** - iOS chat |
| `22647b6958a0` | 2025-11-01 | **Sidebar migration** - iOS layout |
| `c1fe03edb40e` | 2025-11-01 | **TOS/notifications PR** (PR #28) |
| `328b9a8649d8` | 2025-11-01 | **Conversation list** - iOS UI |
| `050556e3ee64` | 2025-11-02 | **Conversation switching** - iOS state |
| `22d143a459ee` | 2025-11-02 | **Streaming tool calls** - Real-time iOS |
| `d7a1db0b285f` | 2025-11-02 | **Race condition fix** - Conversation switching |
| `c6b3aa3d6b1c` | 2025-11-02 | **Model picker** - iOS model selection |
| `c2ce8b38d63e` | 2025-11-02 | **Mobile scaffold** - Structural refactor |
| `dfecf70165dd` | 2025-11-03 | **Google OAuth mobile** - iOS auth |
| `eae9308b0104` | 2025-11-03 | **File system** - iOS file browser |
| `8344636a0d81` | 2025-11-03 | **Canvas works on mobile** - Cross-platform |
| `acec61947850` | 2025-11-03 | **Markdown doc rendering** - iOS documents |
| `b8504ab22774` | 2025-11-04 | **Images working** - iOS media |
| `43d6851a6223` | 2025-11-04 | **Web search capability** - GLM API |
| `1fc677b77b2b` | 2025-11-04 | **File sharing/downloading** - iOS files |
| `9370841ccf77` | 2025-11-04 | **PR #30 Mobile merge** - Feature complete |
| `3c9c9fe4751e` | 2025-11-04 | **PR #31 Web search** - Claude-assisted |
| `31bcb2aeb519` | 2025-11-05 | **Retry on web** - AI iteration |
| `2805493940653` | 2025-11-06 | **AI usage monitor** - Token tracking |
| `0a22b186dc33` | 2025-11-07 | **iOS refactor** - Maintainability |
| `db5441fef157` | 2025-11-07 | **PR #33 AI usage** - Claude-assisted |
| `9f7465a1f720` | 2025-11-07 | **PR #38 Mobile auth** - Token refresh |
| `ab1838abd34e` | 2025-11-08 | **Token counting** - Proper calculations |
| `21694851a588` | 2025-11-09 | **Sidebar finally fixed** - UI polish |
| `b2743abfc72f` | 2025-11-13 | **ask_agent conversation** - Agent memory |
| `563da278a444` | 2025-11-13 | **Tool calls redesign** - Grouped UI |
| `a24be4b27e86` | 2025-11-14 | **Device token Phase 1** - Native auth |
| `c3d772ff9232` | 2025-11-14 | **Configurable TTL** - Refresh tokens |
| `44b283d99ea9` | 2025-11-14 | **PR #42 Tool calls** - UI improvements |
| `abb00670ad9d` | 2025-11-15 | **Tool consolidation** - Reduce overhead |
| `080997a989c1` | 2025-11-15 | **PR #44 Token system** - Cross-platform |
| `c13f2f21a8b2` | 2025-11-15 | **Tool instruction fixes** - Lint parsing |
| `2ac4b513813f` | 2025-11-15 | **PR #48 Tool consolidation** - Claude-assisted |

## Evolution Notes

This era shows platform ambition:

1. **Mobile First (Finally)**: iOS app scaffold shows commitment to mobile. Swift chosen over cross-platform for quality.

2. **Legal Maturity**: TOS/Privacy agreements show the product maturing toward production readiness.

3. **Agent Architecture**: Splitting Global AI and Page AI shows architectural clarity emerging.

4. **Claude-Assisted Development**: PR #28 branch prefix shows Claude helping with development.

### Patterns Emerging

- **Platform Multiplication**: Web → Desktop → iOS. Each platform adds complexity but reach.
- **Legal Infrastructure**: TOS, privacy, notifications - the non-fun but essential stuff.
- **Agent Specialization**: Different agents for different contexts (global vs page).
- **Conventional Commits**: "feat:", "fix:" prefixes becoming common.
- **Rapid Feature Parity**: iOS went from scaffold to feature-complete in days.
- **Web Search Expansion**: AI tools now include real-time web access via GLM API.
- **Claude-Assisted PRs**: PR #31, #33, #39, #40, #42 show continued Claude Code integration for features.
- **Device Authentication**: Native apps require different auth patterns than web.
- **Agent Memory**: Conversation history enables more sophisticated AI interactions.
- **UI Simplification**: Tool call consolidation shows focus on reducing complexity for users.

---

## What Didn't Work

### Planning Documents
**Files Discarded**: Multiple enterprise planning docs

Several planning and backlog documents were created then removed:
- `PR.md` - PR tracking document
- `REFACTORING_BACKLOG.md` - Backlog that became outdated

**Lesson**: Living documents need maintenance. Static planning docs quickly diverge from reality.

## Evidence & Verification

### Candid Developer Messages

| Date | Message |
|------|---------|
| Nov 9 | "sidebar finally fixed" |
| Nov 4 | "Correct GLM Web Search API endpoint" |

### File Evolutions
- [Auth Store Evolution](../evidence/files/apps-web-src-stores-auth-store.ts.md)
- [Permissions Route](../evidence/files/apps-web-src-app-api-pages-_pageid_-permissions-route.ts.md)

### Verification Commands

```bash
# View permission system commits
git log --oneline --since="2025-11-01" --until="2025-11-15" --grep="permission\|access"

# View mobile/iOS work
git log --oneline --since="2025-11-01" --until="2025-11-15" --grep="mobile\|iOS"
```

---

*Previous: [05-polish](./05-polish.md) | Next: [07-desktop](./07-desktop.md)*
