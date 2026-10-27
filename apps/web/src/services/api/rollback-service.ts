/**
 * Rollback Service
 *
 * Handles version history rollback operations for PageSpace. The implementation
 * lives under services/api/rollback/ (pure functional core + DI shell); this
 * module re-exports the frozen public API so existing consumers compile
 * untouched.
 */
export {
  getActivityById,
  previewRollback,
  executeRollback,
  getPageVersionHistory,
  getDriveVersionHistory,
  getUserRetentionDays,
} from './rollback'
export type {
  ActivityLogForRollback,
  RollbackPreview,
  RollbackResult,
  VersionHistoryOptions,
  RollbackContext,
} from './rollback'
