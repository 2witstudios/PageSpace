/**
 * Migrate barrel-level vi.mock() calls to direct subpath mocks.
 *
 * For each vi.mock('@pagespace/lib/<barrel>', factory) in a test file:
 * 1. Parse the factory's returned object to extract top-level keys
 * 2. Map each key to its correct subpath via the barrel symbol maps
 * 3. Split into one vi.mock() per subpath group
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, extname } from 'path';

const ROOT = new URL('..', import.meta.url).pathname;

// ─── Same symbol maps as migrate-barrel-imports.mjs ──────────────────────────

const SERVER_MAP = {
  loggers: '@pagespace/lib/logging/logger-config',
  logger: '@pagespace/lib/logging/logger-config',
  extractRequestContext: '@pagespace/lib/logging/logger-config',
  logSecurityEvent: '@pagespace/lib/logging/logger-config',
  logResponse: '@pagespace/lib/logging/logger-config',
  auditRequest: '@pagespace/lib/audit/audit-log',
  audit: '@pagespace/lib/audit/audit-log',
  queryAuditEvents: '@pagespace/lib/audit/audit-query',
  maskEmail: '@pagespace/lib/audit/mask-email',
  securityAudit: '@pagespace/lib/audit/security-audit',
  canUserViewPage: '@pagespace/lib/permissions/permissions',
  canUserEditPage: '@pagespace/lib/permissions/permissions',
  canUserDeletePage: '@pagespace/lib/permissions/permissions',
  getUserDriveAccess: '@pagespace/lib/permissions/permissions',
  getBatchPagePermissions: '@pagespace/lib/permissions/permissions',
  getUserAccessLevel: '@pagespace/lib/permissions/permissions',
  isDriveOwnerOrAdmin: '@pagespace/lib/permissions/permissions',
  getDriveIdsForUser: '@pagespace/lib/permissions/permissions',
  isUserDriveMember: '@pagespace/lib/permissions/permissions',
  getUserAccessiblePagesInDriveWithDetails: '@pagespace/lib/permissions/permissions',
  grantPagePermission: '@pagespace/lib/permissions/permission-mutations',
  revokePagePermission: '@pagespace/lib/permissions/permission-mutations',
  GrantResult: '@pagespace/lib/permissions/permission-mutations',
  RevokeResult: '@pagespace/lib/permissions/permission-mutations',
  PermissionMutationError: '@pagespace/lib/permissions/permission-mutations',
  GrantInputSchema: '@pagespace/lib/permissions/schemas',
  RevokeInputSchema: '@pagespace/lib/permissions/schemas',
  PermissionFlagsSchema: '@pagespace/lib/permissions/schemas',
  GrantInput: '@pagespace/lib/permissions/schemas',
  RevokeInput: '@pagespace/lib/permissions/schemas',
  PermissionFlags: '@pagespace/lib/permissions/schemas',
  EnforcedAuthContext: '@pagespace/lib/permissions/enforced-context',
  validateOrCreateDeviceToken: '@pagespace/lib/auth/device-auth-utils',
  validateDeviceToken: '@pagespace/lib/auth/device-auth-utils',
  updateDeviceTokenActivity: '@pagespace/lib/auth/device-auth-utils',
  generateDeviceToken: '@pagespace/lib/auth/device-auth-utils',
  getUserDeviceTokens: '@pagespace/lib/auth/device-auth-utils',
  revokeAllUserDeviceTokens: '@pagespace/lib/auth/device-auth-utils',
  createDeviceTokenRecord: '@pagespace/lib/auth/device-auth-utils',
  revokeExpiredDeviceTokens: '@pagespace/lib/auth/device-auth-utils',
  generateCSRFToken: '@pagespace/lib/auth/csrf-utils',
  validateCSRFToken: '@pagespace/lib/auth/csrf-utils',
  verifyOAuthIdToken: '@pagespace/lib/auth/oauth-utils',
  createOrLinkOAuthUser: '@pagespace/lib/auth/oauth-utils',
  OAuthProvider: '@pagespace/lib/auth/oauth-types',
  MobileOAuthResponse: '@pagespace/lib/auth/oauth-types',
  getActorInfo: '@pagespace/lib/monitoring/activity-logger',
  logPageActivity: '@pagespace/lib/monitoring/activity-logger',
  logDriveActivity: '@pagespace/lib/monitoring/activity-logger',
  logMessageActivity: '@pagespace/lib/monitoring/activity-logger',
  ActivityOperation: '@pagespace/lib/monitoring/activity-logger',
  logActivityWithTx: '@pagespace/lib/monitoring/activity-logger',
  DeferredWorkflowTrigger: '@pagespace/lib/monitoring/activity-logger',
  ActivityResourceType: '@pagespace/lib/monitoring/activity-logger',
  logRollbackActivity: '@pagespace/lib/monitoring/activity-logger',
  logPermissionActivity: '@pagespace/lib/monitoring/activity-logger',
  logConversationUndo: '@pagespace/lib/monitoring/activity-logger',
  createChangeGroupId: '@pagespace/lib/monitoring/change-group',
  inferChangeGroupType: '@pagespace/lib/monitoring/change-group',
  ChangeGroupType: '@pagespace/lib/monitoring/change-group',
  readPageContent: '@pagespace/lib/services/page-content-store',
  writePageContent: '@pagespace/lib/services/page-content-store',
  computePageStateHash: '@pagespace/lib/services/page-version-service',
  createPageVersion: '@pagespace/lib/services/page-version-service',
  PageVersionSource: '@pagespace/lib/services/page-version-service',
  checkDriveAccess: '@pagespace/lib/services/drive-member-service',
  listDriveMembers: '@pagespace/lib/services/drive-member-service',
  MemberWithDetails: '@pagespace/lib/services/drive-member-service',
  DriveAccessResult: '@pagespace/lib/services/drive-member-service',
  isMemberOfDrive: '@pagespace/lib/services/drive-member-service',
  addDriveMember: '@pagespace/lib/services/drive-member-service',
  getDriveMemberUserIds: '@pagespace/lib/services/drive-member-service',
  getDriveMemberDetails: '@pagespace/lib/services/drive-member-service',
  getMemberPermissions: '@pagespace/lib/services/drive-member-service',
  updateMemberRole: '@pagespace/lib/services/drive-member-service',
  updateMemberPermissions: '@pagespace/lib/services/drive-member-service',
  checkDriveAccessForRoles: '@pagespace/lib/services/drive-role-service',
  validateRolePermissions: '@pagespace/lib/services/drive-role-service',
  listDriveRoles: '@pagespace/lib/services/drive-role-service',
  getRoleById: '@pagespace/lib/services/drive-role-service',
  createDriveRole: '@pagespace/lib/services/drive-role-service',
  updateDriveRole: '@pagespace/lib/services/drive-role-service',
  deleteDriveRole: '@pagespace/lib/services/drive-role-service',
  reorderDriveRoles: '@pagespace/lib/services/drive-role-service',
  DriveRoleAccessInfo: '@pagespace/lib/services/drive-role-service',
  RolePermissions: '@pagespace/lib/services/drive-role-service',
  CreateRoleInput: '@pagespace/lib/services/drive-role-service',
  DriveRole: '@pagespace/lib/services/drive-role-service',
  regexSearchPages: '@pagespace/lib/services/drive-search-service',
  globSearchPages: '@pagespace/lib/services/drive-search-service',
  checkDriveAccessForSearch: '@pagespace/lib/services/drive-search-service',
  getDriveById: '@pagespace/lib/services/drive-service',
  getDriveWithAccess: '@pagespace/lib/services/drive-service',
  DriveWithAccess: '@pagespace/lib/services/drive-service',
  DriveAccessInfo: '@pagespace/lib/services/drive-service',
  listAccessibleDrives: '@pagespace/lib/services/drive-service',
  createDrive: '@pagespace/lib/services/drive-service',
  updateDrive: '@pagespace/lib/services/drive-service',
  trashDrive: '@pagespace/lib/services/drive-service',
  getDriveAccess: '@pagespace/lib/services/drive-service',
  getDriveAccessWithDrive: '@pagespace/lib/services/drive-service',
  buildTree: '@pagespace/lib/content/tree-utils',
  isDocumentPage: '@pagespace/lib/content/page-types.config',
  isAIChatPage: '@pagespace/lib/content/page-types.config',
  isFolderPage: '@pagespace/lib/content/page-types.config',
  isFilePage: '@pagespace/lib/content/page-types.config',
  isSheetPage: '@pagespace/lib/content/page-types.config',
  isCodePage: '@pagespace/lib/content/page-types.config',
  getPageTypeEmoji: '@pagespace/lib/content/page-types.config',
  getDefaultContent: '@pagespace/lib/content/page-types.config',
  getCreatablePageTypes: '@pagespace/lib/content/page-types.config',
  detectPageContentFormat: '@pagespace/lib/content/page-content-format',
  validatePageCreation: '@pagespace/lib/content/page-type-validators',
  canConvertToType: '@pagespace/lib/content/page-type-validators',
  validatePageUpdate: '@pagespace/lib/content/page-type-validators',
  validateAIChatTools: '@pagespace/lib/content/page-type-validators',
  slugify: '@pagespace/lib/utils/utils',
  hashWithPrefix: '@pagespace/lib/utils/hash-utils',
  PageType: '@pagespace/lib/utils/enums',
  accountRepository: '@pagespace/lib/repositories',
  activityLogRepository: '@pagespace/lib/repositories',
  pageRepository: '@pagespace/lib/repositories',
  driveRepository: '@pagespace/lib/repositories',
  agentRepository: '@pagespace/lib/repositories',
  parseSheetContent: '@pagespace/lib/sheets',
  serializeSheetContent: '@pagespace/lib/sheets',
  isSheetType: '@pagespace/lib/sheets',
  updateSheetCells: '@pagespace/lib/sheets',
  isValidCellAddress: '@pagespace/lib/sheets',
  encrypt: '@pagespace/lib/encryption',
  decrypt: '@pagespace/lib/encryption',
  validateEnv: '@pagespace/lib/config/env-validation',
  getEnvErrors: '@pagespace/lib/config/env-validation',
  isEnvValid: '@pagespace/lib/config/env-validation',
  getValidatedEnv: '@pagespace/lib/config/env-validation',
};

// For @pagespace/lib/permissions barrel (already removed from source, but tests still use it)
const PERMISSIONS_MAP = {
  canUserViewPage: '@pagespace/lib/permissions/permissions',
  canUserEditPage: '@pagespace/lib/permissions/permissions',
  canUserDeletePage: '@pagespace/lib/permissions/permissions',
  getUserDriveAccess: '@pagespace/lib/permissions/permissions',
  getBatchPagePermissions: '@pagespace/lib/permissions/permissions',
  getUserAccessLevel: '@pagespace/lib/permissions/permissions',
  isDriveOwnerOrAdmin: '@pagespace/lib/permissions/permissions',
  getDriveIdsForUser: '@pagespace/lib/permissions/permissions',
  isUserDriveMember: '@pagespace/lib/permissions/permissions',
  getUserAccessiblePagesInDriveWithDetails: '@pagespace/lib/permissions/permissions',
  grantPagePermission: '@pagespace/lib/permissions/permission-mutations',
  revokePagePermission: '@pagespace/lib/permissions/permission-mutations',
  GrantResult: '@pagespace/lib/permissions/permission-mutations',
  RevokeResult: '@pagespace/lib/permissions/permission-mutations',
  EnforcedAuthContext: '@pagespace/lib/permissions/enforced-context',
  canUserRollback: '@pagespace/lib/permissions/rollback-permissions',
  isRollbackableOperation: '@pagespace/lib/permissions/rollback-permissions',
};

const AUTH_MAP = {
  sessionService: '@pagespace/lib/auth/session-service',
  SessionClaims: '@pagespace/lib/auth/session-service',
  generateCSRFToken: '@pagespace/lib/auth/csrf-utils',
  validateCSRFToken: '@pagespace/lib/auth/csrf-utils',
  SESSION_DURATION_MS: '@pagespace/lib/auth/constants',
  createExchangeCode: '@pagespace/lib/auth/exchange-codes',
  consumeExchangeCode: '@pagespace/lib/auth/exchange-codes',
  verifyAppleIdToken: '@pagespace/lib/auth/oauth-utils',
  hashToken: '@pagespace/lib/auth/token-utils',
  getTokenPrefix: '@pagespace/lib/auth/token-utils',
  generateToken: '@pagespace/lib/auth/token-utils',
  deletePasskey: '@pagespace/lib/auth/passkey-service',
  updatePasskeyName: '@pagespace/lib/auth/passkey-service',
  listUserPasskeys: '@pagespace/lib/auth/passkey-service',
  verifyAuthentication: '@pagespace/lib/auth/passkey-service',
  generateAuthenticationOptions: '@pagespace/lib/auth/passkey-service',
  verifyRegistration: '@pagespace/lib/auth/passkey-service',
  consumePasskeyRegisterHandoff: '@pagespace/lib/auth/passkey-register-handoff',
  createPasskeyRegisterHandoff: '@pagespace/lib/auth/passkey-register-handoff',
  generateRegistrationOptions: '@pagespace/lib/auth/passkey-service',
  peekPasskeyRegisterHandoff: '@pagespace/lib/auth/passkey-register-handoff',
  markPasskeyRegisterOptionsIssued: '@pagespace/lib/auth/passkey-register-handoff',
  verifySignupRegistration: '@pagespace/lib/auth/passkey-service',
  generateRegistrationOptionsForSignup: '@pagespace/lib/auth/passkey-service',
  consumePKCEVerifier: '@pagespace/lib/auth/pkce',
  generatePKCE: '@pagespace/lib/auth/pkce',
  validateOrCreateDeviceToken: '@pagespace/lib/auth/device-auth-utils',
  isValidTokenFormat: '@pagespace/lib/auth/opaque-tokens',
  getTokenType: '@pagespace/lib/auth/opaque-tokens',
  secureCompare: '@pagespace/lib/auth/secure-compare',
};

const SECURITY_MAP = {
  validateUrl: '@pagespace/lib/security/url-validator',
  isUrlAllowed: '@pagespace/lib/security/url-validator',
  checkUrlSecurity: '@pagespace/lib/security/url-validator',
  UrlValidationResult: '@pagespace/lib/security/url-validator',
  resolvePathWithin: '@pagespace/lib/security/path-validator',
  resolvePathWithinSync: '@pagespace/lib/security/path-validator',
  sweepExpiredRevokedJTIs: '@pagespace/lib/security/jti-revocation',
  sweepExpiredRateLimitBuckets: '@pagespace/lib/security/distributed-rate-limit',
  checkRateLimit: '@pagespace/lib/security/distributed-rate-limit',
  checkDistributedRateLimit: '@pagespace/lib/security/distributed-rate-limit',
  resetDistributedRateLimit: '@pagespace/lib/security/distributed-rate-limit',
  DISTRIBUTED_RATE_LIMITS: '@pagespace/lib/security/distributed-rate-limit',
  sweepExpiredAuthHandoffTokens: '@pagespace/lib/security/auth-handoff-sweep',
};

const MONITORING_MAP = {
  getActorInfo: '@pagespace/lib/monitoring/activity-logger',
  logPageActivity: '@pagespace/lib/monitoring/activity-logger',
  logDriveActivity: '@pagespace/lib/monitoring/activity-logger',
  logMessageActivity: '@pagespace/lib/monitoring/activity-logger',
  ActivityOperation: '@pagespace/lib/monitoring/activity-logger',
  ActivityResourceType: '@pagespace/lib/monitoring/activity-logger',
  logActivityWithTx: '@pagespace/lib/monitoring/activity-logger',
  DeferredWorkflowTrigger: '@pagespace/lib/monitoring/activity-logger',
  logRollbackActivity: '@pagespace/lib/monitoring/activity-logger',
  logPermissionActivity: '@pagespace/lib/monitoring/activity-logger',
  logConversationUndo: '@pagespace/lib/monitoring/activity-logger',
  createChangeGroupId: '@pagespace/lib/monitoring/change-group',
  inferChangeGroupType: '@pagespace/lib/monitoring/change-group',
  ChangeGroupType: '@pagespace/lib/monitoring/change-group',
  trackAIUsage: '@pagespace/lib/monitoring/ai-monitoring',
  getAIUsageStats: '@pagespace/lib/monitoring/ai-monitoring',
  calculateAIContext: '@pagespace/lib/monitoring/ai-context-calculator',
};

const AUDIT_MAP = {
  audit: '@pagespace/lib/audit/audit-log',
  auditRequest: '@pagespace/lib/audit/audit-log',
  queryAuditEvents: '@pagespace/lib/audit/audit-query',
  maskEmail: '@pagespace/lib/audit/mask-email',
  securityAudit: '@pagespace/lib/audit/security-audit',
};

const CONTENT_MAP = {
  buildTree: '@pagespace/lib/content/tree-utils',
  isDocumentPage: '@pagespace/lib/content/page-types.config',
  isAIChatPage: '@pagespace/lib/content/page-types.config',
  isFolderPage: '@pagespace/lib/content/page-types.config',
  isFilePage: '@pagespace/lib/content/page-types.config',
  isSheetPage: '@pagespace/lib/content/page-types.config',
  isCodePage: '@pagespace/lib/content/page-types.config',
  getPageTypeEmoji: '@pagespace/lib/content/page-types.config',
  getDefaultContent: '@pagespace/lib/content/page-types.config',
  getCreatablePageTypes: '@pagespace/lib/content/page-types.config',
  detectPageContentFormat: '@pagespace/lib/content/page-content-format',
  validatePageCreation: '@pagespace/lib/content/page-type-validators',
  canConvertToType: '@pagespace/lib/content/page-type-validators',
  validatePageUpdate: '@pagespace/lib/content/page-type-validators',
  validateAIChatTools: '@pagespace/lib/content/page-type-validators',
};

const NOTIFICATIONS_MAP = {
  registerPushToken: '@pagespace/lib/notifications/push-notifications',
  unregisterPushToken: '@pagespace/lib/notifications/push-notifications',
  getUserPushTokens: '@pagespace/lib/notifications/push-notifications',
  sendNotification: '@pagespace/lib/notifications/notifications',
  sendPushNotification: '@pagespace/lib/notifications/push-notifications',
};

const INTEGRATIONS_MAP = {
  getConnectionById: '@pagespace/lib/integrations/repositories/connection-repository',
  getConnectionWithProvider: '@pagespace/lib/integrations/repositories/connection-repository',
  createConnection: '@pagespace/lib/integrations/repositories/connection-repository',
  deleteConnection: '@pagespace/lib/integrations/repositories/connection-repository',
  findDriveConnection: '@pagespace/lib/integrations/repositories/connection-repository',
  findUserConnection: '@pagespace/lib/integrations/repositories/connection-repository',
  listUserConnections: '@pagespace/lib/integrations/repositories/connection-repository',
  listDriveConnections: '@pagespace/lib/integrations/repositories/connection-repository',
  getProviderById: '@pagespace/lib/integrations/repositories/provider-repository',
  listEnabledProviders: '@pagespace/lib/integrations/repositories/provider-repository',
  createProvider: '@pagespace/lib/integrations/repositories/provider-repository',
  getGrantById: '@pagespace/lib/integrations/repositories/grant-repository',
  listGrantsByAgent: '@pagespace/lib/integrations/repositories/grant-repository',
  buildOAuthAuthorizationUrl: '@pagespace/lib/integrations/oauth/oauth-handler',
  exchangeOAuthCode: '@pagespace/lib/integrations/oauth/oauth-handler',
  createSignedState: '@pagespace/lib/integrations/oauth/oauth-state',
  verifySignedState: '@pagespace/lib/integrations/oauth/oauth-state',
  builtinProviderList: '@pagespace/lib/integrations/providers',
  encryptCredentials: '@pagespace/lib/integrations/credentials/encrypt-credentials',
  IntegrationProviderConfig: '@pagespace/lib/integrations/types',
};

// @pagespace/lib root barrel (complete symbol map)
const LIB_ROOT_MAP = {
  // Deployment mode
  isOnPrem: '@pagespace/lib/deployment-mode',
  isCloud: '@pagespace/lib/deployment-mode',
  isTenantMode: '@pagespace/lib/deployment-mode',
  isBillingEnabled: '@pagespace/lib/deployment-mode',
  getOnPremUserDefaults: '@pagespace/lib/onprem-defaults',
  getOnPremOllamaSettings: '@pagespace/lib/onprem-defaults',
  // Permissions
  canUserViewPage: '@pagespace/lib/permissions/permissions',
  canUserEditPage: '@pagespace/lib/permissions/permissions',
  canUserDeletePage: '@pagespace/lib/permissions/permissions',
  getUserDriveAccess: '@pagespace/lib/permissions/permissions',
  getBatchPagePermissions: '@pagespace/lib/permissions/permissions',
  getUserAccessLevel: '@pagespace/lib/permissions/permissions',
  isDriveOwnerOrAdmin: '@pagespace/lib/permissions/permissions',
  getDriveIdsForUser: '@pagespace/lib/permissions/permissions',
  isUserDriveMember: '@pagespace/lib/permissions/permissions',
  getUserAccessiblePagesInDriveWithDetails: '@pagespace/lib/permissions/permissions',
  grantPagePermission: '@pagespace/lib/permissions/permission-mutations',
  revokePagePermission: '@pagespace/lib/permissions/permission-mutations',
  EnforcedAuthContext: '@pagespace/lib/permissions/enforced-context',
  // Auth
  sessionService: '@pagespace/lib/auth/session-service',
  SessionClaims: '@pagespace/lib/auth/session-service',
  CreateSessionOptions: '@pagespace/lib/auth/session-service',
  generateCSRFToken: '@pagespace/lib/auth/csrf-utils',
  validateCSRFToken: '@pagespace/lib/auth/csrf-utils',
  secureCompare: '@pagespace/lib/auth/secure-compare',
  isEmailVerified: '@pagespace/lib/auth/verification-utils',
  createVerificationToken: '@pagespace/lib/auth/verification-utils',
  cleanupExpiredDeviceTokens: '@pagespace/lib/auth/device-auth-utils',
  validateOrCreateDeviceToken: '@pagespace/lib/auth/device-auth-utils',
  // Service tokens
  createValidatedServiceToken: '@pagespace/lib/services/validated-service-token',
  createPageServiceToken: '@pagespace/lib/services/validated-service-token',
  createDriveServiceToken: '@pagespace/lib/services/validated-service-token',
  createUserServiceToken: '@pagespace/lib/services/validated-service-token',
  ServiceScope: '@pagespace/lib/services/validated-service-token',
  ValidatedTokenOptions: '@pagespace/lib/services/validated-service-token',
  ValidatedTokenResult: '@pagespace/lib/services/validated-service-token',
  PermissionSet: '@pagespace/lib/services/validated-service-token',
  ResourceType: '@pagespace/lib/services/validated-service-token',
  // Notifications
  createNotification: '@pagespace/lib/notifications/notifications',
  createDriveNotification: '@pagespace/lib/notifications/notifications',
  createOrUpdateMessageNotification: '@pagespace/lib/notifications/notifications',
  createPermissionNotification: '@pagespace/lib/notifications/notifications',
  markNotificationAsRead: '@pagespace/lib/notifications/notifications',
  deleteNotification: '@pagespace/lib/notifications/notifications',
  markAllNotificationsAsRead: '@pagespace/lib/notifications/notifications',
  getUserNotifications: '@pagespace/lib/notifications/notifications',
  getUnreadNotificationCount: '@pagespace/lib/notifications/notifications',
  // Content
  isDocumentPage: '@pagespace/lib/content/page-types.config',
  isAIChatPage: '@pagespace/lib/content/page-types.config',
  isFolderPage: '@pagespace/lib/content/page-types.config',
  isFilePage: '@pagespace/lib/content/page-types.config',
  isSheetPage: '@pagespace/lib/content/page-types.config',
  isCodePage: '@pagespace/lib/content/page-types.config',
  getPageTypeEmoji: '@pagespace/lib/content/page-types.config',
  getDefaultContent: '@pagespace/lib/content/page-types.config',
  getCreatablePageTypes: '@pagespace/lib/content/page-types.config',
  buildTree: '@pagespace/lib/content/tree-utils',
  formatTreeAsMarkdown: '@pagespace/lib/content/tree-utils',
  filterToSubtree: '@pagespace/lib/content/tree-utils',
  detectPageContentFormat: '@pagespace/lib/content/page-content-format',
  validatePageCreation: '@pagespace/lib/content/page-type-validators',
  canConvertToType: '@pagespace/lib/content/page-type-validators',
  validatePageUpdate: '@pagespace/lib/content/page-type-validators',
  validateAIChatTools: '@pagespace/lib/content/page-type-validators',
  generateCSV: '@pagespace/lib/content/export-utils',
  generateDOCX: '@pagespace/lib/content/export-utils',
  generateExcel: '@pagespace/lib/content/export-utils',
  sanitizeFilename: '@pagespace/lib/content/export-utils',
  // Utils/types
  PageType: '@pagespace/lib/utils/enums',
  slugify: '@pagespace/lib/utils/utils',
  isValidEmail: '@pagespace/lib/validators/email',
  isValidId: '@pagespace/lib/validators/id-validators',
  parseUserId: '@pagespace/lib/validators/id-validators',
  parsePageId: '@pagespace/lib/validators/id-validators',
  InboxItem: '@pagespace/lib/types',
  InboxResponse: '@pagespace/lib/types',
  // Encryption
  encrypt: '@pagespace/lib/encryption',
  decrypt: '@pagespace/lib/encryption',
  // Logging
  loggers: '@pagespace/lib/logging/logger-config',
  logger: '@pagespace/lib/logging/logger-config',
  deleteAiUsageLogsForUser: '@pagespace/lib/logging/ai-usage-purge',
  deleteMonitoringDataForUser: '@pagespace/lib/logging/monitoring-purge',
  anonymizeAiUsageContent: '@pagespace/lib/logging/ai-usage-purge',
  purgeAiUsageLogs: '@pagespace/lib/logging/ai-usage-purge',
  // Audit
  verifyAndAlert: '@pagespace/lib/audit/security-audit-alerting',
  // Services
  getTomorrowMidnightUTC: '@pagespace/lib/services/date-utils',
  getTodayUTC: '@pagespace/lib/services/date-utils',
  getSecondsUntilMidnightUTC: '@pagespace/lib/services/date-utils',
  rateLimitCache: '@pagespace/lib/services/rate-limit-cache',
  ProviderType: '@pagespace/lib/services/rate-limit-cache',
  UsageTrackingResult: '@pagespace/lib/services/rate-limit-cache',
  // Sheets
  parseSheetContent: '@pagespace/lib/sheets',
  serializeSheetContent: '@pagespace/lib/sheets',
  isSheetType: '@pagespace/lib/sheets',
  updateSheetCells: '@pagespace/lib/sheets',
  createEmptySheet: '@pagespace/lib/sheets/io',
};

const BARREL_MAPS = {
  '@pagespace/lib/server': SERVER_MAP,
  '@pagespace/lib/auth': AUTH_MAP,
  '@pagespace/lib/permissions': PERMISSIONS_MAP,
  '@pagespace/lib/security': SECURITY_MAP,
  '@pagespace/lib/monitoring': MONITORING_MAP,
  '@pagespace/lib/audit': AUDIT_MAP,
  '@pagespace/lib/content': CONTENT_MAP,
  '@pagespace/lib/notifications': NOTIFICATIONS_MAP,
  '@pagespace/lib/integrations': INTEGRATIONS_MAP,
  '@pagespace/lib': LIB_ROOT_MAP,
};

// ─── Object literal parser ────────────────────────────────────────────────────

/**
 * Extract top-level key-value pairs from an object literal string.
 * Handles nested braces, parens, brackets, template literals, and strings.
 * Returns array of { key, value } where value is the raw source string.
 */
