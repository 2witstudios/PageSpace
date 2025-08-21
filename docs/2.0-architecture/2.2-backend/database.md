# Database Schema

This document outlines the complete database schema for PageSpace. The schema is implemented using Drizzle ORM with PostgreSQL and is organized into multiple schema files for better organization.

## Schema Overview

The database is organized into the following schema files:
- `core.ts`: Main entities (drives, pages, tags, favorites, mentions, chat messages)
- `auth.ts`: Authentication and user management (users, refresh tokens, MCP tokens)
- `ai.ts`: AI provider settings and configurations
- `permissions.ts`: Access control and permissions system
- `members.ts`: Drive membership and collaboration features
- `conversations.ts`: Unified conversation and messaging system
- `dashboard.ts`: User dashboard customization
- `notifications.ts`: System notifications
- `monitoring.ts`: Logging, analytics, and performance monitoring

## Authentication & Users

### Table: `users`

**Purpose:** Stores user account information and authentication data.

**Columns:**
- `id`: `text` (Primary Key) - Unique identifier for the user (CUID2)
- `name`: `text` - The user's display name
- `email`: `text` (Unique) - The user's email address (used for authentication)
- `emailVerified`: `timestamp` - When the user's email was verified (future use)
- `image`: `text` - A URL for the user's profile image (optional)
- `password`: `text` - The user's bcrypt-hashed password (optional for Google auth)
- `googleId`: `text` (Unique) - Google OAuth ID for Google authentication
- `provider`: `authProvider` ENUM - Authentication provider: 'email', 'google', 'both'
- `tokenVersion`: `integer` (Default: 0) - Version number for JWT tokens
- `role`: `userRole` ENUM - User role: 'user', 'admin'
- `currentAiProvider`: `text` (Default: 'pagespace') - Current AI provider selection
- `currentAiModel`: `text` (Default: 'qwen/qwen3-coder:free') - Current AI model selection

**Authentication Notes:**
- Supports both email/password and Google OAuth authentication
- Passwords are hashed using bcryptjs with secure salt rounds
- `tokenVersion` enables global session invalidation (e.g., on security breach)
- Email uniqueness is enforced at database level

### Table: `refresh_tokens`

**Purpose:** Stores one-time refresh tokens for secure session management with token rotation.

**Columns:**
- `id`: `text` (Primary Key) - Unique identifier for the refresh token (CUID2)
- `userId`: `text` (Foreign Key to `users.id`) - The ID of the user the token belongs to
- `token`: `text` (Unique) - The JWT refresh token (deleted after use for security)
- `device`: `text` - The device description from User-Agent header
- `ip`: `text` - The IP address where the token was issued
- `userAgent`: `text` - Full User-Agent string for device tracking
- `createdAt`: `timestamp` (Default: now) - When the token was created

**Security Features:**
- One-time use tokens: deleted immediately after successful refresh
- Device and IP tracking for security monitoring
- Automatic cleanup on token version mismatch
- Cascading delete when user is removed

### Table: `mcp_tokens`

**Purpose:** Stores MCP (Model Context Protocol) authentication tokens for API access.

**Columns:**
- `id`: `text` (Primary Key) - Unique identifier for the MCP token
- `userId`: `text` (Foreign Key to `users.id`) - The ID of the user who owns the token
- `token`: `text` (Unique) - The actual token string
- `name`: `text` - Human-readable name for the token
- `lastUsed`: `timestamp` - When the token was last used
- `createdAt`: `timestamp` - When the token was created
- `revokedAt`: `timestamp` - When the token was revoked (if applicable)

## Core Content Management

### Table: `drives`

**Purpose:** Stores information about drives (workspaces).

**Columns:**
- `id`: `text` (Primary Key) - Unique identifier for the drive
- `name`: `text` - The name of the drive
- `slug`: `text` - The URL slug of the drive
- `ownerId`: `text` (Foreign Key to `users.id`) - The ID of the user who owns the drive
- `createdAt`: `timestamp` - When the drive was created
- `updatedAt`: `timestamp` - When the drive was last updated

