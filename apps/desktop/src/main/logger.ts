/**
 * Structured Logging Utility for Desktop App
 *
 * Provides consistent, context-rich logging across all main process modules.
 * Future enhancement: Could integrate with external logging services or file logging.
 */

export interface LogContext {
  [key: string]: unknown;
}

/**
 * Structured logger with severity levels
 * All methods accept a message string and optional context object
 */
export const logger = {
  /**
   * Debug-level logging for detailed diagnostic information
   * Use for: Verbose state changes, internal operations, diagnostic data
   */
  debug: (message: string, context?: LogContext): void => {
    console.log(`[DEBUG] ${message}`, context || {});
  },

  /**
   * Info-level logging for important events and state changes
   * Use for: Server start/stop, successful operations, key milestones
   */
  info: (message: string, context?: LogContext): void => {
    console.log(`[INFO] ${message}`, context || {});
  },

  /**
   * Warning-level logging for unexpected but recoverable conditions
   * Use for: Validation failures, missing optional data, deprecated usage
   */
  warn: (message: string, context?: LogContext): void => {
    console.warn(`[WARN] ${message}`, context || {});
  },

  /**
   * Error-level logging for failures and exceptions
   * Use for: Crashes, failed operations, critical errors
   */
  error: (message: string, context?: LogContext): void => {
    console.error(`[ERROR] ${message}`, context || {});
  },
};

/**
 * Helper function to sanitize error objects for logging
 * Extracts useful error information while avoiding circular references
 */
export function sanitizeError(error: unknown): LogContext {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      ...(error.cause ? { cause: sanitizeError(error.cause) } : {}),
    };
  }
  return { error: String(error) };
}