function extractTopLevelKeys(objStr) {
  // Strip outer braces
  const inner = objStr.trim();
  if (!inner.startsWith('{') || !inner.endsWith('}')) {
    return null; // Not an object literal
  }
  const body = inner.slice(1, -1);

  const pairs = [];
  let i = 0;
  const n = body.length;

  function skipWhitespace() {
    while (i < n && /\s/.test(body[i])) i++;
  }

  function skipBalanced(open, close) {
    let depth = 1;
    i++; // skip opening
    while (i < n && depth > 0) {
      if (body[i] === open) depth++;
      else if (body[i] === close) depth--;
      else if (body[i] === '"' || body[i] === "'") {
        const q = body[i++];
        while (i < n && body[i] !== q) {
          if (body[i] === '\\') i++;
          i++;
        }
      } else if (body[i] === '`') {
        i++;
        while (i < n && body[i] !== '`') {
          if (body[i] === '\\') i++;
          i++;
        }
      }
      i++;
    }
  }

  function readValue() {
    const start = i;
    let depth = 0;
    while (i < n) {
      const ch = body[i];
      if ((ch === ',' || ch === '}') && depth === 0) break;
      if (ch === '{' || ch === '(' || ch === '[') depth++;
      else if (ch === '}' || ch === ')' || ch === ']') depth--;
      else if (ch === '"' || ch === "'") {
        const q = body[i++];
        while (i < n && body[i] !== q) {
          if (body[i] === '\\') i++;
          i++;
        }
      } else if (ch === '`') {
        i++;
        while (i < n && body[i] !== '`') {
          if (body[i] === '\\') i++;
          i++;
        }
      }
      i++;
    }
    return body.slice(start, i).trim();
  }

  while (i < n) {
    skipWhitespace();
    if (i >= n) break;

    // Handle spread: ...something
    if (body.slice(i, i + 3) === '...') {
      i += 3;
      const start = i;
      while (i < n && body[i] !== ',' && body[i] !== '}') i++;
      pairs.push({ spread: body.slice(start, i).trim() });
      skipWhitespace();
      if (body[i] === ',') i++;
      continue;
    }

    // Handle computed keys: [expr]: value
    if (body[i] === '[') {
      const start = i;
      let depth = 1;
      i++;
      while (i < n && depth > 0) {
        if (body[i] === '[') depth++;
        else if (body[i] === ']') depth--;
        i++;
      }
      const keyExpr = body.slice(start, i).trim();
      skipWhitespace();
      if (body[i] === ':') i++;
      skipWhitespace();
      const value = readValue();
      pairs.push({ computedKey: keyExpr, value });
      skipWhitespace();
      if (body[i] === ',') i++;
      continue;
    }

    // Handle trailing comment
    if (body.slice(i, i + 2) === '//') {
      while (i < n && body[i] !== '\n') i++;
      continue;
    }
    if (body.slice(i, i + 2) === '/*') {
      while (i < n && body.slice(i, i + 2) !== '*/') i++;
      i += 2;
      continue;
    }

    // Read key (identifier or quoted string)
    let key = '';
    if (body[i] === '"' || body[i] === "'") {
      const q = body[i++];
      while (i < n && body[i] !== q) {
        if (body[i] === '\\') i++;
        key += body[i++];
      }
      i++; // closing quote
    } else {
      while (i < n && /[\w$]/.test(body[i])) {
        key += body[i++];
      }
    }

    if (!key) { i++; continue; }

    skipWhitespace();

    // Shorthand: { foo } or method shorthand: { foo() {...} }
    if (body[i] === ',' || body[i] === '}' || i >= n) {
      pairs.push({ key, value: key }); // shorthand
      if (body[i] === ',') i++;
      continue;
    }

    // Method shorthand or async method: foo() { ... }
    if (body[i] === '(') {
      const start = i;
      skipBalanced('(', ')');
      skipWhitespace();
      if (body[i] === '{') {
        const valStart = i;
        skipBalanced('{', '}');
        const value = body.slice(start, i).trim();
        pairs.push({ key, value: `function ${value}` });
      } else {
        pairs.push({ key, value: body.slice(start, i).trim() });
      }
      skipWhitespace();
      if (body[i] === ',') i++;
      continue;
    }

    if (body[i] !== ':') {
      // Unexpected - skip
      while (i < n && body[i] !== ',' && body[i] !== '}') i++;
      if (body[i] === ',') i++;
      continue;
    }
    i++; // skip ':'
    skipWhitespace();

    const value = readValue();
    pairs.push({ key, value });
    skipWhitespace();
    if (body[i] === ',') i++;
  }

  return pairs;
}

