## 2025-10-01

### Documentation Update - Architecture & API Coverage

**Comprehensive Documentation Refresh**

Updated all documentation to reflect the current codebase state, fixing outdated dependency versions, missing features, and incomplete API coverage.

#### Core Documentation Updates ✅
- **CLAUDE.md**: Updated with correct dependency versions, added processor service, added Turbo build system, comprehensive testing commands
- **API Routes List**: Added 30+ missing endpoints including agents, bulk operations, storage, subscriptions, connections, and search routes
- **Table of Contents**: Reorganized with proper links to all guides, features, and testing infrastructure

#### Architecture Documentation ✅
- **Processor Service**: Comprehensive documentation already existed at `/docs/2.0-architecture/2.2-backend/processor-service.md`
- **Monorepo Structure**: Updated to include all 3 apps (web, realtime, processor)
- **Testing Infrastructure**: Linked to comprehensive testing docs (90+ tests documented)

#### Dependency Version Updates ✅
- Vercel AI SDK: Updated from 4.3.17 → 5.0.12 (major version)
- AI SDK Providers: Updated all to v2.0+ (@ai-sdk/google, anthropic, openai, xai)
- Socket.IO: 4.7.5 → 4.8.1
- Added @ai-sdk/xai ^2.0.8 (was missing)
- Added Turbo build system documentation

#### New API Endpoints Documented ✅
**Agent Management** (7 new routes):
- `/api/agents/create`, `/api/agents/[agentId]/config`
- `/api/agents/consult`, `/api/agents/multi-drive`
- `/api/drives/[driveId]/agents`

**Bulk Operations** (5 new routes):
- `/api/pages/bulk/create-structure`, `/api/pages/bulk/delete`
- `/api/pages/bulk/move`, `/api/pages/bulk/rename`
- `/api/pages/bulk/update-content`

**Storage & Subscriptions** (6 new routes):
- `/api/storage/check`, `/api/storage/info`
- `/api/subscriptions/status`, `/api/subscriptions/usage`
- `/api/stripe/portal`, `/api/stripe/webhook`

**Search & Discovery** (4 new routes):
- `/api/search`, `/api/search/multi-drive`
- `/api/drives/[driveId]/search/regex`, `/api/drives/[driveId]/search/glob`

**Other** (8+ routes):
- AI tasks, connections, contact, file operations, avatars

#### Project Structure ✅
- README.md: Added processor service to architecture diagram
- Table of Contents: Added testing section, AI tools reference, all feature docs
- Commands: Added complete testing suite commands (unit, e2e, coverage, security)

#### Impact
- Documentation now accurately reflects codebase state
- All 100+ API routes properly documented
- Complete development workflow coverage
- Testing infrastructure visible and accessible

**Time**: 3 hours

---

## 2025-09-30

### Critical Security Fixes - Pre-MVP Launch

**All 7 Critical Security Blockers Resolved**

Implemented comprehensive security fixes addressing authentication, authorization, data integrity, and XSS vulnerabilities identified in the MVP security audit.

#### BLOCKER-001: Signup Rate Limiting ✅
- **Issue**: No rate limiting on signup endpoint despite infrastructure existing
- **Impact**: Unlimited account creation → CPU exhaustion via bcrypt(12)
- **Fix**: Added dual rate limiting (IP + email) with 3 attempts/hour
- **Location**: `/apps/web/src/app/api/auth/signup/route.ts`
- **Time**: 30 minutes

#### BLOCKER-002: Channel Message HMAC Signatures ✅
- **Issue**: Channel/DM message broadcasts missing HMAC signatures
- **Impact**: Real-time messaging broken (broadcasts rejected with 401)
- **Fix**: Added `createSignedBroadcastHeaders()` to message endpoints
- **Locations**:
  - `/apps/web/src/app/api/channels/[pageId]/messages/route.ts`
  - `/apps/web/src/app/api/messages/[conversationId]/route.ts`
- **Time**: 10 minutes

#### BLOCKER-003: CSS url() Data Exfiltration ✅
- **Issue**: Canvas CSS allows external `url()` → tracking pixels in shared templates
- **Impact**: Template sharing enables data exfiltration
- **Fix**: Block external URLs, allow data: URIs for images/fonts only
- **Location**: `/apps/web/src/lib/canvas/css-sanitizer.ts`
- **Time**: 2 hours

#### BLOCKER-004: MCP Write Permission Validation ✅
- **Issue**: MCP operations check access but never validate `canEdit`
- **Impact**: Read-only users can modify documents via MCP API
- **Fix**: Added permission check for write operations (replace, insert, delete)
- **Location**: `/apps/web/src/app/api/mcp/documents/route.ts`
- **Time**: 5 minutes

#### BLOCKER-005: Circular Page Reference Prevention ✅
- **Issue**: No validation prevents circular parent-child relationships
- **Impact**: Stack overflow in breadcrumb computation, infinite loops
- **Fix**:
  - Created circular reference guard utilities
  - Fixed breadcrumb computation to be iterative with cycle detection
  - Added validation to all page move endpoints
- **Locations**:
  - `/packages/lib/src/pages/circular-reference-guard.ts` (new)
  - `/apps/web/src/app/api/pages/[pageId]/breadcrumbs/route.ts`
  - `/apps/web/src/app/api/pages/[pageId]/route.ts`
  - `/apps/web/src/app/api/pages/reorder/route.ts`
  - `/apps/web/src/app/api/pages/bulk/move/route.ts`
- **Time**: 5 hours

