/**
 * @module @pagespace/lib/logging
 * @description Logging infrastructure
 */

// Export logger core (types, enums, logger instance)
export * from './logger';
export * from './logger-types';

// Export browser logger (only unique exports, not duplicated types)
export {
  BrowserSafeLogger,
  browserLogger,
  browserLoggers,
} from './logger-browser';

// Export logger-database
export * from './logger-database';

// Export SIEM error hook (fire-and-forget delivery of application errors to SIEM webhook)
export {
  setSiemErrorHook,
  getSiemErrorHook,
  fireSiemErrorHook,
  buildWebhookSiemErrorHook,
  type SiemErrorPayload,
  type SiemErrorHookFn,
} from './siem-error-hook';

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
