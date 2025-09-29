/**
 * Database writer for Logger
 * Handles writing log entries to the database
 */
import type { LogEntry } from './logger';
/**
 * Write log entries to database
 */
export declare function writeLogsToDatabase(entries: LogEntry[]): Promise<void>;
/**
 * Write API metrics to database
 */
export declare function writeApiMetrics(metrics: {
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
}): Promise<void>;
/**
 * Write AI usage to database
 */
export declare function writeAiUsage(usage: {
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
}): Promise<void>;
/**
 * Write user activity to database
 */
export declare function writeUserActivity(activity: {
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
}): Promise<void>;
/**
 * Write performance metrics to database
 */
export declare function writePerformanceMetric(metric: {
    metric: string;
    value: number;
    unit: string;
    userId?: string;
    sessionId?: string;
    pageId?: string;
    driveId?: string;
    metadata?: any;
}): Promise<void>;
/**
 * Write error to database
 */
export declare function writeError(error: {
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
}): Promise<void>;
//# sourceMappingURL=logger-database.d.ts.map