// ─── Find the factory object from a vi.mock call ─────────────────────────────

/**
 * Given the content of a vi.mock factory (everything after the barrel path arg),
 * extract the returned object literal string.
 *
 * Handles:
 *   () => ({ ... })
 *   () => { return { ... }; }
 *   async () => ({ ... })
 *   async (importOriginal) => ({ ...await importOriginal(), ... })
 */
function extractFactoryObject(factoryStr) {
  // Find the factory function body
  const arrowIdx = factoryStr.indexOf('=>');
  if (arrowIdx === -1) return null;

  let body = factoryStr.slice(arrowIdx + 2).trim();

  // Handle async (importOriginal) pattern - mark as complex
  if (factoryStr.includes('importOriginal')) {
    return { complex: true, raw: factoryStr };
  }

  // Arrow with parenthesized object: => ({ ... })
  if (body.startsWith('(')) {
    // Find matching close paren, accounting for the outer parens wrapping the object
    let depth = 0;
    let start = -1;
    let end = -1;
    for (let i = 0; i < body.length; i++) {
      if (body[i] === '(') {
        if (depth === 0) start = i;
        depth++;
      } else if (body[i] === ')') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (start !== -1 && end !== -1) {
      const inner = body.slice(start + 1, end).trim();
      if (inner.startsWith('{')) return { object: inner };
    }
  }

  // Arrow with block body: => { return { ... }; }
  if (body.startsWith('{')) {
    const returnMatch = body.match(/return\s*(\{[\s\S]*\})\s*;?\s*\}/);
    if (returnMatch) return { object: returnMatch[1] };
  }

  return null;
}