#### BLOCKER-006: Admin Endpoint Authorization ✅
- **Issue**: Monitoring endpoints only check authentication, not admin role
- **Impact**: Any user can access system metrics, AI costs, error logs
- **Fix**: Added `verifyAdminAuth()` check to monitoring endpoints
- **Location**: `/apps/web/src/app/api/monitoring/[metric]/route.ts`
- **Time**: 5 minutes

#### BLOCKER-007: File Security (Header Injection + XSS) ✅
- **Issue**: Filename CRLF injection + XSS via HTML/SVG uploads
- **Impact**: Header injection, session hijacking, cookie theft
- **Fix**:
  - Created filename sanitization utilities
  - Sanitize filenames in all file-serving endpoints
  - Force download for dangerous MIME types (HTML, SVG, XML)
  - Add strict CSP headers with sandbox
- **Locations**:
  - `/packages/lib/src/utils/file-security.ts` (new)
  - `/apps/web/src/app/api/files/[id]/download/route.ts`
  - `/apps/web/src/app/api/files/[id]/view/route.ts`
  - `/apps/web/src/app/api/upload/route.ts`
  - `/apps/processor/src/utils/security.ts`
  - `/apps/processor/src/api/serve.ts`
- **Time**: 5 hours

**Total Implementation Time**: ~13 hours

**Security Improvements**:
- ✅ Rate limiting prevents DOS attacks and spam
- ✅ Real-time messaging now working with proper authentication
- ✅ Canvas templates safe from tracking pixel exfiltration
- ✅ MCP integration properly enforces edit permissions
- ✅ Page tree operations protected from circular references
- ✅ Admin-only data properly protected from regular users
- ✅ File uploads/downloads protected from header injection and XSS

---

## 2025-09-30

### Security Audit - Drive & Workspace Management System

- **Comprehensive Security Review**: Conducted thorough security audit of drives and workspace management
  - **Scope**: Drive creation, member management, permissions, invitations, access control
  - **Methodology**: Code-level verification of actual implementation vs theoretical vulnerabilities
  - **Result**: System significantly more secure than initially assessed - most "critical" findings were false positives
  - **Documents Created**:
    - `SECURITY_AUDIT_DRIVES.md` - Original audit (superseded, preserved for reference)
    - `SECURITY_AUDIT_DRIVES_REVISED.md` - Complete revised audit with MVP focus
    - `SECURITY_AUDIT_SUMMARY.md` - Executive summary and quick reference

- **Key Findings - Revised Assessment**:
  - **Overall Risk**: LOW-MEDIUM for MVP (originally claimed MEDIUM-HIGH)
  - **Critical Vulnerabilities**: 0 (originally claimed 4)
  - **MVP Blockers**: 2 feature gaps requiring 2-3 hours to fix
  - **False Positives**: 3 major claims debunked by code verification

- **MVP Blockers Identified**:
  1. **Owner Not in driveMembers Table**: Drive creation doesn't add owner to driveMembers, causing data model inconsistency
     - Location: `/apps/web/src/app/api/drives/route.ts:100-110`
     - Impact: Owner doesn't appear in member queries
     - Fix: Add transaction to insert owner member record on creation
     - Time: 15 minutes + migration to backfill existing drives

  2. **No Member Removal Endpoint**: DELETE endpoint missing for removing drive members
     - Location: `/apps/web/src/app/api/drives/[driveId]/members/[userId]/route.ts`
     - Impact: Cannot remove members once added (feature gap)
     - Fix: Implement DELETE handler with owner protection
     - Time: 30 minutes

- **False Positives Corrected**:
  1. **"Owner Can Be Removed"**: DEBUNKED - No DELETE/PATCH endpoint exists for member roles
  2. **"Missing Invitation Validation"**: OVERSTATED - Feature not implemented yet; auto-accept intentional for MVP
  3. **"Drive Settings Vulnerable"**: OVERSTATED - Zod validates input before spread operator

- **Security Strengths Verified**:
  - ✅ All mutation endpoints verify ownership (`drives.ownerId === userId`)
  - ✅ Access control correctly checks owner OR member status
  - ✅ Soft delete pattern prevents accidental data loss
  - ✅ Cross-drive validation prevents permission leakage
  - ✅ Database constraints enforce data integrity
  - ✅ Next.js 15 async params pattern throughout
  - ✅ Type-safe Drizzle ORM usage

- **High Priority (Post-MVP)**:
  - Role validation to prevent invalid role assignments (10 min fix)
  - Proper invitation flow with user consent (enhancement)
  - Define and enforce ADMIN role permissions (feature expansion)

- **Recommendation**: **SHIP AFTER 2-3 HOUR FIX** - System is secure; only missing basic member management features

---

## 2025-09-25

### Browser Compatibility Fix - Memory Usage Error (16:56 UTC)

- **Fixed Critical Browser Error**: Resolved `TypeError: i.memoryUsage is not a function` in browser environments
  - **Root Cause**: Client-side React components importing `socket-utils.ts` which imported Node.js-specific logger
  - **Solution**: Created browser-safe logger implementation to prevent Node.js API calls in browser context
  - **Added**: `packages/lib/src/logger-browser.ts` - Browser-compatible logger with environment detection
  - **Added**: `packages/lib/src/utils/environment.ts` - Runtime environment detection utilities
  - **Updated**: `apps/web/src/lib/socket-utils.ts` - Now uses browser-safe logger instead of Node.js logger
  - **Updated**: `packages/lib/package.json` - Added exports for new browser-safe modules
  - **Impact**: Prevents JavaScript runtime errors when client components import server utilities
  - **Compatibility**: Works in both Node.js server context and browser client context
  - **Files Modified**:
    - `packages/lib/src/logger-browser.ts` (new)
    - `packages/lib/src/utils/environment.ts` (new)
    - `apps/web/src/lib/socket-utils.ts`
    - `packages/lib/package.json`

