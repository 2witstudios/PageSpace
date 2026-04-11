/**
 * Fire-and-forget wrapper for security audit calls.
 * Catches rejections and logs a warning without blocking the caller.
 */

import { loggers } from '../logging/logger-config';

export function auditSafe(promise: Promise<void>, userId: string): void {
  promise.catch((err) => {
    loggers.security.warn('[SecurityAudit] audit log failed', {
      error: err instanceof Error ? err.message : String(err),
      userId,
    });
  });
}
