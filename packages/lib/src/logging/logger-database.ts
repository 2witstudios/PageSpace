/**
 * Database writer for Logger
 * Handles writing log entries to the database
 */

import { db, systemLogs, apiMetrics, aiUsageLogs, errorLogs, userActivities } from '@pagespace/db';
import type { LogEntry, LogContext } from './logger';
import { createId } from '@paralleldrive/cuid2';

interface DatabaseLogEntry {
  id: string;
  timestamp: Date;
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  message: string;
  category?: string;
  userId?: string;
  sessionId?: string;
  requestId?: string;
  driveId?: string;
  pageId?: string;
  endpoint?: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
  ip?: string;
  userAgent?: string;
  errorName?: string;
  errorMessage?: string;
  errorStack?: string;
  duration?: number;
  memoryUsed?: number;
  memoryTotal?: number;
  metadata?: any;
  hostname?: string;
  pid?: number;
  version?: string;
}

/**
 * Convert log entry to database format
 */
function convertToDbFormat(entry: LogEntry): DatabaseLogEntry {
  const dbEntry: DatabaseLogEntry = {
    id: createId(),
    timestamp: new Date(entry.timestamp),
    level: entry.level.toLowerCase() as DatabaseLogEntry['level'],
    message: entry.message,
    hostname: entry.hostname,
    pid: entry.pid,
    version: entry.version,
  };

  // Extract context
  if (entry.context) {
    dbEntry.userId = entry.context.userId;
    dbEntry.sessionId = entry.context.sessionId;
    dbEntry.requestId = entry.context.requestId;
    dbEntry.driveId = entry.context.driveId;
    dbEntry.pageId = entry.context.pageId;
    dbEntry.endpoint = entry.context.endpoint;
    dbEntry.method = entry.context.method as DatabaseLogEntry['method'];
    dbEntry.ip = entry.context.ip;
    dbEntry.userAgent = entry.context.userAgent;
    dbEntry.category = entry.context.category;
    
    // Remove duplicates from metadata
    const { 
      userId, sessionId, requestId, driveId, pageId, 
      endpoint, method, ip, userAgent, category, 
      ...remainingContext 
    } = entry.context;
    
    if (Object.keys(remainingContext).length > 0) {
      dbEntry.metadata = { ...dbEntry.metadata, ...remainingContext };
    }
  }

  // Extract error
  if (entry.error) {
    dbEntry.errorName = entry.error.name;
    dbEntry.errorMessage = entry.error.message;
    dbEntry.errorStack = entry.error.stack;
  }

  // Extract performance
  if (entry.performance) {
    dbEntry.duration = entry.performance.duration;
    dbEntry.memoryUsed = entry.performance.memory?.used;
    dbEntry.memoryTotal = entry.performance.memory?.total;
  }

  // Add remaining metadata
  if (entry.metadata) {
    dbEntry.metadata = { ...dbEntry.metadata, ...entry.metadata };
  }

  return dbEntry;
}

/**
 * Write log entries to database
 */
export async function writeLogsToDatabase(entries: LogEntry[]): Promise<void> {
  if (entries.length === 0) return;

  try {
    const dbEntries = entries.map(convertToDbFormat);
    
    // Batch insert
    await db.insert(systemLogs).values(dbEntries);
  } catch (error) {
    // Fallback to console if database write fails
    console.error('[Logger] Failed to write logs to database:', error);
    console.error('[Logger] Failed entries:', entries.length);
  }
}

/**
 * Write API metrics to database
 */
