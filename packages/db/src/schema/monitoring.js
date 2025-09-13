"use strict";
/**
 * Database schema for monitoring, logging, and analytics
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.alertHistory = exports.dailyAggregates = exports.errorLogs = exports.performanceMetrics = exports.aiUsageLogs = exports.userActivities = exports.apiMetrics = exports.systemLogs = exports.httpMethodEnum = exports.logLevelEnum = void 0;
const pg_core_1 = require("drizzle-orm/pg-core");
const cuid2_1 = require("@paralleldrive/cuid2");
// Enums
exports.logLevelEnum = (0, pg_core_1.pgEnum)('log_level', ['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
exports.httpMethodEnum = (0, pg_core_1.pgEnum)('http_method', ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);
/**
 * System logs - structured application logs
 */
exports.systemLogs = (0, pg_core_1.pgTable)('system_logs', {
    id: (0, pg_core_1.text)('id').primaryKey().$defaultFn(() => (0, cuid2_1.createId)()),
    timestamp: (0, pg_core_1.timestamp)('timestamp', { mode: 'date' }).defaultNow().notNull(),
    level: (0, exports.logLevelEnum)('level').notNull(),
    message: (0, pg_core_1.text)('message').notNull(),
    category: (0, pg_core_1.text)('category'), // auth, api, ai, database, etc.
    // Context
    userId: (0, pg_core_1.text)('user_id'),
    sessionId: (0, pg_core_1.text)('session_id'),
    requestId: (0, pg_core_1.text)('request_id'),
    driveId: (0, pg_core_1.text)('drive_id'),
    pageId: (0, pg_core_1.text)('page_id'),
    // Request context
    endpoint: (0, pg_core_1.text)('endpoint'),
    method: (0, exports.httpMethodEnum)('method'),
    ip: (0, pg_core_1.text)('ip'),
    userAgent: (0, pg_core_1.text)('user_agent'),
    // Error details
    errorName: (0, pg_core_1.text)('error_name'),
    errorMessage: (0, pg_core_1.text)('error_message'),
    errorStack: (0, pg_core_1.text)('error_stack'),
    // Performance
    duration: (0, pg_core_1.integer)('duration'), // milliseconds
    memoryUsed: (0, pg_core_1.integer)('memory_used'), // MB
    memoryTotal: (0, pg_core_1.integer)('memory_total'), // MB
    // Additional metadata
    metadata: (0, pg_core_1.jsonb)('metadata'),
    hostname: (0, pg_core_1.text)('hostname'),
    pid: (0, pg_core_1.integer)('pid'),
    version: (0, pg_core_1.text)('version'),
}, (table) => ({
    timestampIdx: (0, pg_core_1.index)('idx_system_logs_timestamp').on(table.timestamp),
    levelIdx: (0, pg_core_1.index)('idx_system_logs_level').on(table.level),
    categoryIdx: (0, pg_core_1.index)('idx_system_logs_category').on(table.category),
    userIdIdx: (0, pg_core_1.index)('idx_system_logs_user_id').on(table.userId),
    requestIdIdx: (0, pg_core_1.index)('idx_system_logs_request_id').on(table.requestId),
    errorIdx: (0, pg_core_1.index)('idx_system_logs_error').on(table.errorName, table.timestamp),
}));
/**
 * API metrics - track all API requests
 */
