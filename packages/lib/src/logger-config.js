"use strict";
/**
 * Logger Configuration and Helper Utilities
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loggers = void 0;
exports.extractRequestContext = extractRequestContext;
exports.logRequest = logRequest;
exports.logResponse = logResponse;
exports.logAIRequest = logAIRequest;
exports.logDatabaseQuery = logDatabaseQuery;
exports.logAuthEvent = logAuthEvent;
exports.logSecurityEvent = logSecurityEvent;
exports.logPerformance = logPerformance;
exports.createRequestLogger = createRequestLogger;
exports.withLogging = withLogging;
exports.setupErrorHandlers = setupErrorHandlers;
exports.logPerformanceDecorator = logPerformanceDecorator;
exports.initializeLogging = initializeLogging;
const logger_1 = require("./logger");
// Category-specific loggers
exports.loggers = {
    auth: logger_1.logger.child({ category: 'auth' }),
    api: logger_1.logger.child({ category: 'api' }),
    ai: logger_1.logger.child({ category: 'ai' }),
    database: logger_1.logger.child({ category: 'database' }),
    realtime: logger_1.logger.child({ category: 'realtime' }),
    performance: logger_1.logger.child({ category: 'performance' }),
    security: logger_1.logger.child({ category: 'security' }),
    system: logger_1.logger.child({ category: 'system' }),
    processor: logger_1.logger.child({ category: 'processor' })
};
/**
 * Extract context from HTTP request
 * Accepts Express Request or Next.js NextRequest
 */
function extractRequestContext(req) {
    const context = {};
    // Handle Next.js request
    if ('nextUrl' in req) {
        context.endpoint = req.nextUrl.pathname;
        context.method = req.method;
        context.ip = req.headers.get('x-forwarded-for')?.split(',')[0] ||
            req.headers.get('x-real-ip') ||
            'unknown';
        context.userAgent = req.headers.get('user-agent') || undefined;
        // Extract query params
        const searchParams = req.nextUrl.searchParams;
        if (searchParams.toString()) {
            context.query = Object.fromEntries(searchParams.entries());
        }
    }
    // Handle Express request
    else {
        context.endpoint = req.path || req.url;
        context.method = req.method;
        context.ip = req.ip || req.socket?.remoteAddress;
        context.userAgent = req.headers['user-agent'];
        if (req.query && Object.keys(req.query).length > 0) {
            context.query = req.query;
        }
    }
    return context;
}
/**
 * Log API request with automatic context extraction
 */
function logRequest(req, additionalContext) {
    const context = {
        ...extractRequestContext(req),
        ...additionalContext
    };
    exports.loggers.api.info(`${context.method} ${context.endpoint}`, { context });
}
/**
 * Log API response with timing
 */
function logResponse(req, statusCode, startTime, additionalContext) {
    const duration = Date.now() - startTime;
    const context = {
        ...extractRequestContext(req),
        statusCode,
        duration,
        ...additionalContext
    };
    const level = statusCode >= 500 ? 'error' :
        statusCode >= 400 ? 'warn' :
            'info';
    const message = `${context.method} ${context.endpoint} ${statusCode} ${duration}ms`;
    if (level === 'error') {
        exports.loggers.api.error(message, undefined, { context });
    }
    else if (level === 'warn') {
        exports.loggers.api.warn(message, { context });
    }
    else {
        exports.loggers.api.info(message, { context });
    }
}
/**
 * Log AI request with token tracking
 */
function logAIRequest(provider, model, userId, tokens, cost, duration) {
    exports.loggers.ai.info(`AI request to ${provider}/${model}`, {
        provider,
        model,
        userId,
        tokens,
        cost,
        duration
    });
}
/**
 * Log database query with timing
 */
function logDatabaseQuery(operation, table, duration, rowCount, error) {
    const metadata = {
        operation,
        table,
        duration,
        rowCount
    };
    if (error) {
        exports.loggers.database.error(`Database error: ${operation} ${table}`, error, metadata);
    }
    else if (duration > 1000) {
        exports.loggers.database.warn(`Slow query: ${operation} ${table}`, metadata);
    }
    else {
        exports.loggers.database.debug(`${operation} ${table}`, metadata);
    }
}
/**
 * Log authentication events
 */
function logAuthEvent(event, userId, email, ip, reason) {
    const metadata = {
        event,
        userId,
        email: email ? email.replace(/(.{2}).*(@.*)/, '$1***$2') : undefined, // Partially mask email
        ip,
        reason
    };
    if (event === 'failed') {
        exports.loggers.auth.warn(`Authentication failed`, metadata);
    }
    else {
        exports.loggers.auth.info(`Authentication: ${event}`, metadata);
    }
}
/**
 * Log security events
 */
function logSecurityEvent(event, details) {
    exports.loggers.security.warn(`Security event: ${event}`, details);
}
/**
 * Log performance metrics
 */
function logPerformance(metric, value, unit = 'ms', metadata) {
    exports.loggers.performance.info(`Performance: ${metric}`, {
        metric,
        value,
        unit,
        ...metadata
    });
}
/**
 * Create request-scoped logger with request ID
 */
function createRequestLogger(requestId) {
    return logger_1.logger.child({ requestId });
}
/**
 * Async error handler wrapper
 */
function withLogging(fn, name) {
    return (async (...args) => {
        const timer = logger_1.logger.startTimer(name);
        try {
            const result = await fn(...args);
            timer();
            return result;
        }
        catch (error) {
            timer();
            logger_1.logger.error(`Error in ${name}`, error);
            throw error;
        }
    });
}
/**
 * Log unhandled errors
 */
function setupErrorHandlers() {
    process.on('uncaughtException', (error) => {
        exports.loggers.system.fatal('Uncaught exception', error);
        process.exit(1);
    });
    process.on('unhandledRejection', (reason, promise) => {
        exports.loggers.system.error('Unhandled rejection', undefined, {
            reason: reason?.toString(),
            promise: promise.toString()
        });
    });
}
/**
 * Performance monitoring decorator
 */
function logPerformanceDecorator(target, propertyName, descriptor) {
    const originalMethod = descriptor.value;
    descriptor.value = async function (...args) {
        const timer = logger_1.logger.startTimer(`${target.constructor.name}.${propertyName}`);
        try {
            const result = await originalMethod.apply(this, args);
            timer();
            return result;
        }
        catch (error) {
            timer();
            throw error;
        }
    };
    return descriptor;
}
/**
 * Initialize logging for the application
 */
function initializeLogging() {
    // Set up error handlers
    setupErrorHandlers();
    // Log startup
    exports.loggers.system.info('Application starting', {
        node_version: process.version,
        env: process.env.NODE_ENV,
        pid: process.pid,
        platform: process.platform,
        memory: {
            total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
            used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
        }
    });
}
// Export everything
__exportStar(require("./logger"), exports);