## 2025-09-23

### Refactored AI Provider Factory (14:30 UTC)

- **Eliminated Code Duplication**: Extracted duplicated provider/model selection logic into centralized `AIProviderFactory` service
  - **Removed**: ~400+ lines of duplicated provider logic across multiple AI routes
  - **Added**: `apps/web/src/lib/ai/provider-factory.ts` - Centralized provider factory service
  - **Refactored**: 4 files now use shared factory instead of duplicate logic:
    - `apps/web/src/app/api/ai_conversations/[id]/messages/route.ts`
    - `apps/web/src/app/api/ai/chat/route.ts`
    - `apps/web/src/app/api/agents/consult/route.ts`
    - `apps/web/src/lib/ai/tools/agent-communication-tools.ts`
  - **Improved**: Consistent error handling and validation across all AI provider implementations
  - **Enhanced**: TypeScript type safety with proper `LanguageModel` typing
  - **Maintainability**: Single location for adding new providers or updating provider logic
  - **DRY Principle**: Follows Don't Repeat Yourself principle for better code organization

### Security Fix - Page AI Settings PATCH Handler

- **Fixed Critical Authorization Vulnerability**: Page AI settings PATCH endpoint (`/api/ai/chat`) now properly enforces permission checks
  - **Added**: Permission enforcement using `canUserEditPage()` before allowing AI provider/model updates
  - **Added**: Provider/model combination validation with subscription requirement checks
  - **Added**: Enhanced input validation with proper type checking and sanitization
  - **Added**: Comprehensive test suite covering authorization, validation, and edge cases
  - **Security Impact**: Prevents cross-tenant tampering and quota abuse by unauthorized users
  - **Error Handling**: Returns 403 Forbidden for unauthorized users, 400 for invalid inputs
  - **Validation**: Validates provider whitelist, model format, subscription requirements
  - **Location**: `apps/web/src/app/api/ai/chat/route.ts:1172-1283`
  - **Tests**: `apps/web/src/app/api/ai/chat/route.test.ts`

### Security Fix - Page Chat Messages

- **Fixed Critical Authorization Vulnerability**: Page chat messages endpoint (`/api/ai/chat/messages`) now properly validates user permissions
  - **Added**: Permission check using `canUserViewPage()` before returning chat messages
  - **Security Impact**: Prevents unauthorized access to page chat histories
  - **Error Handling**: Returns 403 Forbidden with descriptive error message for unauthorized users
  - **Consistency**: Now follows same permission pattern as other page-based endpoints
  - **Location**: `apps/web/src/app/api/ai/chat/messages/route.ts:24-31`

## 2025-09-22

### Added

- **Complete MCP Backend Implementation**: Finished implementation of all 13 new MCP tools with full backend API support
  - **Agent Management APIs**: 4 new endpoints for complete AI agent lifecycle management
    - **Created**: `/apps/web/src/app/api/agents/[agentId]/config/route.ts` - PUT endpoint for updating agent configuration
      - **Features**: Update systemPrompt, enabledTools, aiProvider, aiModel for existing agents
      - **Auth**: Edit permissions on agent page with comprehensive validation
      - **Broadcasting**: Real-time Socket.IO events for configuration changes
    - **Created**: `/apps/web/src/app/api/drives/[driveId]/agents/route.ts` - GET endpoint for listing agents in drive
      - **Features**: List all AI_CHAT pages with agent configuration and permission filtering
      - **Auth**: Drive access check + individual page view permissions
      - **Query Parameters**: includeSystemPrompt, includeTools, driveSlug for flexible data retrieval
    - **Created**: `/apps/web/src/app/api/agents/multi-drive/route.ts` - GET endpoint for cross-drive agent discovery
      - **Features**: List agents across all accessible drives with grouping options
      - **Auth**: Per-drive access validation + page-level permission checks
      - **Query Parameters**: groupByDrive, includeSystemPrompt, includeTools for customizable responses
    - **Created**: `/apps/web/src/app/api/agents/consult/route.ts` - POST endpoint for AI agent consultation
      - **Features**: Ask questions to other AI agents using existing chat infrastructure
      - **Auth**: View permissions on target agent with conversation context integration
      - **AI Integration**: Full multi-provider support (OpenRouter, Google, OpenAI, Anthropic, xAI, Ollama)

- **Enhanced Type Safety**: Full TypeScript compilation verification for all new endpoints
  - **Next.js 15 Compatibility**: All endpoints follow async params pattern (`await context.params`)
  - **Database Integration**: Proper handling of JSONB fields for enabledTools with type guards
  - **Error Handling**: Comprehensive error responses with detailed validation messages
  - **Provider Integration**: Robust AI provider configuration with fallback handling

- **Complete MCP Tool Ecosystem**: All 13 MCP tools now have functional backend endpoints
  - **Search APIs**: regex_search, glob_search, multi_drive_search (3/3 complete)
  - **Batch Operations**: bulk_move_pages, bulk_rename_pages, bulk_delete_pages, bulk_update_content, create_folder_structure (5/5 complete)
  - **Agent Management**: create_agent, update_agent_config, list_agents, multi_drive_list_agents, ask_agent (5/5 complete)

### Technical Implementation

- **Authentication Pattern**: All endpoints use standardized `authenticateRequest()` for security
- **Permission System**: Leverages existing `canUserEditPage`, `canUserViewPage`, `getUserDriveAccess` functions
- **Broadcasting Integration**: Real-time Socket.IO events for all state-modifying operations
- **Database Transactions**: Atomic operations where appropriate for data consistency
- **Response Format**: Consistent success/error structure matching MCP expectations
- **Logging**: Structured logging for audit trails and debugging