exports.apiMetrics = (0, pg_core_1.pgTable)('api_metrics', {
    id: (0, pg_core_1.text)('id').primaryKey().$defaultFn(() => (0, cuid2_1.createId)()),
    timestamp: (0, pg_core_1.timestamp)('timestamp', { mode: 'date' }).defaultNow().notNull(),
    // Request details
    endpoint: (0, pg_core_1.text)('endpoint').notNull(),
    method: (0, exports.httpMethodEnum)('method').notNull(),
    statusCode: (0, pg_core_1.integer)('status_code').notNull(),
    // Performance
    duration: (0, pg_core_1.integer)('duration').notNull(), // milliseconds
    requestSize: (0, pg_core_1.integer)('request_size'), // bytes
    responseSize: (0, pg_core_1.integer)('response_size'), // bytes
    // User context
    userId: (0, pg_core_1.text)('user_id'),
    sessionId: (0, pg_core_1.text)('session_id'),
    ip: (0, pg_core_1.text)('ip'),
    userAgent: (0, pg_core_1.text)('user_agent'),
    // Additional details
    error: (0, pg_core_1.text)('error'),
    requestId: (0, pg_core_1.text)('request_id'),
    // Caching
    cacheHit: (0, pg_core_1.boolean)('cache_hit').default(false),
    cacheKey: (0, pg_core_1.text)('cache_key'),
}, (table) => ({
    timestampIdx: (0, pg_core_1.index)('idx_api_metrics_timestamp').on(table.timestamp),
    endpointIdx: (0, pg_core_1.index)('idx_api_metrics_endpoint').on(table.endpoint, table.timestamp),
    userIdIdx: (0, pg_core_1.index)('idx_api_metrics_user_id').on(table.userId, table.timestamp),
    statusCodeIdx: (0, pg_core_1.index)('idx_api_metrics_status').on(table.statusCode, table.timestamp),
    durationIdx: (0, pg_core_1.index)('idx_api_metrics_duration').on(table.duration),
}));
/**
 * User activities - track user interactions
 */
exports.userActivities = (0, pg_core_1.pgTable)('user_activities', {
    id: (0, pg_core_1.text)('id').primaryKey().$defaultFn(() => (0, cuid2_1.createId)()),
    timestamp: (0, pg_core_1.timestamp)('timestamp', { mode: 'date' }).defaultNow().notNull(),
    // User
    userId: (0, pg_core_1.text)('user_id').notNull(),
    sessionId: (0, pg_core_1.text)('session_id'),
    // Activity
    action: (0, pg_core_1.text)('action').notNull(), // create, read, update, delete, share, etc.
    resource: (0, pg_core_1.text)('resource'), // page, drive, group, etc.
    resourceId: (0, pg_core_1.text)('resource_id'),
    // Context
    driveId: (0, pg_core_1.text)('drive_id'),
    pageId: (0, pg_core_1.text)('page_id'),
    // Details
    metadata: (0, pg_core_1.jsonb)('metadata'),
    ip: (0, pg_core_1.text)('ip'),
    userAgent: (0, pg_core_1.text)('user_agent'),
}, (table) => ({
    timestampIdx: (0, pg_core_1.index)('idx_user_activities_timestamp').on(table.timestamp),
    userIdIdx: (0, pg_core_1.index)('idx_user_activities_user_id').on(table.userId, table.timestamp),
    actionIdx: (0, pg_core_1.index)('idx_user_activities_action').on(table.action, table.timestamp),
    resourceIdx: (0, pg_core_1.index)('idx_user_activities_resource').on(table.resource, table.resourceId),
}));
/**
 * AI usage logs - track AI provider usage
 */
exports.aiUsageLogs = (0, pg_core_1.pgTable)('ai_usage_logs', {
    id: (0, pg_core_1.text)('id').primaryKey().$defaultFn(() => (0, cuid2_1.createId)()),
    timestamp: (0, pg_core_1.timestamp)('timestamp', { mode: 'date' }).defaultNow().notNull(),
    // User
    userId: (0, pg_core_1.text)('user_id').notNull(),
    sessionId: (0, pg_core_1.text)('session_id'),
    // AI details
    provider: (0, pg_core_1.text)('provider').notNull(), // openrouter, google, anthropic, openai, ollama
    model: (0, pg_core_1.text)('model').notNull(),
    // Usage
    inputTokens: (0, pg_core_1.integer)('input_tokens'),
    outputTokens: (0, pg_core_1.integer)('output_tokens'),
    totalTokens: (0, pg_core_1.integer)('total_tokens'),
    // Cost
    cost: (0, pg_core_1.real)('cost'), // in dollars
    currency: (0, pg_core_1.text)('currency').default('USD'),
    // Performance
    duration: (0, pg_core_1.integer)('duration'), // milliseconds
    streamingDuration: (0, pg_core_1.integer)('streaming_duration'), // milliseconds
    // Context
    conversationId: (0, pg_core_1.text)('conversation_id'),
    messageId: (0, pg_core_1.text)('message_id'),
    pageId: (0, pg_core_1.text)('page_id'),
    driveId: (0, pg_core_1.text)('drive_id'),
    // Request/Response
    prompt: (0, pg_core_1.text)('prompt'), // Store first 1000 chars
    completion: (0, pg_core_1.text)('completion'), // Store first 1000 chars
    // Status
    success: (0, pg_core_1.boolean)('success').default(true),
    error: (0, pg_core_1.text)('error'),
    // Metadata
    metadata: (0, pg_core_1.jsonb)('metadata'),
}, (table) => ({
    timestampIdx: (0, pg_core_1.index)('idx_ai_usage_timestamp').on(table.timestamp),
    userIdIdx: (0, pg_core_1.index)('idx_ai_usage_user_id').on(table.userId, table.timestamp),
    providerIdx: (0, pg_core_1.index)('idx_ai_usage_provider').on(table.provider, table.model, table.timestamp),
    costIdx: (0, pg_core_1.index)('idx_ai_usage_cost').on(table.cost),
    conversationIdx: (0, pg_core_1.index)('idx_ai_usage_conversation').on(table.conversationId),
}));
/**
 * Performance metrics - track application performance
 */
