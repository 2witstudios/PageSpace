/**
 * Database schema for monitoring, logging, and analytics
 */

import { 
  pgTable, 
  text, 
  timestamp, 
  integer, 
  boolean, 
  jsonb, 
  index,
  real,
  uuid,
  pgEnum
} from 'drizzle-orm/pg-core';
import { createId } from '@paralleldrive/cuid2';

// Enums
export const logLevelEnum = pgEnum('log_level', ['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
export const httpMethodEnum = pgEnum('http_method', ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);

/**
 * System logs - structured application logs
 */
export const systemLogs = pgTable('system_logs', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  timestamp: timestamp('timestamp', { mode: 'date' }).defaultNow().notNull(),
  level: logLevelEnum('level').notNull(),
  message: text('message').notNull(),
  category: text('category'), // auth, api, ai, database, etc.
  
  // Context
  userId: text('user_id'),
  sessionId: text('session_id'),
  requestId: text('request_id'),
  driveId: text('drive_id'),
  pageId: text('page_id'),
  
  // Request context
  endpoint: text('endpoint'),
  method: httpMethodEnum('method'),
  ip: text('ip'),
  userAgent: text('user_agent'),
  
  // Error details
  errorName: text('error_name'),
  errorMessage: text('error_message'),
  errorStack: text('error_stack'),
  
  // Performance
  duration: integer('duration'), // milliseconds
  memoryUsed: integer('memory_used'), // MB
  memoryTotal: integer('memory_total'), // MB
  
  // Additional metadata
  metadata: jsonb('metadata'),
  hostname: text('hostname'),
  pid: integer('pid'),
  version: text('version'),
}, (table) => ({
  timestampIdx: index('idx_system_logs_timestamp').on(table.timestamp),
  levelIdx: index('idx_system_logs_level').on(table.level),
  categoryIdx: index('idx_system_logs_category').on(table.category),
  userIdIdx: index('idx_system_logs_user_id').on(table.userId),
  requestIdIdx: index('idx_system_logs_request_id').on(table.requestId),
  errorIdx: index('idx_system_logs_error').on(table.errorName, table.timestamp),
}));

/**
 * API metrics - track all API requests
 */
export const apiMetrics = pgTable('api_metrics', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  timestamp: timestamp('timestamp', { mode: 'date' }).defaultNow().notNull(),
  
  // Request details
  endpoint: text('endpoint').notNull(),
  method: httpMethodEnum('method').notNull(),
  statusCode: integer('status_code').notNull(),
  
  // Performance
  duration: integer('duration').notNull(), // milliseconds
  requestSize: integer('request_size'), // bytes
  responseSize: integer('response_size'), // bytes
  
  // User context
  userId: text('user_id'),
  sessionId: text('session_id'),
  ip: text('ip'),
  userAgent: text('user_agent'),
  
  // Additional details
  error: text('error'),
  requestId: text('request_id'),
  
  // Caching
  cacheHit: boolean('cache_hit').default(false),
  cacheKey: text('cache_key'),
}, (table) => ({
  timestampIdx: index('idx_api_metrics_timestamp').on(table.timestamp),
  endpointIdx: index('idx_api_metrics_endpoint').on(table.endpoint, table.timestamp),
  userIdIdx: index('idx_api_metrics_user_id').on(table.userId, table.timestamp),
  statusCodeIdx: index('idx_api_metrics_status').on(table.statusCode, table.timestamp),
  durationIdx: index('idx_api_metrics_duration').on(table.duration),
}));

/**
 * User activities - track user interactions
 */
export const userActivities = pgTable('user_activities', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  timestamp: timestamp('timestamp', { mode: 'date' }).defaultNow().notNull(),
  
  // User
  userId: text('user_id').notNull(),
  sessionId: text('session_id'),
  
  // Activity
  action: text('action').notNull(), // create, read, update, delete, share, etc.
  resource: text('resource'), // page, drive, group, etc.
  resourceId: text('resource_id'),
  
  // Context
  driveId: text('drive_id'),
  pageId: text('page_id'),
  
  // Details
  metadata: jsonb('metadata'),
  ip: text('ip'),
  userAgent: text('user_agent'),
}, (table) => ({
  timestampIdx: index('idx_user_activities_timestamp').on(table.timestamp),
  userIdIdx: index('idx_user_activities_user_id').on(table.userId, table.timestamp),
  actionIdx: index('idx_user_activities_action').on(table.action, table.timestamp),
  resourceIdx: index('idx_user_activities_resource').on(table.resource, table.resourceId),
}));

