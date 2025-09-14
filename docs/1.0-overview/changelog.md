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