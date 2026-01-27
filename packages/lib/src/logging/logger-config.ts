/**
 * Logger Configuration and Helper Utilities
 */

import { logger, LogContext } from './logger';

// Category-specific loggers
export const loggers = {
  auth: logger.child({ category: 'auth' }),
  api: logger.child({ category: 'api' }),
  ai: logger.child({ category: 'ai' }),
  database: logger.child({ category: 'database' }),
  realtime: logger.child({ category: 'realtime' }),
  performance: logger.child({ category: 'performance' }),
  security: logger.child({ category: 'security' }),
  system: logger.child({ category: 'system' }),
  processor: logger.child({ category: 'processor' })
};

/**
 * Extract context from HTTP request
 * Accepts Express Request or Next.js NextRequest
 */
export function extractRequestContext(req: any): LogContext {
  const context: LogContext = {};

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
export function logRequest(
  req: any,
  additionalContext?: LogContext
): void {
  const context = {
    ...extractRequestContext(req),
    ...additionalContext
  };
  
  loggers.api.info(`${context.method} ${context.endpoint}`, { context });
}

/**
 * Log API response with timing
 */
export function logResponse(
  req: any,
  statusCode: number,
  startTime: number,
  additionalContext?: LogContext
): void {
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
    loggers.api.error(message, undefined, { context });
  } else if (level === 'warn') {
    loggers.api.warn(message, { context });
  } else {
    loggers.api.info(message, { context });
  }
}

/**
 * Log AI request with token tracking
 */
export function logAIRequest(
  provider: string,
  model: string,
  userId: string,
  tokens?: { input?: number; output?: number; total?: number },
  cost?: number,
  duration?: number
): void {
  loggers.ai.info(`AI request to ${provider}/${model}`, {
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
export function logDatabaseQuery(
  operation: string,
  table: string,
  duration: number,
  rowCount?: number,
  error?: Error
): void {
  const metadata = {
    operation,
    table,
    duration,
    rowCount
  };
  
  if (error) {
    loggers.database.error(`Database error: ${operation} ${table}`, error, metadata);
  } else if (duration > 1000) {
    loggers.database.warn(`Slow query: ${operation} ${table}`, metadata);
  } else {
    loggers.database.debug(`${operation} ${table}`, metadata);
  }
}

/**
 * Log authentication events
 */
export function logAuthEvent(
  event: 'login' | 'logout' | 'signup' | 'refresh' | 'failed',
  userId?: string,
  email?: string,
  ip?: string,
  reason?: string
): void {
  const metadata = {
    event,
    userId,
    email: email ? email.replace(/(.{2}).*(@.*)/, '$1***$2') : undefined, // Partially mask email
    ip,
    reason
  };
  
  if (event === 'failed') {
    loggers.auth.warn(`Authentication failed`, metadata);
  } else {
    loggers.auth.info(`Authentication: ${event}`, metadata);
  }
}

/**
 * Log security events
 */
export function logSecurityEvent(
  event: 'rate_limit' | 'invalid_token' | 'unauthorized' | 'suspicious_activity' |
         'login_csrf_missing' | 'login_csrf_mismatch' | 'login_csrf_invalid' |
         'signup_csrf_missing' | 'signup_csrf_mismatch' | 'signup_csrf_invalid' |
         'origin_validation_failed' | 'origin_validation_warning' |
         'account_locked_login_attempt',
  details: Record<string, any>
): void {
  loggers.security.warn(`Security event: ${event}`, details);
}

/**
 * Log performance metrics
 */
export function logPerformance(
  metric: string,
  value: number,
  unit: 'ms' | 'bytes' | 'count' | 'percent' = 'ms',
  metadata?: Record<string, any>
): void {
  loggers.performance.info(`Performance: ${metric}`, {
    metric,
    value,
    unit,
    ...metadata
  });
}

/**
 * Create request-scoped logger with request ID
 */
export function createRequestLogger(requestId: string): typeof logger {
  return logger.child({ requestId });
}

/**
 * Async error handler wrapper
 */
export function withLogging<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  name: string
): T {
  return (async (...args: Parameters<T>) => {
    const timer = logger.startTimer(name);
    try {
      const result = await fn(...args);
      timer();
      return result;
    } catch (error) {
      timer();
      logger.error(`Error in ${name}`, error as Error);
      throw error;
    }
  }) as T;
}

/**
 * Log unhandled errors
 */
export function setupErrorHandlers(): void {
  process.on('uncaughtException', (error: Error) => {
    loggers.system.fatal('Uncaught exception', error);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
    loggers.system.error('Unhandled rejection', undefined, {
      reason: reason?.toString(),
      promise: promise.toString()
    });
  });
}

/**
 * Performance monitoring decorator
 */
export function logPerformanceDecorator(target: any, propertyName: string, descriptor: PropertyDescriptor) {
  const originalMethod = descriptor.value;

  descriptor.value = async function (...args: any[]) {
    const timer = logger.startTimer(`${target.constructor.name}.${propertyName}`);
    try {
      const result = await originalMethod.apply(this, args);
      timer();
      return result;
    } catch (error) {
      timer();
      throw error;
    }
  };

  return descriptor;
}

/**
 * Initialize logging for the application
 */
export function initializeLogging(): void {
  // Set up error handlers
  setupErrorHandlers();
  
  // Log startup
  loggers.system.info('Application starting', {
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
export * from './logger';