export async function writeApiMetrics(metrics: {
  endpoint: string;
  method: string;
  statusCode: number;
  duration: number;
  requestSize?: number;
  responseSize?: number;
  userId?: string;
  sessionId?: string;
  ip?: string;
  userAgent?: string;
  error?: string;
  requestId?: string;
  cacheHit?: boolean;
  cacheKey?: string;
  timestamp?: Date;
}): Promise<void> {
  try {
    await db.insert(apiMetrics).values({
      id: createId(),
      timestamp: metrics.timestamp ?? new Date(),
      endpoint: metrics.endpoint,
      method: metrics.method as any,
      statusCode: metrics.statusCode,
      duration: metrics.duration,
      requestSize: metrics.requestSize,
      responseSize: metrics.responseSize,
      userId: metrics.userId,
      sessionId: metrics.sessionId,
      ip: metrics.ip,
      userAgent: metrics.userAgent,
      error: metrics.error,
      requestId: metrics.requestId,
      cacheHit: metrics.cacheHit,
      cacheKey: metrics.cacheKey,
    });
  } catch (error) {
    console.error('[Logger] Failed to write API metrics:', error);
  }
}

/**
 * Write AI usage to database
 */
export async function writeAiUsage(usage: {
  userId: string;
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cost?: number;
  duration?: number;
  conversationId?: string;
  messageId?: string;
  pageId?: string;
  driveId?: string;
  success?: boolean;
  error?: string;
  metadata?: any;

  // Context tracking
  contextMessages?: string[];
  contextSize?: number;
  systemPromptTokens?: number;
  toolDefinitionTokens?: number;
  conversationTokens?: number;
  messageCount?: number;
  wasTruncated?: boolean;
  truncationStrategy?: string;
}): Promise<void> {
  try {
    await db.insert(aiUsageLogs).values({
      id: createId(),
      timestamp: new Date(),
      userId: usage.userId,
      provider: usage.provider,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      cost: usage.cost,
      duration: usage.duration,
      conversationId: usage.conversationId,
      messageId: usage.messageId,
      pageId: usage.pageId,
      driveId: usage.driveId,
      success: usage.success,
      error: usage.error,
      metadata: usage.metadata,

      // Context tracking
      contextMessages: usage.contextMessages,
      contextSize: usage.contextSize,
      systemPromptTokens: usage.systemPromptTokens,
      toolDefinitionTokens: usage.toolDefinitionTokens,
      conversationTokens: usage.conversationTokens,
      messageCount: usage.messageCount,
      wasTruncated: usage.wasTruncated,
      truncationStrategy: usage.truncationStrategy,
    });
  } catch (error) {
    console.error('[Logger] Failed to write AI usage:', error);
  }
}

/**
 * Write user activity to database
 */
export async function writeUserActivity(activity: {
  userId: string;
  action: string;
  resource?: string;
  resourceId?: string;
  driveId?: string;
  pageId?: string;
  sessionId?: string;
  ip?: string;
  userAgent?: string;
  metadata?: any;
}): Promise<void> {
  try {
    await db.insert(userActivities).values({
      id: createId(),
      timestamp: new Date(),
      userId: activity.userId,
      action: activity.action,
      resource: activity.resource,
      resourceId: activity.resourceId,
      driveId: activity.driveId,
      pageId: activity.pageId,
      sessionId: activity.sessionId,
      ip: activity.ip,
      userAgent: activity.userAgent,
      metadata: activity.metadata,
    });
  } catch (error) {
    console.error('[Logger] Failed to write user activity:', error);
  }
}

/**
 * Write error to database
 */
export async function writeError(error: {
  name: string;
  message: string;
  stack?: string;
  userId?: string;
  sessionId?: string;
  requestId?: string;
  endpoint?: string;
  method?: string;
  file?: string;
  line?: number;
  column?: number;
  ip?: string;
  userAgent?: string;
  metadata?: any;
}): Promise<void> {
  try {
    await db.insert(errorLogs).values({
      id: createId(),
      timestamp: new Date(),
      name: error.name,
      message: error.message,
      stack: error.stack,
      userId: error.userId,
      sessionId: error.sessionId,
      requestId: error.requestId,
      endpoint: error.endpoint,
      method: error.method as any,
      file: error.file,
      line: error.line,
      column: error.column,
      ip: error.ip,
      userAgent: error.userAgent,
      metadata: error.metadata,
    });
  } catch (err) {
    console.error('[Logger] Failed to write error log:', err);
  }
}