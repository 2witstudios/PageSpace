export {
  eq, ne, gt, gte, lt, lte, and, or, not, like, ilike, between,
  exists, isNull, isNotNull, inArray, count, sum, avg, max, min, asc,
  desc, sql,
} from './operators';
export type { SQL, InferSelectModel, InferInsertModel } from './operators';

export { db } from './db';

// Export schema for external use
export * from './schema';

// Explicit re-exports for commonly used tables (ensures they survive tree-shaking)
export {
  users,
  usersRelations,
  deviceTokens,
  deviceTokensRelations,
  mcpTokens,
  mcpTokensRelations,
  mcpTokenDrives,
  mcpTokenDrivesRelations,
  verificationTokens,
  verificationTokensRelations,
  socketTokens,
  socketTokensRelations,
  passkeys,
  passkeysRelations,
  emailUnsubscribeTokens,
  emailUnsubscribeTokensRelations,
  userRole,
  authProvider,
  platformType,
} from './schema/auth';

export {
  sessions,
  sessionsRelations,
} from './schema/sessions';

// Activity logging and monitoring re-exports
export {
  activityLogs,
  activityLogsRelations,
  activityResourceEnum,
  activityChangeGroupTypeEnum,
  contentFormatEnum,
  siemDeliveryCursors,
  siemDeliveryReceipts,
} from './schema/monitoring';

// Security audit logging re-exports
export {
  securityAuditLog,
  securityAuditLogRelations,
  type SecurityEventType,
  type InsertSecurityAuditLog,
  type SelectSecurityAuditLog,
} from './schema/security-audit';

// Hotkey preferences re-exports
export {
  userHotkeyPreferences,
  userHotkeyPreferencesRelations,
} from './schema/hotkeys';

// Personalization re-exports
export {
  userPersonalization,
  userPersonalizationRelations,
  type UserPersonalization,
  type NewUserPersonalization,
} from './schema/personalization';

// Push notification tokens re-exports
export {
  pushNotificationTokens,
  pushNotificationTokensRelations,
  pushPlatformType,
  type PushNotificationToken,
  type NewPushNotificationToken,
} from './schema/push-notifications';

// Note: Auth transaction functions are exported from '@pagespace/db/transactions/auth-transactions'
// They are NOT re-exported here to avoid circular dependency issues
// Import directly: import { atomicDeviceTokenRotation, ... } from '@pagespace/db/transactions/auth-transactions';