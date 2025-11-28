/**
 * @module @pagespace/lib/logging
 * @description Logging infrastructure
 */

// Export logger core (types, enums, logger instance)
export * from './logger';

// Export browser logger (only unique exports, not duplicated types)
export {
  BrowserSafeLogger,
  browserLogger,
  browserLoggers,
} from './logger-browser';

// Export logger-database
export * from './logger-database';

// Export logger-config functions (but not re-exports from logger)
export {
  loggers,
  extractRequestContext,
  logRequest,
  logResponse,
  logAIRequest,
  logDatabaseQuery,
  logAuthEvent,
  logSecurityEvent,
  logPerformance,
  createRequestLogger,
  withLogging,
  setupErrorHandlers,
  logPerformanceDecorator,
  initializeLogging,
} from './logger-config';
