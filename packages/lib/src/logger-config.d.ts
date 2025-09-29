/**
 * Logger Configuration and Helper Utilities
 */
import { logger, LogContext } from './logger';
export declare const loggers: {
    auth: import("./logger").Logger;
    api: import("./logger").Logger;
    ai: import("./logger").Logger;
    database: import("./logger").Logger;
    realtime: import("./logger").Logger;
    performance: import("./logger").Logger;
    security: import("./logger").Logger;
    system: import("./logger").Logger;
    processor: import("./logger").Logger;
};
/**
 * Extract context from HTTP request
 * Accepts Express Request or Next.js NextRequest
 */
export declare function extractRequestContext(req: any): LogContext;
/**
 * Log API request with automatic context extraction
 */
export declare function logRequest(req: any, additionalContext?: LogContext): void;
/**
 * Log API response with timing
 */
export declare function logResponse(req: any, statusCode: number, startTime: number, additionalContext?: LogContext): void;
/**
 * Log AI request with token tracking
 */
export declare function logAIRequest(provider: string, model: string, userId: string, tokens?: {
    input?: number;
    output?: number;
    total?: number;
}, cost?: number, duration?: number): void;
/**
 * Log database query with timing
 */
export declare function logDatabaseQuery(operation: string, table: string, duration: number, rowCount?: number, error?: Error): void;
/**
 * Log authentication events
 */
export declare function logAuthEvent(event: 'login' | 'logout' | 'signup' | 'refresh' | 'failed', userId?: string, email?: string, ip?: string, reason?: string): void;
/**
 * Log security events
 */
export declare function logSecurityEvent(event: 'rate_limit' | 'invalid_token' | 'unauthorized' | 'suspicious_activity', details: Record<string, any>): void;
/**
 * Log performance metrics
 */
export declare function logPerformance(metric: string, value: number, unit?: 'ms' | 'bytes' | 'count' | 'percent', metadata?: Record<string, any>): void;
/**
 * Create request-scoped logger with request ID
 */
export declare function createRequestLogger(requestId: string): typeof logger;
/**
 * Async error handler wrapper
 */
export declare function withLogging<T extends (...args: any[]) => Promise<any>>(fn: T, name: string): T;
/**
 * Log unhandled errors
 */
export declare function setupErrorHandlers(): void;
/**
 * Performance monitoring decorator
 */
export declare function logPerformanceDecorator(target: any, propertyName: string, descriptor: PropertyDescriptor): PropertyDescriptor;
/**
 * Initialize logging for the application
 */
export declare function initializeLogging(): void;
export * from './logger';
//# sourceMappingURL=logger-config.d.ts.map