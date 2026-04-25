// Environment validation
export { validateEnv, getEnvErrors, isEnvValid, getValidatedEnv } from './config/env-validation';

// All exports including Node.js-only utilities
export * from './auth/device-auth-utils';
export * from './auth/csrf-utils';
export { encrypt, decrypt } from './encryption/encryption-utils';
export * from './content/activity-diff-utils';
export * from './content/diff-utils';
export * from './content/export-utils';
export * from './content/page-content-format';
export * from './content/page-type-validators';
export * from './content/page-types.config';
export * from './content/tree-utils';
export * from './content/version-resolver';
export * from './content/diff-generator';
export * from './permissions/permissions';
export * from './auth/rate-limit-utils';
export * from './utils/utils';
export * from './utils/hash-utils';
export * from './utils/enums';
export * from './types';
export * from './file-processing/file-processor';
export * from './services/subscription-utils';
export * from './services/page-content-store';
export {
  computePageStateHash,
  createPageVersion,
  type PageVersionSource,
  type PageStateInput,
  type CreatePageVersionInput,
} from './services/page-version-service';
export * from './sheets/sheet';

// Drive service
export * from './services/drive-service';

// Drive member service
export * from './services/drive-member-service';

// Drive role service
export * from './services/drive-role-service';

// Drive search service
export * from './services/drive-search-service';

// OAuth utilities (server-only)
export * from './auth/oauth-utils';
export * from './auth/oauth-types';

// Logging utilities (server-only)
export * from './logging/logger';
export * from './logging/logger-types';
export {
  BrowserSafeLogger,
  browserLogger,
  browserLoggers,
} from './logging/logger-browser';
export * from './logging/logger-database';
export {
  setSiemErrorHook,
  getSiemErrorHook,
  fireSiemErrorHook,
  buildWebhookSiemErrorHook,
  type SiemErrorPayload,
  type SiemErrorHookFn,
} from './logging/siem-error-hook';
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
} from './logging/logger-config';

// Security audit (server-only)
export { maskEmail } from './audit/mask-email';
export { securityAudit } from './audit/security-audit';
export { audit, auditRequest } from './audit/audit-log';
export { queryAuditEvents } from './audit/audit-query';

// Monitoring (activity logging, AI monitoring)
export * from './monitoring/activity-tracker';
export * from './monitoring/activity-logger';
export * from './monitoring/change-group';
export * from './monitoring/ai-context-calculator';
export {
  AI_PRICING,
  MODEL_CONTEXT_WINDOWS,
  getContextWindow,
  calculateCost,
  trackAIUsage,
  trackAIToolUsage,
  getUserAIStats,
  getPopularAIFeatures,
  detectAIErrorPatterns,
  getTokenEfficiencyMetrics,
  AIMonitoring,
  type AIUsageData,
  type AIToolUsage,
} from './monitoring/ai-monitoring';

// Repository seams for testable database access
export {
  accountRepository,
  type AccountRepository,
  type UserAccount,
  type OwnedDrive,
  type DriveMemberCount,
} from './repositories/account-repository';
export {
  activityLogRepository,
  type ActivityLogRepository,
  type AnonymizeResult,
} from './repositories/activity-log-repository';
export {
  pageRepository,
  type PageRepository,
  type PageRecord,
  type PageTypeValue,
  type CreatePageInput,
  type UpdatePageInput,
} from './repositories/page-repository';
export {
  driveRepository,
  type DriveRepository,
  type DriveRecord,
  type DriveBasic,
} from './repositories/drive-repository';
export {
  agentRepository,
  type AgentRepository,
  type AgentRecord,
  type AgentConfigUpdate,
} from './repositories/agent-repository';
export {
  EnforcedFileRepository,
  ForbiddenError,
  type FileRecord,
  type FileUpdateInput,
} from './repositories/enforced-file-repository';

// Compliance — erasure (Art. 17 GDPR)
export { revokeUserIntegrationTokens, type OAuthRevokeResult } from './compliance/erasure/revoke-integration-tokens';

// Notifications
export * from './notifications/guards';
export * from './notifications/notifications';
export * from './notifications/push-notifications';
export * from './notifications/types';


// Zero-trust permission mutations (replaces old grantPagePermissions/revokePagePermissions)
export {
  grantPagePermission,
  revokePagePermission,
  type GrantResult,
  type RevokeResult,
  type PermissionMutationError,
} from './permissions/permission-mutations';
export {
  GrantInputSchema,
  RevokeInputSchema,
  PermissionFlagsSchema,
  type GrantInput,
  type RevokeInput,
  type PermissionFlags,
} from './permissions/schemas';

// Enforced auth context
export { EnforcedAuthContext } from './permissions/enforced-context';