exports.performanceMetrics = (0, pg_core_1.pgTable)('performance_metrics', {
    id: (0, pg_core_1.text)('id').primaryKey().$defaultFn(() => (0, cuid2_1.createId)()),
    timestamp: (0, pg_core_1.timestamp)('timestamp', { mode: 'date' }).defaultNow().notNull(),
    // Metric details
    metric: (0, pg_core_1.text)('metric').notNull(), // page_load, db_query, file_upload, etc.
    value: (0, pg_core_1.real)('value').notNull(),
    unit: (0, pg_core_1.text)('unit').notNull(), // ms, bytes, count, percent
    // Context
    userId: (0, pg_core_1.text)('user_id'),
    sessionId: (0, pg_core_1.text)('session_id'),
    pageId: (0, pg_core_1.text)('page_id'),
    driveId: (0, pg_core_1.text)('drive_id'),
    // Additional details
    metadata: (0, pg_core_1.jsonb)('metadata'),
    // System metrics
    cpuUsage: (0, pg_core_1.real)('cpu_usage'), // percentage
    memoryUsage: (0, pg_core_1.real)('memory_usage'), // MB
    diskUsage: (0, pg_core_1.real)('disk_usage'), // MB
}, (table) => ({
    timestampIdx: (0, pg_core_1.index)('idx_performance_timestamp').on(table.timestamp),
    metricIdx: (0, pg_core_1.index)('idx_performance_metric').on(table.metric, table.timestamp),
    valueIdx: (0, pg_core_1.index)('idx_performance_value').on(table.value),
    userIdIdx: (0, pg_core_1.index)('idx_performance_user_id').on(table.userId),
}));
/**
 * Error logs - detailed error tracking
 */
exports.errorLogs = (0, pg_core_1.pgTable)('error_logs', {
    id: (0, pg_core_1.text)('id').primaryKey().$defaultFn(() => (0, cuid2_1.createId)()),
    timestamp: (0, pg_core_1.timestamp)('timestamp', { mode: 'date' }).defaultNow().notNull(),
    // Error details
    name: (0, pg_core_1.text)('name').notNull(),
    message: (0, pg_core_1.text)('message').notNull(),
    stack: (0, pg_core_1.text)('stack'),
    // Context
    userId: (0, pg_core_1.text)('user_id'),
    sessionId: (0, pg_core_1.text)('session_id'),
    requestId: (0, pg_core_1.text)('request_id'),
    // Location
    endpoint: (0, pg_core_1.text)('endpoint'),
    method: (0, exports.httpMethodEnum)('method'),
    file: (0, pg_core_1.text)('file'),
    line: (0, pg_core_1.integer)('line'),
    column: (0, pg_core_1.integer)('column'),
    // Additional
    ip: (0, pg_core_1.text)('ip'),
    userAgent: (0, pg_core_1.text)('user_agent'),
    metadata: (0, pg_core_1.jsonb)('metadata'),
    // Resolution
    resolved: (0, pg_core_1.boolean)('resolved').default(false),
    resolvedAt: (0, pg_core_1.timestamp)('resolved_at', { mode: 'date' }),
    resolvedBy: (0, pg_core_1.text)('resolved_by'),
    resolution: (0, pg_core_1.text)('resolution'),
}, (table) => ({
    timestampIdx: (0, pg_core_1.index)('idx_errors_timestamp').on(table.timestamp),
    nameIdx: (0, pg_core_1.index)('idx_errors_name').on(table.name, table.timestamp),
    userIdIdx: (0, pg_core_1.index)('idx_errors_user_id').on(table.userId),
    resolvedIdx: (0, pg_core_1.index)('idx_errors_resolved').on(table.resolved),
    endpointIdx: (0, pg_core_1.index)('idx_errors_endpoint').on(table.endpoint),
}));
/**
 * Daily aggregates - pre-computed daily statistics
 */