**Indexes:**
- `drives_owner_id_idx` on `ownerId`
- `drives_owner_id_slug_key` on `ownerId, slug` (unique constraint)

### Table: `pages`

**Purpose:** Stores the pages of content across all page types.

**Columns:**
- `id`: `text` (Primary Key) - Unique identifier for the page
- `title`: `text` - The title of the page
- `type`: `pageType` ENUM - Page type: 'FOLDER', 'DOCUMENT', 'DATABASE', 'CHANNEL', 'AI_CHAT', 'CANVAS'
- `content`: `text` (Default: '') - The content of the page
- `position`: `real` - The position of the page within its parent
- `isTrashed`: `boolean` (Default: false) - Whether the page is in the trash
- `aiProvider`: `text` - AI provider for AI-enabled pages
- `aiModel`: `text` - AI model for AI-enabled pages
- `createdAt`: `timestamp` - When the page was created
- `updatedAt`: `timestamp` - When the page was last updated
- `trashedAt`: `timestamp` - When the page was trashed
- `driveId`: `text` (Foreign Key to `drives.id`) - The ID of the drive the page belongs to
- `parentId`: `text` (Foreign Key to `pages.id`) - The ID of the parent page
- `originalParentId`: `text` - The original parent ID before trashing

**Indexes:**
- `pages_drive_id_idx` on `driveId`
- `pages_parent_id_idx` on `parentId`
- `pages_parent_id_position_idx` on `parentId, position`

### Table: `chat_messages`

**Purpose:** Stores AI chat messages for page-level conversations.

**Columns:**
- `id`: `text` (Primary Key) - Unique identifier for the chat message
- `pageId`: `text` (Foreign Key to `pages.id`) - The ID of the page the message is associated with
- `role`: `text` - The role of the message sender ('user', 'assistant', 'system')
- `content`: `text` - The text content of the message
- `toolCalls`: `jsonb` - JSON array of tool calls made during the conversation
- `toolResults`: `jsonb` - JSON array of tool call results
- `createdAt`: `timestamp` - When the message was created
- `isActive`: `boolean` (Default: true) - Whether the message is active (not deleted)
- `editedAt`: `timestamp` - When the message was last edited
- `userId`: `text` (Foreign Key to `users.id`) - The ID of the user who sent the message (null for assistant messages)
- `agentRole`: `text` (Default: 'PARTNER') - The role of the AI agent

**Indexes:**
- `chat_messages_page_id_idx` on `pageId`
- `chat_messages_user_id_idx` on `userId`
- `chat_messages_page_id_is_active_created_at_idx` on `pageId, isActive, createdAt`

### Table: `channel_messages`

**Purpose:** Stores real-time chat messages for channel pages.

**Columns:**
- `id`: `text` (Primary Key) - Unique identifier for the channel message
- `content`: `text` - The message content
- `createdAt`: `timestamp` - When the message was created
- `pageId`: `text` (Foreign Key to `pages.id`) - The channel page ID
- `userId`: `text` (Foreign Key to `users.id`) - The user who sent the message

**Indexes:**
- `channel_messages_page_id_idx` on `pageId`

### Table: `tags`

**Purpose:** Stores content tags for categorization.

**Columns:**
- `id`: `text` (Primary Key) - Unique identifier for the tag
- `name`: `text` (Unique) - The name of the tag
- `color`: `text` - The color of the tag (hex or color name)

### Table: `page_tags`

**Purpose:** A join table that connects pages and tags (many-to-many relationship).

**Columns:**
- `pageId`: `text` (Foreign Key to `pages.id`) - The ID of the page
- `tagId`: `text` (Foreign Key to `tags.id`) - The ID of the tag

**Primary Key:** Composite key on `pageId, tagId`

### Table: `favorites`

**Purpose:** Stores user favorites for quick access.