### Status Update

- **Progress**: 100% Complete (13/13 endpoints implemented)
- **Achievement**: All MCP v2.0.0 tools now have functional backend API endpoints
- **Testing**: TypeScript compilation successful, integration patterns verified
- **Documentation**: Complete implementation status tracked in `MCP_BACKEND_IMPLEMENTATION.md`

### 2025-09-19

## 2025-01-21

### Added

- **AI Tool Calling Architecture Documentation**: Comprehensive documentation for PageSpace's advanced AI tool system
  - **Created**: `docs/2.0-architecture/2.6-features/ai-tool-calling.md` - Complete architecture overview
    - **Tool Integration Framework**: Core tool execution patterns and context handling
    - **Permission-Based Filtering**: Role-based access control for AI tools
    - **Multi-Step Operations**: Support for complex 100+ tool call workflows
    - **Agent Communication System**: Sophisticated AI-to-AI consultation capabilities
    - **Real-Time Broadcasting**: Tool execution results broadcast to all users
  - **Created**: `docs/3.0-guides-and-tools/ai-tools-reference.md` - Comprehensive tool reference
    - **13+ Tools Documented**: Complete reference for all workspace automation tools
    - **6 Tool Categories**: Core operations, content editing, search, tasks, batch ops, agent management
    - **Usage Examples**: Real-world scenarios and implementation patterns
    - **Best Practices**: Guidelines for effective AI tool usage
  - **Created**: `docs/2.0-architecture/2.6-features/model-capabilities.md` - Model capability detection system
    - **Vision Detection**: Automatic vision support detection for 100+ models
    - **Tool Capability Validation**: OpenRouter API integration for authoritative capability data
    - **Graceful Degradation**: Intelligent fallbacks for unsupported features
    - **Caching Strategy**: Performance-optimized capability detection

- **Enhanced AI System Documentation**: Updated existing documentation with tool calling integration
  - **Updated**: `docs/2.0-architecture/2.6-features/ai-system.md` - Expanded tool integration section
    - **Tool Categories Overview**: Complete breakdown of 6 tool categories
    - **Tool Execution Framework**: Advanced configuration and context handling
    - **Capability-Aware Integration**: Model capability detection and adaptation
  - **Updated**: `docs/2.0-architecture/2.4-api/ai.md` - Enhanced API documentation
    - **Tool Execution Flow**: 5-step tool processing pipeline
    - **Enhanced Database Operations**: Tool calls and results storage in JSON format
    - **Permission Model**: Tool-specific validation and agent consultation permissions
    - **Real-Time Collaboration**: Enhanced broadcasting for tool execution and agent communication

- **Functions List Enhancement**: Updated comprehensive function documentation
  - **Updated**: `docs/1.0-overview/1.5-functions-list.md` - Added missing AI tool functions
    - **Enhanced Search Tools**: regex_search, glob_search, multi_drive_search with detailed parameters
    - **Agent Communication**: list_agents, ask_agent with sophisticated cross-agent consultation
    - **Model Capabilities**: Capability detection system functions
    - **Updated Statistics**: 350+ documented functions across enhanced AI system

## 2025-09-21

### Fixed

- Corrected a legacy code bug in the subscription plan service that improperly handled the new "Free | Pro | Business" tiers.
- Updated the rate-limiting error message for advanced AI models to correctly mention that both "Pro" and "Business" tiers have access.
- Renamed the "Extra Thinking (Pro Only)" AI model to "Advanced (Pro/Business)" to accurately reflect its availability across the new subscription tiers.
- Verified that all subscription and rate-limiting logic now correctly supports the "Business" tier.
- **AI Tool Simplification**: Simplified batch operations for better AI compatibility
  - **REMOVED**: Complex `batch_page_operations` tool with confusing `tempId` system
    - **Issue**: AI assistants struggled with `tempId` scoping and parameter requirements
    - **Problem**: Overlapping tool capabilities created confusion about when to use what
  - **ADDED**: Simple `bulk_delete_pages` tool for atomic page deletions
    - **Features**: Delete multiple pages with optional child deletion in one transaction
    - **Clear Purpose**: Single-function tool with obvious parameters
  - **ADDED**: Simple `bulk_update_content` tool for atomic content updates
    - **Features**: Replace, append, or prepend content in multiple pages atomically
    - **Easy Usage**: No complex parameter validation or cross-referencing
  - **IMPROVED**: Tool documentation and examples to be more AI-friendly
    - **Updated**: `apps/web/src/lib/ai/tool-instructions.ts` with clearer guidance
    - **Renamed**: "Batch Operations" to "Simple Bulk Operations"
    - **Benefits**: Each tool has single, obvious purpose
  - **RESULT**: Eliminates `tempId` confusion that was causing AI assistant errors
  - **MIGRATION**: Use purpose-built tools instead of complex batch operations:
    - Create hierarchies → `create_folder_structure`
    - Move pages → `bulk_move_pages`
    - Rename pages → `bulk_rename_pages`
    - Delete pages → `bulk_delete_pages`
    - Update content → `bulk_update_content`

### 2025-01-16

