"use strict";
/**
 * Database writer for Logger
 * Handles writing log entries to the database
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.writeLogsToDatabase = writeLogsToDatabase;
exports.writeApiMetrics = writeApiMetrics;
exports.writeAiUsage = writeAiUsage;
exports.writeUserActivity = writeUserActivity;
exports.writePerformanceMetric = writePerformanceMetric;
exports.writeError = writeError;
const db_1 = require("@pagespace/db");
const cuid2_1 = require("@paralleldrive/cuid2");
/**
 * Convert log entry to database format
 */
function convertToDbFormat(entry) {
    const dbEntry = {
        id: (0, cuid2_1.createId)(),
        timestamp: new Date(entry.timestamp),
        level: entry.level.toLowerCase(),
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
        dbEntry.method = entry.context.method;
        dbEntry.ip = entry.context.ip;
        dbEntry.userAgent = entry.context.userAgent;
        dbEntry.category = entry.context.category;
        // Remove duplicates from metadata
        const { userId, sessionId, requestId, driveId, pageId, endpoint, method, ip, userAgent, category, ...remainingContext } = entry.context;
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
async function writeLogsToDatabase(entries) {
    if (entries.length === 0)
        return;
    try {
        const dbEntries = entries.map(convertToDbFormat);
        // Batch insert
        await db_1.db.insert(db_1.systemLogs).values(dbEntries);
    }
    catch (error) {
        // Fallback to console if database write fails
        console.error('[Logger] Failed to write logs to database:', error);
        console.error('[Logger] Failed entries:', entries.length);
    }
}
/**
 * Write API metrics to database
 */
async function writeApiMetrics(metrics) {
    try {
        await db_1.db.insert(db_1.apiMetrics).values({
            id: (0, cuid2_1.createId)(),
            timestamp: metrics.timestamp ?? new Date(),
            endpoint: metrics.endpoint,
            method: metrics.method,
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
    }
    catch (error) {
        console.error('[Logger] Failed to write API metrics:', error);
    }
}
/**
 * Write AI usage to database
 */
async function writeAiUsage(usage) {
    try {
        await db_1.db.insert(db_1.aiUsageLogs).values({
            id: (0, cuid2_1.createId)(),
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
        });
    }
    catch (error) {
        console.error('[Logger] Failed to write AI usage:', error);
    }
}
/**
 * Write user activity to database
 */
async function writeUserActivity(activity) {
    try {
        await db_1.db.insert(db_1.userActivities).values({
            id: (0, cuid2_1.createId)(),
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
    }
    catch (error) {
        console.error('[Logger] Failed to write user activity:', error);
    }
}
/**
 * Write performance metrics to database
 */
async function writePerformanceMetric(metric) {
    try {
        await db_1.db.insert(db_1.performanceMetrics).values({
            id: (0, cuid2_1.createId)(),
            timestamp: new Date(),
            metric: metric.metric,
            value: metric.value,
            unit: metric.unit,
            userId: metric.userId,
            sessionId: metric.sessionId,
            pageId: metric.pageId,
            driveId: metric.driveId,
            metadata: metric.metadata,
        });
    }
    catch (error) {
        console.error('[Logger] Failed to write performance metric:', error);
    }
}
/**
 * Write error to database
 */
async function writeError(error) {
    try {
        await db_1.db.insert(db_1.errorLogs).values({
            id: (0, cuid2_1.createId)(),
            timestamp: new Date(),
            name: error.name,
            message: error.message,
            stack: error.stack,
            userId: error.userId,
            sessionId: error.sessionId,
            requestId: error.requestId,
            endpoint: error.endpoint,
            method: error.method,
            file: error.file,
            line: error.line,
            column: error.column,
            ip: error.ip,
            userAgent: error.userAgent,
            metadata: error.metadata,
        });
    }
    catch (err) {
        console.error('[Logger] Failed to write error log:', err);
    }
}