**Columns:**
- `id`: `text` (Primary Key) - Unique identifier for the favorite
- `userId`: `text` (Foreign Key to `users.id`) - The ID of the user
- `pageId`: `text` (Foreign Key to `pages.id`) - The ID of the page

**Indexes:**
- `favorites_user_id_page_id_key` on `userId, pageId`

### Table: `mentions`

**Purpose:** Stores mentions/references between pages for linking and backlinks.

**Columns:**
- `id`: `text` (Primary Key) - Unique identifier for the mention
- `createdAt`: `timestamp` - When the mention was created
- `sourcePageId`: `text` (Foreign Key to `pages.id`) - The ID of the page where the mention was made
- `targetPageId`: `text` (Foreign Key to `pages.id`) - The ID of the page that was mentioned

**Indexes:**
- `mentions_source_page_id_target_page_id_key` on `sourcePageId, targetPageId`
- `mentions_source_page_id_idx` on `sourcePageId`
- `mentions_target_page_id_idx` on `targetPageId`

## AI Configuration

### Table: `user_ai_settings`

**Purpose:** Stores user-specific AI provider configurations and API keys.

**Columns:**
- `id`: `text` (Primary Key) - Unique identifier for the AI setting
- `userId`: `text` (Foreign Key to `users.id`) - The ID of the user
- `provider`: `text` - AI provider name ('openai', 'anthropic', 'google', 'ollama')
- `encryptedApiKey`: `text` - Encrypted API key for the provider
- `baseUrl`: `text` - Custom base URL for the provider (e.g., for Ollama)
- `createdAt`: `timestamp` - When the setting was created
- `updatedAt`: `timestamp` - When the setting was last updated

**Constraints:**
- `user_provider_unique` constraint on `userId, provider` (one setting per provider per user)

## Permissions & Access Control

### Table: `permissions`

**Purpose:** Stores granular permissions for pages (legacy system).

**Columns:**
- `id`: `text` (Primary Key) - Unique identifier for the permission
- `action`: `permissionAction` ENUM - The action: 'VIEW', 'EDIT', 'SHARE', 'DELETE'
- `subjectType`: `subjectType` ENUM - The subject type: 'USER'
- `subjectId`: `text` - The ID of the subject (user)
- `pageId`: `text` (Foreign Key to `pages.id`) - The ID of the page
- `createdAt`: `timestamp` - When the permission was granted

**Indexes:**
- `permissions_page_id_idx` on `pageId`
- `permissions_subject_id_subject_type_idx` on `subjectId, subjectType`
- `permissions_page_id_subject_id_subject_type_idx` on `pageId, subjectId, subjectType`

## Collaboration & Membership

### Table: `user_profiles`

**Purpose:** Extended user profiles for discovery and collaboration.

**Columns:**
- `userId`: `text` (Primary Key, Foreign Key to `users.id`) - The user ID
- `username`: `text` (Unique) - Unique username for the user
- `displayName`: `text` - Display name for the user
- `bio`: `text` - User biography
- `avatarUrl`: `text` - Avatar image URL
- `isPublic`: `boolean` (Default: false) - Whether the profile is public
- `createdAt`: `timestamp` - When the profile was created
- `updatedAt`: `timestamp` - When the profile was last updated

**Indexes:**
- `user_profiles_username_idx` on `username`
- `user_profiles_is_public_idx` on `isPublic`

### Table: `drive_members`

**Purpose:** Tracks all users with access to a drive and their roles.

**Columns:**
- `id`: `text` (Primary Key) - Unique identifier for the membership
- `driveId`: `text` (Foreign Key to `drives.id`) - The drive ID
- `userId`: `text` (Foreign Key to `users.id`) - The user ID
- `role`: `memberRole` ENUM (Default: 'MEMBER') - Role: 'OWNER', 'ADMIN', 'MEMBER'
- `invitedBy`: `text` (Foreign Key to `users.id`) - Who invited this user
- `invitedAt`: `timestamp` - When the user was invited
- `acceptedAt`: `timestamp` - When the invitation was accepted
- `lastAccessedAt`: `timestamp` - When the user last accessed the drive

