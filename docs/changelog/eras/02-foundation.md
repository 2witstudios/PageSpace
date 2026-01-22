# Era 2: Foundation

**Dates**: September 7-18, 2025
**Commits**: 16-80
**Theme**: Core Features Emerge

## Overview

After the Genesis sprint established infrastructure, Era 2 saw explosive feature development. In just 9 days, PageSpace transformed from a basic workspace into a feature-rich platform with task management, AI-to-AI communication, file uploads with document processing, and the beginnings of a social layer with direct messages.

The commit messages in this era are still informal ("docx rendering finally works", "cant edit stored documents", "will have to do traditional OCR i cant figure it out lol"), revealing the experimental nature of development. This was a period of rapid iteration - trying things, hitting walls, and finding workarounds.

## Architecture Decisions

### Task Management System
**Commits**: `8945805425d1`, `31a5f2715cb4`, `e649a5557034`, `1abe5752e46c`, `3bc0aef9cabd`
**Dates**: 2025-09-07 to 2025-09-08

**The Choice**: Build a native task system with TODO support, glob patterns, and regex search.

**Why**: Tasks are fundamental to knowledge work. Rather than integrating a third-party tool, building native task management allowed tight integration with AI capabilities and document context.

**Trade-offs**: More development effort, but full control over the task UX and AI integration.

### AI-to-AI Communication
**Commits**: `38afdc9eb050`, `93412039e702`, `0c003242e024`
**Date**: 2025-09-10

**The Choice**: Enable AI agents to communicate with each other, not just with humans.

**Why**: Complex tasks benefit from specialized agents. An "agent chat" pattern allows delegation - one AI can ask another for help, creating emergent collaborative behavior.

**What This Enabled**:
- Custom agents created via tool calls
- Cross-drive agent discovery
- Conversation rendering for AI-to-AI threads

**Trade-offs**: Increased complexity in message routing and rendering. Had to solve: who "owns" a conversation when both participants are AI?

### File Upload and Document Processing
**Commits**: `9e7122a4372b`, `29863935a330`, `aabe4a3af9a0`, `125f6d841819`, `ce63e21b9a00`, `0a7abc73cd77`, `d90f97ee6fc9`
**Dates**: 2025-09-10 to 2025-09-13

**The Choice**: Build comprehensive document processing - PDF, DOCX, images - with text extraction and the beginnings of a processor service.

**Why**: A workspace needs to handle real documents, not just text. Users have PDFs, Word docs, images. Making these first-class citizens enables AI to understand and work with existing content.

**Challenges Encountered**:
- "docx rendering finally works" - DOCX was harder than expected
- "it technically works but right now it is crashing due to not enough ram" - Processing is resource-intensive
- "will have to do traditional OCR i cant figure it out lol" - Vision-based OCR didn't work as hoped

**Evolution**: This led to the separate processor service (apps/processor), isolating heavy document processing from the web app.

### Drag and Drop Interface
**Commits**: `3734b5cc5f6f`, `5090cdb37cf3`, `ce63e21b9a00`, `2dccc06a701c`
**Dates**: 2025-09-11 to 2025-09-12

**The Choice**: Rich drag-and-drop for file uploads, even into nested locations.

**Why**: Modern UX expectations. Users expect to drag files from their desktop directly into a web app, targeting specific folders.

**Implementation**: Required solving edge cases - nested drops, empty states, special characters in filenames.

### Model Routing
**Commits**: `11bbf3428566`, `0084a8e70257`, `115dde75cd66`, `5decb34c4442`, `24353ab4176f`
**Dates**: 2025-09-13 to 2025-09-15

**The Choice**: Dynamic model routing - different AI models for different tasks.

**Why**: Not all models are equal. Some are better at reasoning, others at speed, others at specific tasks. Routing lets the system pick the right tool for the job.

**Trade-offs**: More complexity in model selection. Required tracking model capabilities and costs.

### Direct Messages and Social Features
**Commits**: `d78c49b5d0b4`, `ba19ff53f8a9`, `496516347f07`, `2a50f99321e8`
**Date**: 2025-09-15