/**
 * AI usage logs - track AI provider usage
 */
export const aiUsageLogs = pgTable('ai_usage_logs', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  timestamp: timestamp('timestamp', { mode: 'date' }).defaultNow().notNull(),
  
  // User
  userId: text('user_id').notNull(),
  sessionId: text('session_id'),
  
  // AI details
  provider: text('provider').notNull(), // openrouter, google, anthropic, openai, ollama
  model: text('model').notNull(),
  
  // Usage
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  totalTokens: integer('total_tokens'),
  
  // Cost
  cost: real('cost'), // in dollars
  currency: text('currency').default('USD'),
  
  // Performance
  duration: integer('duration'), // milliseconds
  streamingDuration: integer('streaming_duration'), // milliseconds
  
  // Context
  conversationId: text('conversation_id'),
  messageId: text('message_id'),
  pageId: text('page_id'),
  driveId: text('drive_id'),
  
  // Request/Response
  prompt: text('prompt'), // Store first 1000 chars
  completion: text('completion'), // Store first 1000 chars
  
  // Status
  success: boolean('success').default(true),
  error: text('error'),
  
  // Metadata
  metadata: jsonb('metadata'),

  // Context tracking - track actual conversation context vs billing tokens
  contextMessages: jsonb('context_messages'), // Array of message IDs included in this call's context
  contextSize: integer('context_size'), // Actual tokens in context (input + system prompt + tools)
  systemPromptTokens: integer('system_prompt_tokens'), // Tokens used by system prompt
  toolDefinitionTokens: integer('tool_definition_tokens'), // Tokens used by tool schemas
  conversationTokens: integer('conversation_tokens'), // Tokens from actual messages
  messageCount: integer('message_count'), // Number of messages in context
  wasTruncated: boolean('was_truncated').default(false), // Whether context was truncated
  truncationStrategy: text('truncation_strategy'), // 'none' | 'oldest_first' | 'smart'
}, (table) => ({
  timestampIdx: index('idx_ai_usage_timestamp').on(table.timestamp),
  userIdIdx: index('idx_ai_usage_user_id').on(table.userId, table.timestamp),
  providerIdx: index('idx_ai_usage_provider').on(table.provider, table.model, table.timestamp),
  costIdx: index('idx_ai_usage_cost').on(table.cost),
  conversationIdx: index('idx_ai_usage_conversation').on(table.conversationId),
  conversationContextIdx: index('idx_ai_usage_context').on(table.conversationId, table.timestamp),
  contextSizeIdx: index('idx_ai_usage_context_size').on(table.contextSize),
}));

/**
 * Performance metrics - track application performance
 */
export const performanceMetrics = pgTable('performance_metrics', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  timestamp: timestamp('timestamp', { mode: 'date' }).defaultNow().notNull(),
  
  // Metric details
  metric: text('metric').notNull(), // page_load, db_query, file_upload, etc.
  value: real('value').notNull(),
  unit: text('unit').notNull(), // ms, bytes, count, percent
  
  // Context
  userId: text('user_id'),
  sessionId: text('session_id'),
  pageId: text('page_id'),
  driveId: text('drive_id'),
  
  // Additional details
  metadata: jsonb('metadata'),
  
  // System metrics
  cpuUsage: real('cpu_usage'), // percentage
  memoryUsage: real('memory_usage'), // MB
  diskUsage: real('disk_usage'), // MB
}, (table) => ({
  timestampIdx: index('idx_performance_timestamp').on(table.timestamp),
  metricIdx: index('idx_performance_metric').on(table.metric, table.timestamp),
  valueIdx: index('idx_performance_value').on(table.value),
  userIdIdx: index('idx_performance_user_id').on(table.userId),
}));

