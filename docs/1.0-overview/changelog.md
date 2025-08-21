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