- **Canvas Navigation Simplification**: Removed pagespace:// protocol in favor of standard URLs
  - **Updated**: `apps/web/src/components/layout/middle-content/page-views/canvas/CanvasPageView.tsx`
    - **Removed**: Support for `pagespace://page/id` protocol (was broken due to browser URL handling)
    - **Standardized**: All navigation now uses `/dashboard/drive-id/page-id` format
  - **Updated**: Documentation to reflect single navigation pattern
    - **Added**: "Getting Your IDs" section in canvas dashboard guide
    - **Removed**: All references to pagespace:// protocol
  - **Benefits**:
    - Simpler, more predictable navigation
    - Works with browser URL standards
    - No special protocol handling needed

- **Canvas Dashboard System**: Functional HTML/CSS Dashboards with Navigation
  - **Created**: `apps/web/src/components/canvas/ShadowCanvas.tsx` - Shadow DOM component for isolated rendering
    - **Shadow DOM Isolation**: Complete style encapsulation from main app
    - **Navigation Interception**: Clicks on links and buttons trigger PageSpace navigation
    - **Theme Independence**: Dashboards look identical in light/dark mode
    - **CSS Extraction**: Automatically extracts and applies embedded `<style>` tags
    - **Security**: DOMPurify HTML sanitization, CSS JavaScript blocking
  - **Updated**: `apps/web/src/components/layout/middle-content/page-views/canvas/CanvasPageView.tsx`
    - **Replaced**: Iframe-based Sandbox with ShadowCanvas component
    - **Added**: Navigation handling with permission checking
    - **Removed**: Complex postMessage communication
  - **Created**: `apps/web/src/lib/canvas/css-sanitizer.ts` - CSS security utilities
    - **Blocks**: JavaScript execution (expression, -moz-binding, javascript:)
    - **Allows**: Full creative CSS (animations, gradients, transforms)
  - **Updated**: `apps/web/src/components/sandbox/Sandbox.tsx`
    - **Reverted**: Removed navigation complexity, back to simple iframe
  - **Documentation**:
    - Created comprehensive feature documentation
    - Created user-friendly dashboard builder guide
    - Updated all related documentation files
  - **Impact**:
    - Canvas pages now have fully functional navigation
    - Users can build custom dashboards with standard HTML/CSS
    - AI can generate compatible dashboards naturally
    - Improved security through Shadow DOM isolation
    - Simplified architecture without iframe complexity

### 2025-01-14

- **AI System Enhancement**: Comprehensive AI Prompt System Overhaul (Part 2 - Simplified & Adaptive)
  - **Updated**: `apps/web/src/lib/ai/role-prompts.ts` - Simplified PARTNER role for natural adaptability
    - **Removed**: Over-prescriptive instructions like "ALWAYS explore first"
    - **Added**: Flexible principles: "Read the situation" and "Use your judgment"
    - **Conversational First**: Engage naturally before reaching for tools when brainstorming
    - **Intent-Based Actions**: Clear requests trigger immediate tool use
    - **Human Balance**: Like a knowledgeable colleague, not a robot following scripts
  - **Philosophy Change**: Trust the AI's intelligence rather than micromanaging behavior
    - Let context and user intent naturally drive tool usage
    - Remove rigid workflows in favor of adaptive responses
    - Keep technical documentation available but not mandatory

- **AI System Enhancement**: Comprehensive AI Prompt System Overhaul (Part 1)
  - **Created**: `apps/web/src/lib/ai/tool-instructions.ts` - Detailed tool usage instructions
    - **Core Navigation**: Workspace discovery patterns and permission awareness
    - **Document Operations**: Read-before-write patterns, line-based editing guidance
    - **Search Strategies**: Hierarchical search tools (glob → regex → fuzzy)
    - **Task Management**: Complex operation tracking with create_task_list
    - **Batch Operations**: Atomic multi-page transactions with tempId system
    - **AI Agent Management**: Specialized assistant creation and configuration
    - **Parallel Execution**: 3-5x performance improvement patterns
    - **Error Recovery**: Graceful failure handling and retry strategies
  - **Updated**: `apps/web/src/lib/ai/role-prompts.ts` - Enhanced role definitions
    - **Core Identity**: "PageSpace AI - think Cursor for Google Drive"
    - **Action-Oriented Language**: EXPLORE FIRST, EXECUTE AUTONOMOUSLY, PARALLELIZE AGGRESSIVELY
    - **Role-Specific Instructions**: Tailored tool usage for PARTNER, PLANNER, WRITER roles
    - **Critical Principles**: Always explore before modifying, complete tasks autonomously
    - **Status Communication**: Before/during/after operation updates
  - **Created**: `apps/web/src/lib/ai/test-enhanced-prompts.ts` - Prompt testing utility
    - **Verification**: All key improvements present in generated prompts
    - **Length Analysis**: Partner (14KB), Planner (8KB), Writer (9KB) prompts
  - **Impact**:
    - AI now has explicit workflows for common operations
    - Parallel execution patterns improve response time 3-5x
    - Error recovery prevents task abandonment
    - Tool usage is now predictable and efficient
    - Status updates keep users informed during operations

### 2025-01-13

