/**
 * Audit Trail and Versioning Schema for PageSpace
 *
 * This schema provides comprehensive tracking of all user and AI actions,
 * content versioning, and AI operation attribution. It supports:
 * - Complete audit trail of all system changes
 * - Page content versioning with full snapshots
 * - AI agent attribution and operation tracking
 * - Drive-scoped access control
 * - Efficient querying for activity feeds and reports
 */

import {
  pgTable,
  text,
  timestamp,
  jsonb,
  integer,
  boolean,
  pgEnum,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';
import { pages, drives } from './core';

// ============================================================================
// ENUMS
// ============================================================================

/**
 * Types of actions that can be audited
 */
export const auditActionType = pgEnum('audit_action_type', [
  // Page operations
  'PAGE_CREATE',
  'PAGE_UPDATE',
  'PAGE_DELETE',
  'PAGE_RESTORE',
  'PAGE_MOVE',
  'PAGE_RENAME',
  'PAGE_DUPLICATE',

  // Permission operations
  'PERMISSION_GRANT',
  'PERMISSION_REVOKE',
  'PERMISSION_UPDATE',

  // Drive operations
  'DRIVE_CREATE',
  'DRIVE_UPDATE',
  'DRIVE_DELETE',
  'DRIVE_RESTORE',

  // Member operations
  'MEMBER_ADD',
  'MEMBER_REMOVE',
  'MEMBER_UPDATE_ROLE',

  // File operations
  'FILE_UPLOAD',
  'FILE_DELETE',
  'FILE_UPDATE',

  // Channel/Message operations
  'MESSAGE_CREATE',
  'MESSAGE_UPDATE',
  'MESSAGE_DELETE',

  // AI operations
  'AI_EDIT',
  'AI_GENERATE',
  'AI_TOOL_CALL',
  'AI_CONVERSATION',

  // Other
  'SETTINGS_UPDATE',
  'EXPORT',
  'IMPORT',
]);

/**
 * Types of entities that can be audited
 */
export const auditEntityType = pgEnum('audit_entity_type', [
  'PAGE',
  'DRIVE',
  'PERMISSION',
  'MEMBER',
  'FILE',
  'MESSAGE',
  'SETTINGS',
  'AI_OPERATION',
]);

/**
 * Types of AI agents that can perform actions
 */
export const aiAgentType = pgEnum('ai_agent_type', [
  'ASSISTANT',      // General assistant
  'EDITOR',         // Content editing
  'RESEARCHER',     // Information gathering
  'CODER',          // Code generation
  'ANALYST',        // Data analysis
  'WRITER',         // Content creation
  'REVIEWER',       // Content review
  'CUSTOM',         // User-defined agent
]);

// ============================================================================
// TABLES
// ============================================================================

/**
 * Audit Events - Master log of all actions in the system
 *
 * This table captures every meaningful action, whether performed by a user
 * or an AI agent. It provides the foundation for:
 * - Activity feeds
 * - Compliance and security auditing
 * - User action history
 * - AI attribution
 * - Undo/redo functionality (future)
 *
 * Performance Considerations:
 * - Indexed on driveId for drive-scoped queries
 * - Indexed on userId + createdAt for user activity feeds
 * - Indexed on entityType + entityId for entity-specific history
 * - Composite index on driveId + createdAt for drive activity feeds
 * - JSONB GIN index on metadata for flexible querying
 */
export const auditEvents = pgTable('audit_events', {
  id: text('id').primaryKey().$defaultFn(() => createId()),

  // Action details
  actionType: auditActionType('action_type').notNull(),
  entityType: auditEntityType('entity_type').notNull(),
  entityId: text('entity_id').notNull(),

  // Actor - who performed the action
  userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
  isAiAction: boolean('is_ai_action').default(false).notNull(),
  aiOperationId: text('ai_operation_id'), // Link to AI operation if AI-initiated

  // Scope - for access control
  driveId: text('drive_id').references(() => drives.id, { onDelete: 'cascade' }),

  // Change tracking
  beforeState: jsonb('before_state'), // Previous state of the entity
  afterState: jsonb('after_state'),   // New state of the entity
  changes: jsonb('changes'),          // Specific fields that changed with old/new values

  // Context
  description: text('description'),   // Human-readable description
  reason: text('reason'),            // Why the change was made (from AI prompt or user input)
  metadata: jsonb('metadata'),       // Additional context (IP, user agent, etc.)

  // Request context
  requestId: text('request_id'),     // Correlate multiple events from same request
  sessionId: text('session_id'),     // User session
  ipAddress: text('ip_address'),     // Source IP
  userAgent: text('user_agent'),     // Browser/client info

  // Grouping - for bulk operations
  operationId: text('operation_id'), // Group related changes (e.g., one AI prompt -> many edits)
  parentEventId: text('parent_event_id'), // For nested operations

  // Timestamps
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
}, (table) => ({
  // Core indexes for common queries
  driveCreatedIdx: index('audit_events_drive_created_idx').on(table.driveId, table.createdAt),
  userCreatedIdx: index('audit_events_user_created_idx').on(table.userId, table.createdAt),
  entityIdx: index('audit_events_entity_idx').on(table.entityType, table.entityId, table.createdAt),

  // Filtering indexes
  actionTypeIdx: index('audit_events_action_type_idx').on(table.actionType),
  isAiActionIdx: index('audit_events_is_ai_action_idx').on(table.isAiAction, table.createdAt),
  aiOperationIdx: index('audit_events_ai_operation_idx').on(table.aiOperationId),

  // Grouping indexes
  operationIdIdx: index('audit_events_operation_id_idx').on(table.operationId),
  requestIdIdx: index('audit_events_request_id_idx').on(table.requestId),

  // Time-series index for cleanup/archival
  createdAtIdx: index('audit_events_created_at_idx').on(table.createdAt),
}));

/**
 * Page Versions - Historical snapshots of page content
 *
 * This table stores complete snapshots of page content at specific points in time,
 * enabling:
 * - Version history browsing
 * - Content restoration
 * - Diff viewing (comparing versions)
 * - Recovery from accidental changes
 *
 * Design Decisions:
 * - Full snapshots (not diffs) for simplicity and reliability
 * - Content stored as JSONB for flexibility
 * - Linked to audit event that triggered the version
 * - Version number for easy reference
 *
 * Performance Considerations:
 * - Indexed on pageId + versionNumber for version browsing
 * - Indexed on pageId + createdAt for chronological access
 * - Could implement archival for very old versions
 */
export const pageVersions = pgTable('page_versions', {
  id: text('id').primaryKey().$defaultFn(() => createId()),

  // Page reference
  pageId: text('page_id').notNull().references(() => pages.id, { onDelete: 'cascade' }),

  // Version tracking
  versionNumber: integer('version_number').notNull(), // Sequential version number

  // Content snapshot (stored as JSONB for flexibility)
  content: jsonb('content').notNull(),   // The actual content at this version
  title: text('title').notNull(),        // Page title at this version
  pageType: text('page_type').notNull(), // Page type at this version

  // Metadata snapshot
  metadata: jsonb('metadata'),           // Other page properties (aiModel, systemPrompt, etc.)

  // Change tracking
  auditEventId: text('audit_event_id').references(() => auditEvents.id, { onDelete: 'set null' }),
  createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
  isAiGenerated: boolean('is_ai_generated').default(false).notNull(),

  // Size tracking (for storage optimization later)
  contentSize: integer('content_size'), // Size in bytes

  // Change summary
  changeSummary: text('change_summary'), // Brief description of what changed
  changeType: text('change_type'),       // 'minor', 'major', 'ai_edit', 'user_edit'

  // Timestamps
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
}, (table) => ({
  // Primary lookup indexes
  pageVersionIdx: index('page_versions_page_version_idx').on(table.pageId, table.versionNumber),
  pageCreatedIdx: index('page_versions_page_created_idx').on(table.pageId, table.createdAt),

  // User tracking
  createdByIdx: index('page_versions_created_by_idx').on(table.createdBy, table.createdAt),

  // AI filtering
  isAiGeneratedIdx: index('page_versions_is_ai_generated_idx').on(table.isAiGenerated),

  // Audit link
  auditEventIdx: index('page_versions_audit_event_idx').on(table.auditEventId),

  // Time-series for archival
  createdAtIdx: index('page_versions_created_at_idx').on(table.createdAt),
}));

/**
 * AI Operations - Detailed tracking of AI agent actions
 *
 * This table provides detailed attribution for AI-initiated actions, including:
 * - The original user prompt
 * - AI agent type and model used
 * - All actions performed as part of the operation
 * - Conversation context
 *
 * Links to audit_events for specific actions taken.
 */
export const aiOperations = pgTable('ai_operations', {
  id: text('id').primaryKey().$defaultFn(() => createId()),

  // User who initiated the AI action
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),

  // AI details
  agentType: aiAgentType('agent_type').notNull(),
  provider: text('provider').notNull(),  // 'openai', 'anthropic', 'google', etc.
  model: text('model').notNull(),        // Specific model used

  // Operation context
  operationType: text('operation_type').notNull(), // 'edit', 'generate', 'analyze', 'tool_call'
  prompt: text('prompt'),                // Original user prompt
  systemPrompt: text('system_prompt'),   // System prompt used

  // Conversation context
  conversationId: text('conversation_id'), // Link to chat conversation
  messageId: text('message_id'),          // Specific message that triggered this

  // Scope
  driveId: text('drive_id').references(() => drives.id, { onDelete: 'cascade' }),
  pageId: text('page_id').references(() => pages.id, { onDelete: 'set null' }),

  // Tool usage
  toolsCalled: jsonb('tools_called'),    // Array of tools called during operation
  toolResults: jsonb('tool_results'),    // Results from tool calls

  // Results
  completion: text('completion'),         // AI response/completion
  actionsPerformed: jsonb('actions_performed'), // Summary of actions taken

  // Performance
  duration: integer('duration'),          // Milliseconds
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  totalCost: integer('total_cost'),       // Cost in cents

  // Status
  status: text('status').default('completed').notNull(), // 'in_progress', 'completed', 'failed', 'cancelled'
  error: text('error'),                   // Error message if failed

  // Metadata
  metadata: jsonb('metadata'),

  // Timestamps
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  completedAt: timestamp('completed_at', { mode: 'date' }),
}, (table) => ({
  // User tracking
  userCreatedIdx: index('ai_operations_user_created_idx').on(table.userId, table.createdAt),

  // Drive scoping
  driveCreatedIdx: index('ai_operations_drive_created_idx').on(table.driveId, table.createdAt),

  // Conversation tracking
  conversationIdx: index('ai_operations_conversation_idx').on(table.conversationId),
  messageIdx: index('ai_operations_message_idx').on(table.messageId),

  // Page tracking
  pageIdx: index('ai_operations_page_idx').on(table.pageId, table.createdAt),

  // Performance analysis
  agentTypeIdx: index('ai_operations_agent_type_idx').on(table.agentType, table.createdAt),
  providerModelIdx: index('ai_operations_provider_model_idx').on(table.provider, table.model),

  // Status filtering
  statusIdx: index('ai_operations_status_idx').on(table.status),

  // Time-series
  createdAtIdx: index('ai_operations_created_at_idx').on(table.createdAt),
}));

