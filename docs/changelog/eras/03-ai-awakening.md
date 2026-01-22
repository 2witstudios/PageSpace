# Era 3: AI Awakening

**Dates**: September 19-30, 2025
**Commits**: 81-172
**Theme**: AI Provider Diversity, MCP Maturity, Spreadsheets

## Overview

With core features established in Era 2, Era 3 focused on deepening AI capabilities and preparing for production. This era saw Ollama support for local models, significant MCP improvements, the introduction of GLM (a new model provider), and the beginning of spreadsheet functionality.

The commit messages show a shift toward production concerns: "security checks", "security and performance fixes", "Improve structured logging". The system was transitioning from "does it work?" to "is it ready for users?"

## Architecture Decisions

### Ollama Integration (Local Models)
**Commits**: `a8aac666ec58`, `a8fc9713d1c8`
**Date**: 2025-09-19

**The Choice**: Add Ollama support for running AI models locally.

**Why**:
- Privacy-sensitive users need on-premise options
- Development without API costs
- Experimentation with open-source models
- No internet dependency for AI features

**Trade-offs**: Local models are slower and less capable than cloud models, but offer control and privacy.

### MCP Consolidation and Fixes
**Commits**: `8bbfbfe75b56`, `e22abc3031ea`, `7316d7317ba9`, `bf51e05e06b2`, `3dcf12d97699`
**Dates**: 2025-09-21 to 2025-09-22

**The Choice**: Major MCP overhaul - consolidation, route fixes, and agent integration.

**Why**: MCP was foundational from Era 1, but needed maturity. External AI tools (Claude Code, etc.) needed reliable integration.

**What Changed**:
- "MCP Updated and consolidated" - Cleaner architecture
- "fixed ai routes for mcp" - Route reliability
- "MCP ask agent works now" - Agent integration
- "MCP fixed without the broken web stuff too" - Stability improvements

**Trade-offs**: Required breaking changes to MCP clients, but resulted in more stable integration.

### GLM Model Support
**Commits**: `5eca94599bd5`, `6c705e9ef8b5`
**Date**: 2025-09-22