- **Documentation**: File Upload and Processing Architecture
  - **Created**: `docs/2.0-architecture/2.6-features/file-upload.md` - Comprehensive file upload system documentation
    - **Overview**: Distributed architecture, design principles, component responsibilities
    - **Processing**: Image optimization pipeline, text extraction pipeline
    - **Storage**: Content-addressed storage with SHA256 hashing
    - **AI Integration**: Vision model support, file immutability for uploaded content
    - **Known Limitations**: Current implementation status and future enhancements
  - **Created**: `docs/2.0-architecture/2.2-backend/processor-service.md` - Processor service architecture
    - **Service Configuration**: Docker setup, memory management
    - **Core Components**: Express server, content store, image processor, queue manager
    - **API Endpoints**: Upload, serve, optimization, health check
    - **Processing Workflows**: Image and document processing flows
    - **Performance**: Memory management, caching strategy, concurrency control
  - **Updated**: `docs/1.0-overview/1.4-api-routes-list.md` - Added file upload routes
    - **POST /api/upload**: File upload endpoint documentation
    - **GET /api/files/[id]/view**: File viewing endpoint documentation
  - **Updated**: `docs/1.0-overview/1.5-functions-list.md` - Added file processing functions
    - **ContentStore Functions**: File storage and retrieval functions
    - **Image Processing Functions**: Image optimization and preset processing
    - **Queue Manager Functions**: Job queue management for background processing
    - **Text Extraction Functions**: Document text extraction (partially implemented)
    - **File Upload/View Functions**: API handlers for file operations
    - **AI Visual Content Functions**: Vision model integration utilities

### 2025-01-02

- **Major Refactor**: Page Type System Centralization
  - **Refactored**: Complete overhaul of page type handling system with centralized configuration
  - **Created**: `packages/lib/src/page-types.config.ts` - Central configuration for all page type metadata
    - **Metadata**: Display names, descriptions, icons, emojis, capabilities
    - **Behavior**: Default content generation, allowed child types, UI component mapping
    - **Validation**: API validation rules, custom validators
  - **Created**: `packages/lib/src/page-type-validators.ts` - Centralized validation logic
    - **validatePageCreation()**: Type-specific creation validation
    - **validatePageUpdate()**: Update validation with type awareness
    - **validateAIChatTools()**: AI tool validation for AI_CHAT pages
    - **canConvertToType()**: Page type conversion rules
  - **Created**: `apps/web/src/components/common/PageTypeIcon.tsx` - Unified icon component
    - **Replaces**: 4 duplicate icon mapping functions across the codebase
    - **Consistent**: AI_CHAT now uses Sparkles icon everywhere (was Bot in some places)
  - **Updated**: Component selection to use dynamic mapping instead of switch statements
    - **index.tsx**: Uses getPageTypeComponent() with componentMap
    - **CenterPanel.tsx**: Uses getPageTypeComponent() with componentMap
  - **Removed**: Duplicate code and hardcoded type checks
    - **Deleted**: Icon.tsx wrapper files from drive/ and folder/ directories
    - **Replaced**: All hardcoded type comparisons with helper functions
    - **Helper functions**: isDocumentPage(), isFilePage(), isFolderPage(), isCanvasPage(), isChannelPage(), isAIChatPage()
  - **Impact**: 
    - **~400 lines of duplicate code removed**
    - **Single source of truth for page type behavior**
    - **New page types now require changes in only 2 files vs 31+**
    - **Improved type safety with TypeScript enums throughout**
  - **Files modified**: 31 files refactored to use centralized system

### 2025-09-11

- **Major Enhancement**: Drag-and-Drop File Upload with Native @dnd-kit Behavior
  - **Added**: External file drag-and-drop functionality that perfectly matches internal page reordering
    - **Position tracking**: Captures drag start position to calculate delta values like native @dnd-kit
    - **Smart drop zones**: Top 40% = before, bottom 40% = after, middle 20% = maintains state (prevents spazzing)
    - **Delta-based "inside" detection**: Drag 30px right from start position to drop inside folders (matches native)
    - **Smooth animations**: 10px margin displacement with 150ms cubic-bezier transitions (identical to native)
  - **Enhanced**: `/api/upload` endpoint to support precise positioning
    - **Added**: `position` parameter ('before' | 'after') for drop type
    - **Added**: `afterNodeId` parameter to identify target node
    - **Implemented**: Fractional position calculation for exact placement between items
  - **Updated**: `useFileDrop` hook to pass position data through upload flow
  - **Fixed**: Spazzing/flickering issues with overlapping drop zones
    - **Element-relative positioning**: Uses position within hovered element instead of total delta
    - **Dead zones**: Middle 20% of elements prevents rapid state changes
  - **Enhanced**: Visual feedback system
    - **Subtle gaps**: Reduced from 6px to 2px for cleaner appearance
    - **Blue indicators**: Lines for before/after, ring for inside drops
    - **File preview overlay**: Shows "Upload files" indicator following cursor
  - **Result**: External file uploads now behave identically to native @dnd-kit draggable items
  - **Technical approach**: Hybrid system that mimics @dnd-kit behavior without modifying the library
  - **Files modified**: 
    - `apps/web/src/components/layout/left-sidebar/page-tree/PageTree.tsx`
    - `apps/web/src/components/layout/left-sidebar/page-tree/TreeNode.tsx`
    - `apps/web/src/hooks/useFileDrop.ts`
    - `apps/web/src/app/api/upload/route.ts`

### 2025-09-10

- **Major Enhancement**: AI Agent Creation System and Enhanced Page Creation Tools
  - **Added**: `apps/web/src/lib/ai/tools/agent-tools.ts` - Dedicated AI agent creation and management tools
    - **create_agent**: Create fully configured AI agents with system prompt, enabled tools, and provider settings in one operation
    - **update_agent_config**: Update existing agent configuration including system prompt, enabled tools, AI provider, and model settings
  - **Enhanced**: `create_page` tool in `page-write-tools.ts` to support agent configuration
    - **Optional agent configuration**: systemPrompt, enabledTools, aiProvider, aiModel parameters for AI_CHAT pages
    - **Tool validation**: Validates enabled tools against available PageSpace tools with helpful error messages
    - **Backward compatibility**: Maintains existing behavior for non-agent page creation
  - **Enhanced**: `/api/pages` POST endpoint to handle agent configuration in page creation
    - **Validation**: Server-side validation of agent tools and configuration
    - **Database integration**: Stores agent configuration in systemPrompt and enabledTools fields
  - **Updated**: AI tools export to include new agent management capabilities
  - **Rationale**: Enables AI to create fully configured agents in one streamlined operation, eliminating the need for manual post-creation configuration