**The Choice**: Add DMs, profiles, and connections - social features beyond document collaboration.

**Why**: Workspaces are about people, not just documents. DMs enable private communication alongside shared drives.

**Trade-offs**: Scope creep risk. But foundational for future team features.

### Canvas Dashboard System
**Commits**: `046c1a01fd04`, `70bb10867e79`, `39e1e73a644b`, `073c02a1298e`
**Date**: 2025-09-16

**The Choice**: Build a canvas system allowing custom HTML/CSS dashboards.

**Why**: Users need personalized views of their workspace. Rather than rigid templates, canvas pages allow creative, visual organization.

**Implementation**: Native CSS support, custom links, special page type handling.

**Trade-offs**: Security considerations with custom HTML (later addressed with Shadow DOM sanitization).

### Stripe Billing Integration
**Commits**: `a83c56e56042`, `76da90f7581`, `3b2c9b94727`, `4509f46ae79`, `5bfaa1bb17c1`, `925d9c7b94ea`
**Dates**: 2025-09-17 to 2025-09-18

**The Choice**: Stripe for payments, with usage tracking and rate limiting.

**Why**: Monetization requires reliable payment processing. Stripe is the industry standard for SaaS billing.

**What Was Built**:
- Payment processing
- Storage quotas and tracking
- Rate limiting infrastructure
- Real-time usage updates
- Pricing page and tiers

**Trade-offs**: Stripe fees, but reduced payment complexity. Rate limiting adds overhead but prevents abuse.

## Key Changes

| Commit | Date | Summary |
|--------|------|---------|
| `8945805425d1` | 2025-09-07 | **Glob, Regex, TODO** - Search and task foundations |
| `38afdc9eb050` | 2025-09-10 | **AI to AI communication** - Agents can talk to agents |
| `839f489d5512` | 2025-09-10 | **Custom agents** - Created via tool calls |
| `9e7122a4372b` | 2025-09-10 | **Upload works** - File upload foundation |
| `aabe4a3af9a0` | 2025-09-11 | **DOCX rendering finally works** - Document processing |
| `ce63e21b9a00` | 2025-09-11 | **Drag and drop** - Proper file upload UX |
| `d90f97ee6fc9` | 2025-09-13 | **Upload service/image processing** - Processor foundations |
| `11bbf3428566` | 2025-09-13 | **Working model routing** - Multi-model AI |
| `7f1a87fbc3d6` | 2025-09-14 | **Global search** - Cross-drive discovery |
| `79b41f4ff392` | 2025-09-14 | **Nested tool calls** - AI can chain operations |
| `d78c49b5d0b4` | 2025-09-15 | **Profile, messages, connections** - Social layer |
| `1921f9fcbfa0` | 2025-09-15 | **Avatars** - User identity |
| `046c1a01fd04` | 2025-09-16 | **Way better canvas** - Dashboard system |
| `a83c56e56042` | 2025-09-17 | **Stripe payment** - Billing foundation |
| `5bfaa1bb17c1` | 2025-09-17 | **Billing, storage, rate limits all done** - Monetization complete |
| `2de910cf62e5` | 2025-09-18 | **First PR merge** - Team collaboration begins |

## Evolution Notes

This era reveals the "figure it out" nature of early development:

1. **OCR Humility**: "will have to do traditional OCR i cant figure it out lol" - Not everything works on first try. Vision models weren't ready for reliable OCR, leading to fallback approaches.

2. **RAM Constraints**: "crashing due to not enough ram" - The processor service emerged from real resource constraints, not theoretical architecture.

3. **Incremental Success**: "docx rendering finally works" - Features that seem simple can require significant iteration.

4. **Rapid Experimentation**: 50 commits in 9 days shows a "try it and see" approach. Not everything stuck, but patterns emerged.

### Patterns Established

- **AI-first thinking**: Even early features consider AI integration
- **Real-time expectations**: Live updates are assumed, not added later
- **Document diversity**: Supporting multiple formats from the start
- **User experience focus**: Drag-and-drop, not just file pickers

---

*Previous: [01-genesis](./01-genesis.md) | Next: [03-ai-awakening](./03-ai-awakening.md)*