// ─── Build replacement mocks ──────────────────────────────────────────────────

function buildMockReplacement(barrelPath, factoryRaw, barrelMap) {
  const parsed = extractFactoryObject(factoryRaw);

  if (!parsed) {
    // No factory (automock) - can't split, leave as direct subpath
    // Return a comment noting it couldn't be split
    return { canSplit: false, reason: 'no-factory' };
  }

  if (parsed.complex) {
    return { canSplit: false, reason: 'importOriginal', raw: factoryRaw };
  }

  const pairs = extractTopLevelKeys(parsed.object);
  if (!pairs) {
    return { canSplit: false, reason: 'parse-failed' };
  }

  // Group pairs by target subpath
  const bySubpath = new Map();
  const unknown = [];

  for (const pair of pairs) {
    if (pair.spread) {
      unknown.push({ spread: pair.spread });
      continue;
    }
    if (pair.computedKey) {
      unknown.push({ computedKey: pair.computedKey, value: pair.value });
      continue;
    }

    const subpath = barrelMap[pair.key];
    if (subpath) {
      if (!bySubpath.has(subpath)) bySubpath.set(subpath, []);
      bySubpath.get(subpath).push(pair);
    } else {
      unknown.push(pair);
    }
  }

  const lines = [];

  for (const [subpath, pairs] of bySubpath) {
    const entries = pairs.map(p => `    ${p.key}: ${p.value}`).join(',\n');
    lines.push(`vi.mock('${subpath}', () => ({\n${entries},\n}));`);
  }

  if (unknown.length > 0) {
    // Unknown, spread, or computed entries cannot be safely mapped to a subpath.
    // Emitting a fallback vi.mock(barrelPath, ...) would leave barrel aliases in
    // "migrated" files and silently defeat the barrel-removal goal.
    // Instead, skip the mock and report it for manual handling.
    const names = unknown.map(u => u.spread ? `...${u.spread}` : (u.computedKey || u.key)).join(', ');
    console.warn(`  SKIP (manual): ${barrelPath} — unmapped keys: ${names}`);
    return { canSplit: false, reason: `unmapped-keys: ${names}`, replacement: null };
  }

  return { canSplit: true, replacement: lines.join('\n') };
}