**Constraints:**
- `drive_members_drive_user_key` unique constraint on `driveId, userId`

**Indexes:**
- `drive_members_drive_id_idx` on `driveId`
- `drive_members_user_id_idx` on `userId`
- `drive_members_role_idx` on `role`

### Table: `drive_invitations`

**Purpose:** Manages pending drive invitations.

**Columns:**
- `id`: `text` (Primary Key) - Unique identifier for the invitation
- `driveId`: `text` (Foreign Key to `drives.id`) - The drive ID
- `email`: `text` - Email address of the invitee
- `userId`: `text` (Foreign Key to `users.id`) - User ID if they have an account
- `invitedBy`: `text` (Foreign Key to `users.id`) - Who sent the invitation
- `status`: `invitationStatus` ENUM (Default: 'PENDING') - Status: 'PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED'
- `token`: `text` (Unique) - Unique invitation token
- `message`: `text` - Optional message from the inviter
- `expiresAt`: `timestamp` - When the invitation expires
- `createdAt`: `timestamp` - When the invitation was created
- `respondedAt`: `timestamp` - When the invitation was responded to

**Indexes:**
- `drive_invitations_drive_id_idx` on `driveId`
- `drive_invitations_email_idx` on `email`
- `drive_invitations_status_idx` on `status`
- `drive_invitations_token_idx` on `token`

### Table: `page_permissions`

**Purpose:** Enhanced boolean-based permissions system for pages.

**Columns:**
- `id`: `text` (Primary Key) - Unique identifier for the permission
- `pageId`: `text` (Foreign Key to `pages.id`) - The page ID
- `userId`: `text` (Foreign Key to `users.id`) - The user ID
- `canView`: `boolean` (Default: false) - Can view the page
- `canEdit`: `boolean` (Default: false) - Can edit the page
- `canShare`: `boolean` (Default: false) - Can share the page
- `canDelete`: `boolean` (Default: false) - Can delete the page
- `grantedBy`: `text` (Foreign Key to `users.id`) - Who granted the permission
- `grantedAt`: `timestamp` - When the permission was granted
- `expiresAt`: `timestamp` - When the permission expires (optional)
- `note`: `text` - Optional note about the permission

**Constraints:**
- `page_permissions_page_user_key` unique constraint on `pageId, userId`

**Indexes:**
- `page_permissions_page_id_idx` on `pageId`
- `page_permissions_user_id_idx` on `userId`
- `page_permissions_expires_at_idx` on `expiresAt`

## Unified Conversations

### Table: `conversations`

**Purpose:** Unified conversations table for all chat types (global, page-specific, drive-specific).

**Columns:**
- `id`: `text` (Primary Key) - Unique identifier for the conversation
- `userId`: `text` (Foreign Key to `users.id`) - The conversation owner
- `title`: `text` - Auto-generated or user-defined title
- `type`: `text` - Conversation type: 'global', 'page', 'drive'
- `contextId`: `text` - Context ID (null for global, pageId for page chats, driveId for drive chats)
- `lastMessageAt`: `timestamp` - Timestamp of the last message
- `createdAt`: `timestamp` - When the conversation was created
- `updatedAt`: `timestamp` - When the conversation was last updated
- `isActive`: `boolean` (Default: true) - Whether the conversation is active

**Indexes:**
- `conversations_user_id_idx` on `userId`
- `conversations_user_id_type_idx` on `userId, type`
- `conversations_user_id_last_message_at_idx` on `userId, lastMessageAt`
- `conversations_context_id_idx` on `contextId`

### Table: `messages`

**Purpose:** Unified messages table for all conversation types.