exports.dailyAggregates = (0, pg_core_1.pgTable)('daily_aggregates', {
    id: (0, pg_core_1.text)('id').primaryKey().$defaultFn(() => (0, cuid2_1.createId)()),
    date: (0, pg_core_1.timestamp)('date', { mode: 'date' }).notNull(),
    category: (0, pg_core_1.text)('category').notNull(), // api, ai, performance, errors
    // Counts
    totalCount: (0, pg_core_1.integer)('total_count').default(0),
    successCount: (0, pg_core_1.integer)('success_count').default(0),
    errorCount: (0, pg_core_1.integer)('error_count').default(0),
    // Performance
    avgDuration: (0, pg_core_1.real)('avg_duration'), // milliseconds
    minDuration: (0, pg_core_1.real)('min_duration'),
    maxDuration: (0, pg_core_1.real)('max_duration'),
    p50Duration: (0, pg_core_1.real)('p50_duration'),
    p95Duration: (0, pg_core_1.real)('p95_duration'),
    p99Duration: (0, pg_core_1.real)('p99_duration'),
    // Users
    uniqueUsers: (0, pg_core_1.integer)('unique_users').default(0),
    uniqueSessions: (0, pg_core_1.integer)('unique_sessions').default(0),
    // AI specific
    totalTokens: (0, pg_core_1.integer)('total_tokens'),
    totalCost: (0, pg_core_1.real)('total_cost'),
    // Metadata
    metadata: (0, pg_core_1.jsonb)('metadata'),
    computedAt: (0, pg_core_1.timestamp)('computed_at', { mode: 'date' }).defaultNow(),
}, (table) => ({
    dateIdx: (0, pg_core_1.index)('idx_aggregates_date').on(table.date, table.category),
    categoryIdx: (0, pg_core_1.index)('idx_aggregates_category').on(table.category),
}));
/**
 * Alert history - track system alerts
 */
exports.alertHistory = (0, pg_core_1.pgTable)('alert_history', {
    id: (0, pg_core_1.text)('id').primaryKey().$defaultFn(() => (0, cuid2_1.createId)()),
    timestamp: (0, pg_core_1.timestamp)('timestamp', { mode: 'date' }).defaultNow().notNull(),
    // Alert details
    type: (0, pg_core_1.text)('type').notNull(), // error_rate, performance, ai_cost, security
    severity: (0, pg_core_1.text)('severity').notNull(), // info, warning, error, critical
    message: (0, pg_core_1.text)('message').notNull(),
    // Thresholds
    threshold: (0, pg_core_1.real)('threshold'),
    actualValue: (0, pg_core_1.real)('actual_value'),
    // Notification
    notified: (0, pg_core_1.boolean)('notified').default(false),
    notifiedAt: (0, pg_core_1.timestamp)('notified_at', { mode: 'date' }),
    notificationChannel: (0, pg_core_1.text)('notification_channel'), // email, webhook, slack
    // Resolution
    acknowledged: (0, pg_core_1.boolean)('acknowledged').default(false),
    acknowledgedAt: (0, pg_core_1.timestamp)('acknowledged_at', { mode: 'date' }),
    acknowledgedBy: (0, pg_core_1.text)('acknowledged_by'),
    // Metadata
    metadata: (0, pg_core_1.jsonb)('metadata'),
}, (table) => ({
    timestampIdx: (0, pg_core_1.index)('idx_alerts_timestamp').on(table.timestamp),
    typeIdx: (0, pg_core_1.index)('idx_alerts_type').on(table.type, table.timestamp),
    severityIdx: (0, pg_core_1.index)('idx_alerts_severity').on(table.severity),
    acknowledgedIdx: (0, pg_core_1.index)('idx_alerts_acknowledged').on(table.acknowledged),
}));
