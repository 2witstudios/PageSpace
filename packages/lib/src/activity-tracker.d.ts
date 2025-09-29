/**
 * Lightweight Activity Tracker
 * Fire-and-forget async tracking with zero performance impact
 */
/**
 * Track user activity - fire and forget, never blocks
 */
export declare function trackActivity(userId: string | undefined, action: string, data?: {
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
 * Track page operations
 */
export declare function trackPageOperation(userId: string | undefined, operation: 'create' | 'read' | 'update' | 'delete' | 'share' | 'restore' | 'trash', pageId: string, metadata?: any): void;
/**
 * Track drive operations
 */
export declare function trackDriveOperation(userId: string | undefined, operation: 'create' | 'access' | 'update' | 'delete' | 'invite_member' | 'remove_member', driveId: string, metadata?: any): void;
/**
 * Track AI usage - simplified wrapper that delegates to enhanced AI monitoring
 */
export declare function trackAiUsage(userId: string | undefined, provider: string, model: string, data?: {
    tokens?: number;
    cost?: number;
    duration?: number;
    conversationId?: string;
    pageId?: string;
    driveId?: string;
    error?: string;
}): void;
/**
 * Track feature usage
 */
export declare function trackFeature(userId: string | undefined, feature: string, metadata?: any): void;
/**
 * Track authentication events
 */
export declare function trackAuthEvent(userId: string | undefined, event: 'login' | 'logout' | 'signup' | 'refresh' | 'failed_login', metadata?: any): void;
/**
 * Track search queries
 */
export declare function trackSearch(userId: string | undefined, searchType: string, query: string, resultCount?: number): void;
/**
 * Track navigation
 */
export declare function trackNavigation(userId: string | undefined, from: string, to: string, metadata?: any): void;
/**
 * Track errors that affect users
 */
export declare function trackError(userId: string | undefined, errorType: string, errorMessage: string, context?: any): void;
/**
 * Track API metrics - simplified wrapper
 */
export declare function trackApiCall(endpoint: string, method: string, statusCode: number, duration: number, userId?: string, error?: string): void;
/**
 * Helper to extract user ID from request cookies (server-side)
 */
export declare function getUserIdFromRequest(request: Request): Promise<string | undefined>;
//# sourceMappingURL=activity-tracker.d.ts.map