**Columns:**
- `id`: `text` (Primary Key) - Unique identifier for the message
- `conversationId`: `text` (Foreign Key to `conversations.id`) - The conversation ID
- `userId`: `text` (Foreign Key to `users.id`) - The user who sent the message
- `role`: `text` - Message role: 'user', 'assistant'
- `content`: `text` - The message content
- `toolCalls`: `jsonb` - JSON array of tool calls
- `toolResults`: `jsonb` - JSON array of tool call results
- `createdAt`: `timestamp` - When the message was created
- `isActive`: `boolean` (Default: true) - Whether the message is active
- `agentRole`: `text` (Default: 'PARTNER') - The AI agent role
- `editedAt`: `timestamp` - When the message was last edited

**Indexes:**
- `messages_conversation_id_idx` on `conversationId`
- `messages_conversation_id_created_at_idx` on `conversationId, createdAt`
- `messages_user_id_idx` on `userId`

## User Dashboards

### Table: `user_dashboards`

**Purpose:** Stores custom layout for user's personal dashboard.

**Columns:**
- `id`: `text` (Primary Key) - Unique identifier for the dashboard
- `userId`: `text` (Unique, Foreign Key to `users.id`) - The user ID
- `content`: `text` (Default: '') - The HTML content of the dashboard
- `createdAt`: `timestamp` - When the dashboard was created
- `updatedAt`: `timestamp` - When the dashboard was last updated

## Notifications

### Table: `notifications`

**Purpose:** System notifications for users about various events.

**Columns:**
- `id`: `text` (Primary Key) - Unique identifier for the notification
- `userId`: `text` (Foreign Key to `users.id`) - The user receiving the notification
- `type`: `notificationType` ENUM - Notification type: 'PERMISSION_GRANTED', 'PERMISSION_REVOKED', 'PERMISSION_UPDATED', 'PAGE_SHARED', 'DRIVE_INVITED', 'DRIVE_JOINED', 'DRIVE_ROLE_CHANGED'
- `title`: `text` - Notification title
- `message`: `text` - Notification message
- `metadata`: `jsonb` - Additional metadata
- `isRead`: `boolean` (Default: false) - Whether the notification has been read
- `createdAt`: `timestamp` - When the notification was created
- `readAt`: `timestamp` - When the notification was read
- `pageId`: `text` (Foreign Key to `pages.id`) - Related page ID (optional)
- `driveId`: `text` (Foreign Key to `drives.id`) - Related drive ID (optional)
- `triggeredByUserId`: `text` (Foreign Key to `users.id`) - User who triggered the notification

**Indexes:**
- `notifications_user_id_idx` on `userId`
- `notifications_user_id_is_read_idx` on `userId, isRead`
- `notifications_created_at_idx` on `createdAt`
- `notifications_type_idx` on `type`

## Monitoring & Analytics

### Table: `system_logs`

**Purpose:** Structured application logs for debugging and monitoring.

**Columns:**
- `id`: `text` (Primary Key) - Unique log entry ID
- `timestamp`: `timestamp` - When the log was created
- `level`: `logLevelEnum` - Log level: 'trace', 'debug', 'info', 'warn', 'error', 'fatal'
- `message`: `text` - Log message
- `category`: `text` - Log category (auth, api, ai, database, etc.)
- `userId`: `text` - Associated user ID
- `sessionId`: `text` - Session ID
- `requestId`: `text` - Request ID for tracing
- `driveId`: `text` - Associated drive ID
- `pageId`: `text` - Associated page ID
- `endpoint`: `text` - API endpoint
- `method`: `httpMethodEnum` - HTTP method: 'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'
- `ip`: `text` - Client IP address
- `userAgent`: `text` - User agent string
- `errorName`: `text` - Error name
- `errorMessage`: `text` - Error message
- `errorStack`: `text` - Error stack trace
- `duration`: `integer` - Request duration in milliseconds
- `memoryUsed`: `integer` - Memory used in MB
- `memoryTotal`: `integer` - Total memory in MB
- `metadata`: `jsonb` - Additional metadata
- `hostname`: `text` - Server hostname
- `pid`: `integer` - Process ID
- `version`: `text` - Application version