/**
 * Error logs - detailed error tracking
 */
export const errorLogs = pgTable('error_logs', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  timestamp: timestamp('timestamp', { mode: 'date' }).defaultNow().notNull(),
  
  // Error details
  name: text('name').notNull(),
  message: text('message').notNull(),
  stack: text('stack'),
  
  // Context
  userId: text('user_id'),
  sessionId: text('session_id'),
  requestId: text('request_id'),
  
  // Location
  endpoint: text('endpoint'),
  method: httpMethodEnum('method'),
  file: text('file'),
  line: integer('line'),
  column: integer('column'),
  
  // Additional
  ip: text('ip'),
  userAgent: text('user_agent'),
  metadata: jsonb('metadata'),
  
  // Resolution
  resolved: boolean('resolved').default(false),
  resolvedAt: timestamp('resolved_at', { mode: 'date' }),
  resolvedBy: text('resolved_by'),
  resolution: text('resolution'),
}, (table) => ({
  timestampIdx: index('idx_errors_timestamp').on(table.timestamp),
  nameIdx: index('idx_errors_name').on(table.name, table.timestamp),
  userIdIdx: index('idx_errors_user_id').on(table.userId),
  resolvedIdx: index('idx_errors_resolved').on(table.resolved),
  endpointIdx: index('idx_errors_endpoint').on(table.endpoint),
}));

/**
 * Daily aggregates - pre-computed daily statistics
 */
export const dailyAggregates = pgTable('daily_aggregates', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  date: timestamp('date', { mode: 'date' }).notNull(),
  category: text('category').notNull(), // api, ai, performance, errors
  
  // Counts
  totalCount: integer('total_count').default(0),
  successCount: integer('success_count').default(0),
  errorCount: integer('error_count').default(0),
  
  // Performance
  avgDuration: real('avg_duration'), // milliseconds
  minDuration: real('min_duration'),
  maxDuration: real('max_duration'),
  p50Duration: real('p50_duration'),
  p95Duration: real('p95_duration'),
  p99Duration: real('p99_duration'),
  
  // Users
  uniqueUsers: integer('unique_users').default(0),
  uniqueSessions: integer('unique_sessions').default(0),
  
  // AI specific
  totalTokens: integer('total_tokens'),
  totalCost: real('total_cost'),
  
  // Metadata
  metadata: jsonb('metadata'),
  computedAt: timestamp('computed_at', { mode: 'date' }).defaultNow(),
}, (table) => ({
  dateIdx: index('idx_aggregates_date').on(table.date, table.category),
  categoryIdx: index('idx_aggregates_category').on(table.category),
}));

/**
 * Alert history - track system alerts
 */
export const alertHistory = pgTable('alert_history', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  timestamp: timestamp('timestamp', { mode: 'date' }).defaultNow().notNull(),

  // Alert details
  type: text('type').notNull(), // error_rate, performance, ai_cost, security
  severity: text('severity').notNull(), // info, warning, error, critical
  message: text('message').notNull(),

  // Thresholds
  threshold: real('threshold'),
  actualValue: real('actual_value'),

  // Notification
  notified: boolean('notified').default(false),
  notifiedAt: timestamp('notified_at', { mode: 'date' }),
  notificationChannel: text('notification_channel'), // email, webhook, slack

  // Resolution
  acknowledged: boolean('acknowledged').default(false),
  acknowledgedAt: timestamp('acknowledged_at', { mode: 'date' }),
  acknowledgedBy: text('acknowledged_by'),

  // Metadata
  metadata: jsonb('metadata'),
}, (table) => ({
  timestampIdx: index('idx_alerts_timestamp').on(table.timestamp),
  typeIdx: index('idx_alerts_type').on(table.type, table.timestamp),
  severityIdx: index('idx_alerts_severity').on(table.severity),
  acknowledgedIdx: index('idx_alerts_acknowledged').on(table.acknowledged),
}));

/**
 * Audit logs - enterprise compliance audit trail
 * GDPR-compliant: supports user data anonymization while preserving audit integrity
 */