- **Major Fix**: Agent Configuration System Overhaul and Performance Optimization
  - **Fixed**: Broken agent configuration save functionality - UI/UX issue where save button was hidden by CSS overflow constraints
  - **Removed**: Redundant `agentName` field from database schema and replaced with page title-based identity
  - **Added**: Database migration `0005_daily_colonel_america.sql` to drop unused agentName column
  - **Refactored**: AI page header architecture with save button relocation to header area for improved accessibility
    - **Conditional save button**: Only visible when Settings tab is active for better UX
    - **Tab-specific overflow handling**: Chat tab maintains sticky input (overflow: hidden), Settings tab allows scrolling (overflow: auto)
    - **Seamless header design**: Eliminated gaps between header sections for polished appearance
  - **Optimized**: Checkbox performance in tool selection using react-hook-form Controller pattern
    - **Replaced**: Manual `getValues()` calls that caused O(n) re-render lag with single source of truth pattern
    - **Implemented**: Proper Controller pattern for optimal form state management
    - **Enhanced**: useImperativeHandle with useCallback dependency management for external form submission
  - **Updated**: Agent configuration API endpoint (`/api/pages/[pageId]/agent-config`) to remove agentName handling
  - **Enhanced**: System prompt architecture with dynamic per-message injection (not stored per conversation)
  - **Updated**: AI chat processing to use page.title instead of deprecated agentName field
  - **Fixed**: TypeScript compilation errors and React dependency warnings throughout agent system
  - **Updated**: Documentation across functions list, API routes, and database schema to reflect new architecture
  - **Rationale**: Transformed broken agent configuration into production-ready system with optimal performance and simplified identity management

### 2025-09-07

- **Major Enhancement**: Enhanced AI Tools with Search, Task Management, and Batch Operations
  - **Added**: `apps/web/src/lib/ai/tools/search-tools.ts` - Advanced search capabilities for AI assistants
    - **regex_search**: Pattern-based content search using regular expressions with permission filtering
    - **glob_search**: Structural discovery using glob patterns (e.g., `**/README*`, `meeting-*.md`)
    - **multi_drive_search**: Cross-workspace search with automatic access control
  - **Added**: `apps/web/src/lib/ai/tools/task-management-tools.ts` - Persistent task tracking system
    - **create_task_list**: Create task lists that persist across AI conversations
    - **get_task_list**: Monitor task progress with completion tracking
    - **update_task_status**: Manage task status with automatic progression
    - **add_task**: Dynamically expand task lists
    - **add_task_note**: Document progress and preserve context
    - **resume_task_list**: Continue tasks across different AI sessions
  - **Added**: `apps/web/src/lib/ai/tools/batch-operations-tools.ts` - Atomic multi-operation transactions
    - **batch_page_operations**: Execute multiple operations atomically with rollback support
    - **bulk_move_pages**: Mass page relocation while preserving order
    - **bulk_rename_pages**: Pattern-based bulk renaming (find/replace, prefix, suffix, template)
    - **create_folder_structure**: Create complex nested hierarchies in single operations
  - **Added**: `ai_tasks` table in database schema for persistent task management
  - **Added**: Task event broadcasting via Socket.IO for real-time task updates
  - **Enhanced**: AI tools now consistently return both pageId (for operations) and semantic paths (for human understanding)
  - **Updated**: Documentation to reflect 13 new AI tool functions and enhanced capabilities
  - **Rationale**: Transforms AI from simple Q&A to a collaborative partner capable of complex, multi-step operations

### 2025-08-24

- **Refactor**: Split `ai-tools.ts` into smaller, more manageable files.
  - **Added**: `apps/web/src/lib/ai/types.ts` for shared AI tool types.
  - **Added**: `apps/web/src/lib/ai/tools/drive-tools.ts` for drive-related AI tools.
  - **Added**: `apps/web/src/lib/ai/tools/page-read-tools.ts` for page reading and listing AI tools.
  - **Added**: `apps/web/src/lib/ai/tools/page-write-tools.ts` for page writing and modification AI tools.
  - **Updated**: `apps/web/src/lib/ai/ai-tools.ts` to be an index file that exports all tools.
  - **Rationale**: Improves maintainability and readability of the AI tool definitions.

### 2025-08-21

- **Refactor**: Renamed API endpoints for clarity and semantic accuracy
  - **Changed**: `/api/conversations` → `/api/ai_conversations` to distinguish from human messaging
  - **Rationale**: Clear separation between AI conversations (user ↔ assistant) and channel conversations (user ↔ user)
  - **Updated**: All frontend references in components, stores, and utilities (16 total references)
  - **Updated**: API documentation to reflect new naming convention
  - **Impact**: Better developer experience with clearer API naming that matches functionality

### 2025-08-15

- **Feature**: Implemented Dashboard-Level AI Chat
  - **Added**: New `dashboard_chat_messages` table for user-specific AI conversations
  - **Added**: Dashboard AI chat API routes (`/api/ai/dashboard-chat` and `/api/ai/dashboard-chat/messages`)
  - **Added**: `DashboardAiChatView` component replacing the vibe page at dashboard level
  - **Added**: Support functions in `assistant-utils.ts` for dashboard message conversion and persistence
  - **Enhanced**: Multi-provider AI support (OpenRouter, Google AI) at dashboard level
  - **Added**: User-specific AI assistant with workspace-wide context and tools
  - **Replaced**: UserDashboardView with DashboardAiChatView for personal AI assistance
  - **Updated**: Documentation with new API routes, functions, and database schema