**The Choice**: Add GLM (likely Zhipu AI's ChatGLM) as a model provider, set as default.

**Why**: Model diversity. Different providers excel at different tasks and price points. GLM offered competitive capabilities.

**Note**: Setting a new model as default indicates confidence in its quality/cost ratio.

### Security and Logging Infrastructure
**Commits**: `b54ee02c2312`, `5ca90e69fa4c`, `7ed53555238b`, `be30092f7a76`
**Date**: 2025-09-23

**The Choice**: Production-grade security checks and structured logging.

**Why**: Moving toward production requires:
- Security auditing capabilities
- Performance monitoring
- Usage tracking for billing
- Debugging in production

**What Was Built**:
- Security check framework
- Monitoring dashboard integration
- Structured logging across usage flows
- Performance optimizations for realtime and DB

### Permissions Caching
**Commit**: `a420237d6a36`
**Date**: 2025-09-23

**The Choice**: Cache permission checks.

**Why**: Permission checks happen on every request. Database lookups for every check don't scale. Caching provides acceptable latency.

**Trade-offs**: Cache invalidation complexity. Stale permissions possible for brief windows.

### Spreadsheet Document Type
**Commits**: `50335c530f5d`, `2933d2f1f9a2`, `ebfac4f0088e`, `962602c66cb4`, `9fbe712ebe04`, `42aa65dfd897`, `a2d9708b9025`
**Dates**: 2025-09-24

**The Choice**: Add spreadsheet as a native document type with SheetDoc format.

**Why**: Workspaces need structured data, not just documents. Spreadsheets enable:
- Data tables
- Simple calculations
- Structured information storage

**Implementation**:
- Custom SheetDoc format
- Cell selection and editing
- Cross-sheet references
- Copy/paste with formulas
- AI-usability enhancements (PR #8)

### Mobile Responsiveness Overhaul
**Commits**: `41c57ee265d9`, `4f84fb67a2fc`, `ff955d900a9d`, `1123ccce69af`, `87ae69dc0f55`, `182d1aec6088`
**Dates**: 2025-09-24 to 2025-09-25

**The Choice**: Major responsive layout refactor for mobile/tablet support.

**Why**: PageSpace needed to work on phones and tablets, not just desktop.

**What Changed**:
- Responsive layout across web app
- Mobile sheets for navigation/assistant panels
- Sidebar height fixes
- Overlay panel collision prevention
- Settings pages under shared layout

**Trade-offs**: Additional complexity in layout components, but necessary for modern web expectations.

### Security Hardening Sprint
**Commits**: `d2e9f65fe222`, `b36442f3a445`, `8c2b9d6066b2`, `1bb7ec90a6a1`, `cc89deab66e0`, `1c9f2d5ad4ff`, `42c2676958cb`
**Dates**: 2025-09-25 to 2025-09-26

**The Choice**: Comprehensive security audit and fixes.

**Why**: Moving toward production required addressing authorization gaps.

**What Was Fixed**:
- JWT authentication bypass issue (PR #13)
- Drive membership checks in permissions
- File authorization issues (PR #14)
- Processor content hash access control
- Tenant token implementation

**Critical Insight**: Multiple security PRs in rapid succession indicate either a dedicated security audit or discovery of related vulnerabilities. Good sign of security-conscious development.

### Processor Service Authentication
**Commits**: `1c9f2d5ad4ff`, `4797e9c972c0`, `5372494d9ddc`, `94859afa59cb`
**Dates**: 2025-09-26 to 2025-09-29

**The Choice**: Secure processor service endpoints with proper auth.

**Why**: The processor service handles file uploads and document processing. Without auth, it was a potential attack vector.

**Implementation**: Tenant tokens, drive-scoped access, content hash validation.

## Key Changes

| Commit | Date | Summary |
|--------|------|---------|
| `a8aac666ec58` | 2025-09-19 | **Ollama support** - Local AI models |
| `828a85ac6a36` | 2025-09-21 | **Anthropic fix** - Provider stability |
| `8bbfbfe75b56` | 2025-09-21 | **MCP Updated and consolidated** - Protocol maturity |
| `bf51e05e06b2` | 2025-09-22 | **MCP ask agent works now** - Agent integration |
| `5eca94599bd5` | 2025-09-22 | **GLM working** - New model provider |
| `b54ee02c2312` | 2025-09-23 | **Security checks** - Production readiness |
| `7ed53555238b` | 2025-09-23 | **Security and performance fixes** - Realtime optimization |
| `a420237d6a36` | 2025-09-23 | **Permissions cached** - Performance scaling |
| `be30092f7a76` | 2025-09-23 | **Improve structured logging** - Observability |
| `2933d2f1f9a2` | 2025-09-24 | **Cell selection works** - Spreadsheet UX |
| `ebfac4f0088e` | 2025-09-24 | **Adopt SheetDoc format** - Structured data |
| `42aa65dfd897` | 2025-09-24 | **Copy pasting works** - Spreadsheet UX |
| `41c57ee265d9` | 2025-09-24 | **Improve responsive layout** - Mobile support |
| `d2e9f65fe222` | 2025-09-25 | **Await token decoding** - Security fix |
| `b36442f3a445` | 2025-09-25 | **JWT auth bypass fix** - Critical security |
| `1c9f2d5ad4ff` | 2025-09-25 | **Processor access control** - Service hardening |
| `83bea01c0b1c` | 2025-09-26 | **Terms and privacy** - Legal compliance |
| `758a2f61be94` | 2025-09-29 | **Agent and testing** - Test infrastructure |
| `a8243ccf46bc` | 2025-09-29 | **Auth/password protection** - Access control |
| `6f53862026e5` | 2025-09-30 | **Big updates** - Major refactoring |
| `42e4d3dad0e9` | 2025-09-30 | **Security patch** - Final security fix |
| `1159d5f78bc0` | 2025-09-30 | **Redesign PR merged** - UI overhaul (PR #18) |

## Evolution Notes

This era shows maturation from experimentation to production:

1. **Provider Diversity**: Ollama, GLM, Anthropic fixes - building a robust multi-provider system
2. **MCP Stability**: Multiple MCP fixes show the challenges of maintaining a protocol integration
3. **Production Concerns**: Security, logging, caching - infrastructure for scale
4. **Pull Request Workflow**: First PRs merged (from Era 2), indicating team collaboration

### Patterns Emerging

- **Local-first Options**: Ollama enables privacy-sensitive deployments
- **Observability**: Structured logging foundation for debugging
- **Performance Awareness**: Caching, optimizations as usage grows
- **Document Type Expansion**: Beyond text - spreadsheets for structured data
- **Security-First Mindset**: Multiple security PRs show proactive hardening
- **Mobile-Ready**: Responsive design treated as requirement, not afterthought
- **PR-Based Development**: Team workflow with code review emerging

### Codex Integration

Several PRs in this era are prefixed with "codex/" branches, indicating AI-assisted development using OpenAI Codex or similar tools. This meta-pattern shows PageSpace being built partly with AI assistance - fitting for an AI-native platform.

---

*Previous: [02-foundation](./02-foundation.md) | Next: [04-collaboration](./04-collaboration.md)*