// ─── Process a single file ────────────────────────────────────────────────────

function migrateTestFile(filePath) {
  let source = readFileSync(filePath, 'utf8');
  let modified = source;
  let changed = false;
  const issues = [];

  for (const [barrelPath, barrelMap] of Object.entries(BARREL_MAPS)) {
    // Match vi.mock('<barrel>', ...) - may have factory or not
    // Need to find the full vi.mock() call including balanced parens
    const escapedBarrel = barrelPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const mockStart = new RegExp(`vi\\.mock\\s*\\(\\s*['"]${escapedBarrel}['"]`, 'g');

    let match;
    const replacements = [];

    while ((match = mockStart.exec(modified)) !== null) {
      const startIdx = match.index;

      // Find the full vi.mock(...) call by counting balanced parens
      let depth = 0;
      let i = startIdx + match[0].indexOf('(');
      const len = modified.length;

      while (i < len) {
        const ch = modified[i];
        if (ch === '(') depth++;
        else if (ch === ')') {
          depth--;
          if (depth === 0) { i++; break; }
        } else if (ch === '"' || ch === "'") {
          const q = modified[i++];
          while (i < len && modified[i] !== q) {
            if (modified[i] === '\\') i++;
            i++;
          }
        } else if (ch === '`') {
          i++;
          while (i < len && modified[i] !== '`') {
            if (modified[i] === '\\') i++;
            i++;
          }
        }
        i++;
      }
      // Consume trailing semicolon (but don't include in fullCall — replacement handles it)
      let endIdx = i;
      if (endIdx < len && modified[endIdx] === ';') endIdx++;

      // fullCall is the vi.mock(...) call WITHOUT the trailing semicolon
      const fullCall = modified.slice(startIdx, i);

      // Extract the factory part: everything between the barrel string and the outer closing paren
      // fullCall = vi.mock('barrel', factoryFn)
      // afterBarrel = , factoryFn)  or  )
      const afterBarrel = fullCall.slice(match[0].length); // strips `vi.mock('barrel'`
      // Strip trailing outer `)` from the vi.mock call
      const afterBarrelTrimmed = afterBarrel.trimEnd().replace(/\)$/, '').trimEnd();
      // afterBarrelTrimmed = , factoryFn  or empty string
      const factoryMatch = afterBarrelTrimmed.match(/^,\s*([\s\S]*)$/);
      const factoryRaw = factoryMatch ? factoryMatch[1].trim() : null;

      // Update end to include the semicolon in the replaced range
      i = endIdx;

      if (!factoryRaw) {
        // No factory - automock, can't split safely
        issues.push(`  [SKIP] No factory in ${filePath.replace(ROOT, '')}: ${fullCall.slice(0, 60)}...`);
        continue;
      }

      const result = buildMockReplacement(barrelPath, factoryRaw.trim(), barrelMap);

      if (!result.canSplit) {
        issues.push(`  [SKIP] ${result.reason} in ${filePath.replace(ROOT, '')}`);
        continue;
      }

      replacements.push({
        start: startIdx,
        end: i,
        replacement: result.replacement,
      });
    }

    // Apply in reverse order to preserve positions
    for (const r of replacements.reverse()) {
      modified = modified.slice(0, r.start) + r.replacement + modified.slice(r.end);
      changed = true;
    }

    // Reset regex lastIndex after modifying string
    mockStart.lastIndex = 0;
  }

  if (changed) {
    writeFileSync(filePath, modified, 'utf8');
  }

  return { changed, issues };
}

// ─── Walk files ───────────────────────────────────────────────────────────────

function getAllFiles(dir) {
  const results = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', '.next', 'dist'].includes(e.name)) continue;
      results.push(...getAllFiles(full));
    } else if (['.ts', '.tsx'].includes(extname(full)) && (full.includes('__tests__') || full.includes('.test.'))) {
      results.push(full);
    }
  }
  return results;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const testFiles = getAllFiles(ROOT + 'apps');
let migrated = 0;
const allIssues = [];

for (const f of testFiles) {
  const src = readFileSync(f, 'utf8');
  // Quick check: does this file have any barrel mock?
  const hasBarrel = Object.keys(BARREL_MAPS).some((b) => {
    const escaped = b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`vi\\.mock\\s*\\(\\s*['"]${escaped}['"]`).test(src);
  });
  if (!hasBarrel) continue;

  const { changed, issues } = migrateTestFile(f);
  if (changed) {
    migrated++;
    console.log(`✓ ${f.replace(ROOT, '')}`);
  }
  allIssues.push(...issues);
}

console.log(`\nMigrated ${migrated} test files`);
if (allIssues.length > 0) {
  console.log(`\nSkipped/warned (${allIssues.length}):`);
  allIssues.forEach(i => console.log(i));
}
