"use strict";
/**
 * Lightweight Activity Tracker
 * Fire-and-forget async tracking with zero performance impact
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.trackActivity = trackActivity;
exports.trackPageOperation = trackPageOperation;
exports.trackDriveOperation = trackDriveOperation;
exports.trackAiUsage = trackAiUsage;
exports.trackFeature = trackFeature;
exports.trackAuthEvent = trackAuthEvent;
exports.trackSearch = trackSearch;
exports.trackNavigation = trackNavigation;
exports.trackError = trackError;
exports.trackApiCall = trackApiCall;
exports.getUserIdFromRequest = getUserIdFromRequest;
const logger_database_1 = require("./logger-database");
const logger_config_1 = require("./logger-config");
const ai_monitoring_1 = require("./ai-monitoring");
/**
 * Track user activity - fire and forget, never blocks
 */
async function trackActivity(userId, action, data) {
    // Don't track if no user
    if (!userId)
        return;
    // Fire and forget - don't await
    (0, logger_database_1.writeUserActivity)({
        userId,
        action,
        resource: data?.resource,
        resourceId: data?.resourceId,
        driveId: data?.driveId,
        pageId: data?.pageId,
        sessionId: data?.sessionId,
        ip: data?.ip,
        userAgent: data?.userAgent,
        metadata: data?.metadata,
    }).catch((error) => {
        // Log error but don't throw - never impact user experience
        logger_config_1.loggers.api.debug('Activity tracking failed', { error: error.message, action });
    });
}
/**
 * Track page operations
 */
function trackPageOperation(userId, operation, pageId, metadata) {
    trackActivity(userId, `page_${operation}`, {
        resource: 'page',
        resourceId: pageId,
        pageId,
        metadata
    });
}
/**
 * Track drive operations
 */
function trackDriveOperation(userId, operation, driveId, metadata) {
    trackActivity(userId, `drive_${operation}`, {
        resource: 'drive',
        resourceId: driveId,
        driveId,
        metadata
    });
}
/**
 * Track AI usage - simplified wrapper that delegates to enhanced AI monitoring
 */
function trackAiUsage(userId, provider, model, data) {
    if (!userId)
        return;
    // Delegate to enhanced AI monitoring which handles token counting and cost calculation
    ai_monitoring_1.AIMonitoring.trackUsage({
        userId,
        provider,
        model,
        totalTokens: data?.tokens,
        duration: data?.duration,
        conversationId: data?.conversationId,
        pageId: data?.pageId,
        driveId: data?.driveId,
        success: !data?.error,
        error: data?.error,
    });
}
/**
 * Track feature usage
 */
function trackFeature(userId, feature, metadata) {
    trackActivity(userId, `feature_${feature}`, {
        resource: 'feature',
        resourceId: feature,
        metadata
    });
}
/**
 * Track authentication events
 */
function trackAuthEvent(userId, event, metadata) {
    trackActivity(userId || 'anonymous', `auth_${event}`, {
        resource: 'auth',
        metadata
    });
}
/**
 * Track search queries
 */
function trackSearch(userId, searchType, query, resultCount) {
    trackActivity(userId, 'search', {
        resource: 'search',
        metadata: {
            type: searchType,
            query: query.substring(0, 100), // Limit query length
            resultCount
        }
    });
}
/**
 * Track navigation
 */
function trackNavigation(userId, from, to, metadata) {
    trackActivity(userId, 'navigation', {
        metadata: {
            from,
            to,
            ...metadata
        }
    });
}
/**
 * Track errors that affect users
 */
function trackError(userId, errorType, errorMessage, context) {
    trackActivity(userId, 'error', {
        resource: 'error',
        metadata: {
            type: errorType,
            message: errorMessage.substring(0, 200), // Limit message length
            context
        }
    });
}
/**
 * Track API metrics - simplified wrapper
 */
function trackApiCall(endpoint, method, statusCode, duration, userId, error) {
    // Only track slow requests or errors to minimize overhead
    if (duration > 5000 || statusCode >= 400) {
        (0, logger_database_1.writeApiMetrics)({
            endpoint,
            method,
            statusCode,
            duration,
            userId,
            error
        }).catch(() => {
            // Silent fail
        });
    }
}
/**
 * Helper to extract user ID from request cookies (server-side)
 */
async function getUserIdFromRequest(request) {
    try {
        const cookieHeader = request.headers.get('cookie');
        if (!cookieHeader)
            return undefined;
        // Simple cookie parsing - you may want to use your existing auth utilities
        const cookies = Object.fromEntries(cookieHeader.split('; ').map(c => c.split('=')));
        const token = cookies.accessToken;
        if (!token)
            return undefined;
        // TODO: Decode JWT to get user ID
        // For now, return undefined - integrate with your auth system
        return undefined;
    }
    catch {
        return undefined;
    }
}