export const auditActionEnum = pgEnum('audit_action', [
  // Page operations
  'PAGE_CREATED', 'PAGE_UPDATED', 'PAGE_DELETED', 'PAGE_MOVED', 'PAGE_RESTORED', 'PAGE_DUPLICATED',
  // Permission operations
  'PERMISSION_GRANTED', 'PERMISSION_REVOKED', 'PERMISSION_UPDATED',
  // AI operations
  'AI_TOOL_CALLED', 'AI_CONTENT_GENERATED', 'AI_CONVERSATION_STARTED',
  // File operations
  'FILE_UPLOADED', 'FILE_DELETED', 'FILE_DOWNLOADED', 'FILE_MOVED',
  // Drive operations
  'DRIVE_CREATED', 'DRIVE_UPDATED', 'DRIVE_DELETED',
  'DRIVE_MEMBER_ADDED', 'DRIVE_MEMBER_REMOVED', 'DRIVE_MEMBER_ROLE_CHANGED',
  // Authentication
  'USER_LOGIN', 'USER_LOGOUT', 'USER_SIGNUP', 'USER_PASSWORD_CHANGED',
  // Settings
  'SETTINGS_UPDATED', 'INTEGRATION_CONNECTED', 'INTEGRATION_DISCONNECTED',
  // Real-time
  'REALTIME_CONNECTED', 'REALTIME_DISCONNECTED',
  // Background jobs
  'JOB_STARTED', 'JOB_COMPLETED', 'JOB_FAILED'
]);

export const auditLogs = pgTable('audit_logs', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  timestamp: timestamp('timestamp', { mode: 'date' }).defaultNow().notNull(),

  // Action details
  action: auditActionEnum('action').notNull(),
  category: text('category').notNull(), // page, permission, ai, file, drive, auth, etc.

  // Actor (who performed the action)
  userId: text('user_id'), // Can be null for system actions
  userEmail: text('user_email'), // Hashed or anonymized for GDPR
  actorType: text('actor_type').notNull().default('user'), // user, system, api, background_job

  // Target (what was affected)
  resourceType: text('resource_type'), // page, drive, file, permission, etc.
  resourceId: text('resource_id'),
  resourceName: text('resource_name'), // Snapshot of name at time of action

  // Context
  driveId: text('drive_id'),
  pageId: text('page_id'),
  sessionId: text('session_id'),
  requestId: text('request_id'),

  // Request context (for tracking origin)
  ip: text('ip'), // Can be anonymized for GDPR
  userAgent: text('user_agent'),
  endpoint: text('endpoint'), // API endpoint used

  // Change details
  changes: jsonb('changes'), // { before: {}, after: {} } for updates
  metadata: jsonb('metadata'), // Additional action-specific data

  // Result
  success: boolean('success').default(true),
  errorMessage: text('error_message'),

  // GDPR compliance
  anonymized: boolean('anonymized').default(false), // Tracks if user data was anonymized
  retentionDate: timestamp('retention_date', { mode: 'date' }), // Auto-delete after this date

  // Service tracking (for multi-service architecture)
  service: text('service').default('web'), // web, realtime, processor
  version: text('version'),
}, (table) => ({
  timestampIdx: index('idx_audit_timestamp').on(table.timestamp),
  actionIdx: index('idx_audit_action').on(table.action, table.timestamp),
  categoryIdx: index('idx_audit_category').on(table.category),
  userIdIdx: index('idx_audit_user_id').on(table.userId, table.timestamp),
  resourceIdx: index('idx_audit_resource').on(table.resourceType, table.resourceId),
  driveIdIdx: index('idx_audit_drive_id').on(table.driveId, table.timestamp),
  pageIdIdx: index('idx_audit_page_id').on(table.pageId, table.timestamp),
  sessionIdx: index('idx_audit_session').on(table.sessionId),
  requestIdx: index('idx_audit_request').on(table.requestId),
  anonymizedIdx: index('idx_audit_anonymized').on(table.anonymized),
  retentionIdx: index('idx_audit_retention').on(table.retentionDate),
  successIdx: index('idx_audit_success').on(table.success, table.timestamp),
}));