// ============================================================================
// RELATIONS
// ============================================================================

export const auditEventsRelations = relations(auditEvents, ({ one }) => ({
  user: one(users, {
    fields: [auditEvents.userId],
    references: [users.id],
  }),
  drive: one(drives, {
    fields: [auditEvents.driveId],
    references: [drives.id],
  }),
  aiOperation: one(aiOperations, {
    fields: [auditEvents.aiOperationId],
    references: [aiOperations.id],
  }),
  parentEvent: one(auditEvents, {
    fields: [auditEvents.parentEventId],
    references: [auditEvents.id],
    relationName: 'ParentChildEvents',
  }),
}));

export const pageVersionsRelations = relations(pageVersions, ({ one }) => ({
  page: one(pages, {
    fields: [pageVersions.pageId],
    references: [pages.id],
  }),
  auditEvent: one(auditEvents, {
    fields: [pageVersions.auditEventId],
    references: [auditEvents.id],
  }),
  createdByUser: one(users, {
    fields: [pageVersions.createdBy],
    references: [users.id],
  }),
}));

export const aiOperationsRelations = relations(aiOperations, ({ one }) => ({
  user: one(users, {
    fields: [aiOperations.userId],
    references: [users.id],
  }),
  drive: one(drives, {
    fields: [aiOperations.driveId],
    references: [drives.id],
  }),
  page: one(pages, {
    fields: [aiOperations.pageId],
    references: [pages.id],
  }),
}));