### Table: `api_metrics`

**Purpose:** Track all API requests for performance monitoring.

**Columns:**
- `id`: `text` (Primary Key) - Unique metric ID
- `timestamp`: `timestamp` - Request timestamp
- `endpoint`: `text` - API endpoint path
- `method`: `httpMethodEnum` - HTTP method
- `statusCode`: `integer` - HTTP status code
- `duration`: `integer` - Request duration in milliseconds
- `requestSize`: `integer` - Request size in bytes
- `responseSize`: `integer` - Response size in bytes
- `userId`: `text` - User ID
- `sessionId`: `text` - Session ID
- `ip`: `text` - Client IP
- `userAgent`: `text` - User agent
- `error`: `text` - Error message if any
- `requestId`: `text` - Request ID
- `cacheHit`: `boolean` (Default: false) - Whether request was served from cache
- `cacheKey`: `text` - Cache key used

### Table: `user_activities`

**Purpose:** Track user interactions and activities.

**Columns:**
- `id`: `text` (Primary Key) - Unique activity ID
- `timestamp`: `timestamp` - Activity timestamp
- `userId`: `text` - User ID
- `sessionId`: `text` - Session ID
- `action`: `text` - Action performed (create, read, update, delete, share, etc.)
- `resource`: `text` - Resource type (page, drive, etc.)
- `resourceId`: `text` - Resource ID
- `driveId`: `text` - Drive context
- `pageId`: `text` - Page context
- `metadata`: `jsonb` - Additional activity data
- `ip`: `text` - Client IP
- `userAgent`: `text` - User agent

### Table: `ai_usage_logs`

**Purpose:** Track AI provider usage for cost monitoring and analytics.

**Columns:**
- `id`: `text` (Primary Key) - Unique usage log ID
- `timestamp`: `timestamp` - Usage timestamp
- `userId`: `text` - User ID
- `sessionId`: `text` - Session ID
- `provider`: `text` - AI provider (openrouter, google, anthropic, openai, ollama)
- `model`: `text` - AI model used
- `inputTokens`: `integer` - Input tokens used
- `outputTokens`: `integer` - Output tokens generated
- `totalTokens`: `integer` - Total tokens
- `cost`: `real` - Cost in dollars
- `currency`: `text` (Default: 'USD') - Currency
- `duration`: `integer` - Request duration in milliseconds
- `streamingDuration`: `integer` - Streaming duration in milliseconds
- `conversationId`: `text` - Conversation ID
- `messageId`: `text` - Message ID
- `pageId`: `text` - Page context
- `driveId`: `text` - Drive context
- `prompt`: `text` - First 1000 chars of prompt
- `completion`: `text` - First 1000 chars of completion
- `success`: `boolean` (Default: true) - Whether the request succeeded
- `error`: `text` - Error message if any
- `metadata`: `jsonb` - Additional metadata

### Table: `performance_metrics`

**Purpose:** Track application performance metrics.

**Columns:**
- `id`: `text` (Primary Key) - Unique metric ID
- `timestamp`: `timestamp` - Metric timestamp
- `metric`: `text` - Metric name (page_load, db_query, file_upload, etc.)
- `value`: `real` - Metric value
- `unit`: `text` - Value unit (ms, bytes, count, percent)
- `userId`: `text` - User context
- `sessionId`: `text` - Session context
- `pageId`: `text` - Page context
- `driveId`: `text` - Drive context
- `metadata`: `jsonb` - Additional metric data
- `cpuUsage`: `real` - CPU usage percentage
- `memoryUsage`: `real` - Memory usage in MB
- `diskUsage`: `real` - Disk usage in MB

### Table: `error_logs`

**Purpose:** Detailed error tracking and debugging.