### 2025-08-14

- **Enhanced**: AI chat system with database-first message persistence
  - **Implemented**: True database-first architecture where each message is saved individually as created
  - **Fixed**: Message duplication issue when reopening AI conversations
  - **Added**: Individual message persistence (user messages saved immediately, AI responses saved on completion)
  - **Removed**: Bulk message saving that caused reinsertion of entire conversations
  - **Improved**: Message timestamp preservation and attribution tracking
  - **Enhanced**: Support for multi-user AI conversations with real-time collaboration
- **Cleaned up**: Legacy code and unnecessary complexity (300+ lines removed)
  - **Removed**: Entire `ChatStorageAdapter` abstraction layer (241 lines)
  - **Simplified**: Message loading with direct database queries instead of complex adapters
  - **Cleaned**: Excessive debug logging from AI chat components
  - **Updated**: Ollama references to use OpenRouter as default provider
  - **Optimized**: Debug endpoints to use direct database operations
  - **Improved**: Type safety and code readability throughout AI system
- **Added**: Comprehensive AI system documentation
  - **Added**: `/docs/2.0-architecture/2.4-api/ai.md` - Complete AI API documentation
  - **Added**: `/docs/2.0-architecture/2.6-features/ai-system.md` - AI system architecture documentation
  - **Documented**: Database-first persistence model, multi-user collaboration, and contextual intelligence
  - **Updated**: Documentation to reflect simplified, production-ready implementation
  - **Updated**: Table of contents to include AI documentation sections

### 2025-07-29

- **Removed**: Cloudflare tunnel and all related dependencies from the project to ensure a fully local, air-gapped implementation.
- **Changed**: Exposed ports for `web` and `realtime` services for local access.

### 2025-07-28


### 2025-07-28

- **Security**: Major authentication and session handling refactor for enhanced security:
  - **Added**: Comprehensive CSRF protection with secure token generation and validation
  - **Added**: Advanced rate limiting with progressive delays for authentication endpoints
  - **Added**: One-time refresh token rotation system for enhanced security
  - **Added**: Device and IP tracking for session monitoring
  - **Added**: Global session invalidation via token versioning
  - **Improved**: JWT implementation with proper issuer/audience validation
  - **Improved**: Secure cookie configuration with HttpOnly, Secure, and SameSite settings
  - **Added**: New `/api/auth/csrf` endpoint for CSRF token generation
  - **Enhanced**: Login and refresh endpoints with advanced security features
  - **Added**: Environment variables: `JWT_SECRET`, `CSRF_SECRET` for secure operations
  - **Fixed**: Lazy loading of environment variables to prevent build-time errors

### 2025-07-27

- **Feature**: Implemented a new customizable user dashboard.
### 2025-07-27

- Decoupled Ollama from the development environment to allow connecting to a local Ollama instance.
  - Replaced the default drive view with a "canvas page" style dashboard.

- **2025-07-27**:
  - **Fix**: Implemented a database-driven approach to prevent tool call sheets from re-opening. The `toolCallActioned` flag in the `assistantMessages` table is now used to control the UI, ensuring that the preview sheet is only shown for new, un-actioned tool calls.
- **2025-07-26**:

### 2025-07-27

# Changelog
### 2025-07-26

### 2025-07-26

- **Added**: Expanded the list of available Anthropic models.
### 2025-07-26

- **Added**: Expanded the list of available OpenRouter models.
### 2025-07-26


## 2025-07-26

- **Improved Ollama Integration**:
  - Integrated Ollama into the development environment for a streamlined setup.
  - The application now defaults to `http://ollama:11434` for the Ollama base URL.
  - This resolves the 400 Bad Request error and simplifies the local development experience.

## 2025-07-25

- **Updated Mention System**:
  - Implemented a unified content fetching system for all page types.
  - When a page is mentioned, its content will now be correctly injected into the context. This includes Canvas page content, channel messages, and a list of files for folders.
  - This resolves an issue where only document pages were being correctly processed.
## 2025-07-28

- Updated landing page to remove animations and add a notice about the pre-mvp alpha status with a link to the Discord server.
---
date: 2025-07-28
changes:
  - Created a new `@pagespace/prompts` package to handle all prompt-related logic.
  - Added a new `ai_prompts` table to the database for storing and managing prompt templates.
  - Refactored the `ai-page` and `ai-assistant` API routes to use the new prompt management system.
  - Implemented basic sanitization to prevent prompt injection.
  - Updated the system prompts documentation to reflect the new architecture.
---
## 2025-08-12

### Refactor
- Removed the custom navigation interceptor in favor of standard Next.js routing. This simplifies the codebase, improves performance, and eliminates navigation-related race conditions.
- Replaced `useNavigation`, `useNavigationInterceptor`, and `useNavigationStore` with `useParams` and `usePathname` from Next.js.
- Created a new `useDirtyStore` and `useUnsavedChanges` hook to handle unsaved changes, decoupling this logic from navigation.
- **Drive Assistant:**
  - Created a new `driveChatMessages` table to store chat messages for the drive assistant.
  - Created new API routes `POST /api/ai/drive-chat` and `GET /api/ai/drive-chat/messages` to handle drive-specific chat requests.
  - Created a new `DriveAiChatView` component to provide a chat interface for the drive assistant.
  - Integrated the `DriveAiChatView` into the drive dashboard page with a new "Assistant" tab.