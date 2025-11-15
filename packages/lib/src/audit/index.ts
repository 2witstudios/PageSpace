/**
 * Audit Trail and Versioning Utilities
 *
 * Comprehensive utilities for tracking user and AI actions,
 * managing page versions, and querying audit trails.
 */

// Audit event creation
export {
  createAuditEvent,
  createBulkAuditEvents,
  computeChanges,
  type CreateAuditEventParams,
} from './create-audit-event';

// Page versioning
export {
  createPageVersion,
  getPageVersions,
  getPageVersion,
  getLatestPageVersion,
  comparePageVersions,
  restorePageVersion,
  getPageVersionStats,
  type CreatePageVersionParams,
} from './create-page-version';

// AI operation tracking
export {
  trackAiOperation,
  getUserAiOperations,
  getDriveAiOperations,
  getPageAiOperations,
  getAiUsageReport,
  getConversationAiOperations,
  getLatestAiOperation,
  getFailedAiOperations,
  getAiUsageSummary,
  type TrackAiOperationParams,
  type AiOperationController,
} from './track-ai-operation';

// Query utilities
export {
  getAuditEvents,
  getDriveActivityFeed,
  getUserActivityTimeline,
  getEntityHistory,
  getDriveAiActivity,
  getDriveHumanActivity,
  getOperationEvents,
  getMultiDriveActivity,
  getDriveActivityByDateRange,
  getDriveActivityStats,
  searchAuditEvents,
  getLatestEntityEvent,
  getEventsByActionType,
  getPageAuditEvents,
  getPagePermissionEvents,
  type AuditEventFilters,
} from './query-audit-events';

// Page-specific audit helpers
export {
  auditPageCreation,
  auditPageUpdate,
  auditPageDeletion,
  auditPageMove,
  auditPageRename,
  auditBulkPageOperation,
  extractAuditContext,
  type AuditContext,
} from './page-audit-helpers';

// AI tool audit wrapper
export {
  executeToolWithAudit,
  createAiOperationTracker,
  withAuditTracking,
  type AiToolContext,
  type AuditedToolResult,
  type AiOperationTrackingOptions,
} from './ai-tool-wrapper';

// AI operation ID extraction
export {
  extractAiOperationId,
  isAiInitiatedRequest,
  AI_OPERATION_ID_HEADER,
} from './extract-ai-operation-id';