**Columns:**
- `id`: `text` (Primary Key) - Unique error ID
- `timestamp`: `timestamp` - Error timestamp
- `name`: `text` - Error name
- `message`: `text` - Error message
- `stack`: `text` - Error stack trace
- `userId`: `text` - User context
- `sessionId`: `text` - Session context
- `requestId`: `text` - Request context
- `endpoint`: `text` - API endpoint
- `method`: `httpMethodEnum` - HTTP method
- `file`: `text` - Source file
- `line`: `integer` - Line number
- `column`: `integer` - Column number
- `ip`: `text` - Client IP
- `userAgent`: `text` - User agent
- `metadata`: `jsonb` - Additional error data
- `resolved`: `boolean` (Default: false) - Whether error is resolved
- `resolvedAt`: `timestamp` - Resolution timestamp
- `resolvedBy`: `text` - Who resolved the error
- `resolution`: `text` - Resolution description

### Table: `daily_aggregates`

**Purpose:** Pre-computed daily statistics for dashboard analytics.

**Columns:**
- `id`: `text` (Primary Key) - Unique aggregate ID
- `date`: `timestamp` - Date of the aggregation
- `category`: `text` - Category (api, ai, performance, errors)
- `totalCount`: `integer` (Default: 0) - Total count
- `successCount`: `integer` (Default: 0) - Success count
- `errorCount`: `integer` (Default: 0) - Error count
- `avgDuration`: `real` - Average duration in milliseconds
- `minDuration`: `real` - Minimum duration
- `maxDuration`: `real` - Maximum duration
- `p50Duration`: `real` - 50th percentile duration
- `p95Duration`: `real` - 95th percentile duration
- `p99Duration`: `real` - 99th percentile duration
- `uniqueUsers`: `integer` (Default: 0) - Unique users count
- `uniqueSessions`: `integer` (Default: 0) - Unique sessions count
- `totalTokens`: `integer` - Total AI tokens used
- `totalCost`: `real` - Total AI cost
- `metadata`: `jsonb` - Additional aggregate data
- `computedAt`: `timestamp` - When aggregation was computed

### Table: `alert_history`

**Purpose:** Track system alerts and notifications.

**Columns:**
- `id`: `text` (Primary Key) - Unique alert ID
- `timestamp`: `timestamp` - Alert timestamp
- `type`: `text` - Alert type (error_rate, performance, ai_cost, security)
- `severity`: `text` - Severity level (info, warning, error, critical)
- `message`: `text` - Alert message
- `threshold`: `real` - Alert threshold value
- `actualValue`: `real` - Actual value that triggered alert
- `notified`: `boolean` (Default: false) - Whether notification was sent
- `notifiedAt`: `timestamp` - Notification timestamp
- `notificationChannel`: `text` - Notification channel (email, webhook, slack)
- `acknowledged`: `boolean` (Default: false) - Whether alert was acknowledged
- `acknowledgedAt`: `timestamp` - Acknowledgment timestamp
- `acknowledgedBy`: `text` - Who acknowledged the alert
- `metadata`: `jsonb` - Additional alert data

## Database Relationships

The schema includes comprehensive foreign key relationships:

- **Users** can have multiple drives, pages, messages, notifications, AI settings, and tokens
- **Drives** contain pages and have members with different roles
- **Pages** form hierarchical structures with parent-child relationships
- **Conversations** link to pages or drives for contextual chat
- **Permissions** provide granular access control at page and drive levels
- **Monitoring tables** track all system activities for analytics and debugging

## Security Features

- **Cascading deletes** ensure data consistency when users or drives are removed
- **Encrypted API keys** for AI providers stored securely
- **Token rotation** for refresh tokens with device tracking
- **Permission inheritance** through drive membership and explicit page permissions
- **Audit trails** through comprehensive logging and activity tracking
- **Role-based access control** at multiple levels (system, drive, page)

## Performance Optimizations

- **Strategic indexing** on frequently queried columns
- **Composite indexes** for complex queries
- **Pre-computed aggregates** for dashboard analytics
- **Efficient foreign key relationships** to minimize join costs
- **Timestamps with automatic updates** for change tracking