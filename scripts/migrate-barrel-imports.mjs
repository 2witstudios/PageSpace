/**
 * Migration script: Replace @pagespace/lib barrel imports with direct subpath imports
 *
 * Handles: server, auth, integrations, notifications barrels
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const ROOT = new URL('..', import.meta.url).pathname;
const APPS_DIR = join(ROOT, 'apps');

// ─── Symbol-to-subpath maps ───────────────────────────────────────────────────

const SERVER_MAP = {
  // Logging
  loggers: '@pagespace/lib/logging/logger-config',
  logger: '@pagespace/lib/logging/logger-config',
  extractRequestContext: '@pagespace/lib/logging/logger-config',
  logSecurityEvent: '@pagespace/lib/logging/logger-config',
  logResponse: '@pagespace/lib/logging/logger-config',

  // Audit
  auditRequest: '@pagespace/lib/audit/audit-log',
  audit: '@pagespace/lib/audit/audit-log',
  queryAuditEvents: '@pagespace/lib/audit/audit-query',
  maskEmail: '@pagespace/lib/audit/mask-email',
  securityAudit: '@pagespace/lib/audit/security-audit',

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

  // Permission mutations
  grantPagePermission: '@pagespace/lib/permissions/permission-mutations',
  revokePagePermission: '@pagespace/lib/permissions/permission-mutations',
  GrantResult: '@pagespace/lib/permissions/permission-mutations',
  RevokeResult: '@pagespace/lib/permissions/permission-mutations',
  PermissionMutationError: '@pagespace/lib/permissions/permission-mutations',

  // Permission schemas
  GrantInputSchema: '@pagespace/lib/permissions/schemas',
  RevokeInputSchema: '@pagespace/lib/permissions/schemas',
  PermissionFlagsSchema: '@pagespace/lib/permissions/schemas',
  GrantInput: '@pagespace/lib/permissions/schemas',
  RevokeInput: '@pagespace/lib/permissions/schemas',
  PermissionFlags: '@pagespace/lib/permissions/schemas',

  // Enforced auth context
  EnforcedAuthContext: '@pagespace/lib/permissions/enforced-context',

  // Auth device
  validateOrCreateDeviceToken: '@pagespace/lib/auth/device-auth-utils',
  validateDeviceToken: '@pagespace/lib/auth/device-auth-utils',
  updateDeviceTokenActivity: '@pagespace/lib/auth/device-auth-utils',
  generateDeviceToken: '@pagespace/lib/auth/device-auth-utils',
  getUserDeviceTokens: '@pagespace/lib/auth/device-auth-utils',
  revokeAllUserDeviceTokens: '@pagespace/lib/auth/device-auth-utils',
  createDeviceTokenRecord: '@pagespace/lib/auth/device-auth-utils',
  revokeExpiredDeviceTokens: '@pagespace/lib/auth/device-auth-utils',

  // Auth CSRF
  generateCSRFToken: '@pagespace/lib/auth/csrf-utils',
  validateCSRFToken: '@pagespace/lib/auth/csrf-utils',

  // Auth OAuth
  verifyOAuthIdToken: '@pagespace/lib/auth/oauth-utils',
  createOrLinkOAuthUser: '@pagespace/lib/auth/oauth-utils',
  OAuthProvider: '@pagespace/lib/auth/oauth-types',
  MobileOAuthResponse: '@pagespace/lib/auth/oauth-types',

  // Monitoring - activity
  getActorInfo: '@pagespace/lib/monitoring/activity-logger',
  logPageActivity: '@pagespace/lib/monitoring/activity-logger',
  logDriveActivity: '@pagespace/lib/monitoring/activity-logger',
  logMessageActivity: '@pagespace/lib/monitoring/activity-logger',
  ActivityOperation: '@pagespace/lib/monitoring/activity-logger',
  logActivityWithTx: '@pagespace/lib/monitoring/activity-logger',
  DeferredWorkflowTrigger: '@pagespace/lib/monitoring/activity-logger',

  // Monitoring - change group
  createChangeGroupId: '@pagespace/lib/monitoring/change-group',
  inferChangeGroupType: '@pagespace/lib/monitoring/change-group',
  ChangeGroupType: '@pagespace/lib/monitoring/change-group',

  // Services - page content store
  readPageContent: '@pagespace/lib/services/page-content-store',
  writePageContent: '@pagespace/lib/services/page-content-store',

  // Services - page version
  computePageStateHash: '@pagespace/lib/services/page-version-service',
  createPageVersion: '@pagespace/lib/services/page-version-service',
  PageVersionSource: '@pagespace/lib/services/page-version-service',
  PageStateInput: '@pagespace/lib/services/page-version-service',
  CreatePageVersionInput: '@pagespace/lib/services/page-version-service',

  // Services - drive member
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

  // Services - drive role
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

  // Services - drive search
  regexSearchPages: '@pagespace/lib/services/drive-search-service',
  globSearchPages: '@pagespace/lib/services/drive-search-service',
  checkDriveAccessForSearch: '@pagespace/lib/services/drive-search-service',

  // Services - drive service
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

  // Content - tree
  buildTree: '@pagespace/lib/content/tree-utils',

  // Content - page types config
  isDocumentPage: '@pagespace/lib/content/page-types.config',
  isAIChatPage: '@pagespace/lib/content/page-types.config',
  isFolderPage: '@pagespace/lib/content/page-types.config',
  getPageTypeEmoji: '@pagespace/lib/content/page-types.config',
  getDefaultContent: '@pagespace/lib/content/page-types.config',
  getCreatablePageTypes: '@pagespace/lib/content/page-types.config',

  // Content - format detection
  detectPageContentFormat: '@pagespace/lib/content/page-content-format',

  // Content - page type validators
  validatePageCreation: '@pagespace/lib/content/page-type-validators',
  canConvertToType: '@pagespace/lib/content/page-type-validators',
  validatePageUpdate: '@pagespace/lib/content/page-type-validators',
  validateAIChatTools: '@pagespace/lib/content/page-type-validators',
  ValidationResult: '@pagespace/lib/content/page-type-validators',

  // Utils
  slugify: '@pagespace/lib/utils/utils',
  hashWithPrefix: '@pagespace/lib/utils/hash-utils',
  PageType: '@pagespace/lib/utils/enums',

  // Repositories
  accountRepository: '@pagespace/lib/repositories',
  activityLogRepository: '@pagespace/lib/repositories',
  pageRepository: '@pagespace/lib/repositories',
  driveRepository: '@pagespace/lib/repositories',
  agentRepository: '@pagespace/lib/repositories',

  // Sheets
  parseSheetContent: '@pagespace/lib/sheets',
  serializeSheetContent: '@pagespace/lib/sheets',
  isSheetType: '@pagespace/lib/sheets',
  updateSheetCells: '@pagespace/lib/sheets',
  isValidCellAddress: '@pagespace/lib/sheets',

  // Encryption
  encrypt: '@pagespace/lib/encryption',
  decrypt: '@pagespace/lib/encryption',

  // Env validation
  validateEnv: '@pagespace/lib/config/env-validation',
  getEnvErrors: '@pagespace/lib/config/env-validation',
  isEnvValid: '@pagespace/lib/config/env-validation',
  getValidatedEnv: '@pagespace/lib/config/env-validation',
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
  updateConnectionCredentials: '@pagespace/lib/integrations/repositories/connection-repository',
  updateConnectionStatus: '@pagespace/lib/integrations/repositories/connection-repository',
  getProviderById: '@pagespace/lib/integrations/repositories/provider-repository',
  getProviderBySlug: '@pagespace/lib/integrations/repositories/provider-repository',
  listEnabledProviders: '@pagespace/lib/integrations/repositories/provider-repository',
  createProvider: '@pagespace/lib/integrations/repositories/provider-repository',
  updateProvider: '@pagespace/lib/integrations/repositories/provider-repository',
  deleteProvider: '@pagespace/lib/integrations/repositories/provider-repository',
  seedBuiltinProviders: '@pagespace/lib/integrations/repositories/provider-repository',
  refreshBuiltinProviders: '@pagespace/lib/integrations/repositories/provider-repository',
  countProviderConnections: '@pagespace/lib/integrations/repositories/provider-repository',
  getGrantById: '@pagespace/lib/integrations/repositories/grant-repository',
  updateGrant: '@pagespace/lib/integrations/repositories/grant-repository',
  deleteGrant: '@pagespace/lib/integrations/repositories/grant-repository',
  listGrantsByAgent: '@pagespace/lib/integrations/repositories/grant-repository',
  createGrant: '@pagespace/lib/integrations/repositories/grant-repository',
  findGrant: '@pagespace/lib/integrations/repositories/grant-repository',
  listGrantsByConnection: '@pagespace/lib/integrations/repositories/grant-repository',
  buildOAuthAuthorizationUrl: '@pagespace/lib/integrations/oauth/oauth-handler',
  exchangeOAuthCode: '@pagespace/lib/integrations/oauth/oauth-handler',
  createSignedState: '@pagespace/lib/integrations/oauth/oauth-state',
  verifySignedState: '@pagespace/lib/integrations/oauth/oauth-state',
  builtinProviderList: '@pagespace/lib/integrations/providers',
  getBuiltinProvider: '@pagespace/lib/integrations/providers',
  importOpenAPISpec: '@pagespace/lib/integrations/converter/openapi',
  encryptCredentials: '@pagespace/lib/integrations/credentials/encrypt-credentials',
  decryptCredentials: '@pagespace/lib/integrations/credentials/encrypt-credentials',
  IntegrationProviderConfig: '@pagespace/lib/integrations/types',
  OAuth2Config: '@pagespace/lib/integrations/types',
};

const NOTIFICATIONS_MAP = {
  registerPushToken: '@pagespace/lib/notifications/push-notifications',
  unregisterPushToken: '@pagespace/lib/notifications/push-notifications',
  getUserPushTokens: '@pagespace/lib/notifications/push-notifications',
  sendNotification: '@pagespace/lib/notifications/notifications',
  sendPushNotification: '@pagespace/lib/notifications/push-notifications',
};

// Root @pagespace/lib barrel (the main index.ts)
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

// ─── Barrel → map lookup ─────────────────────────────────────────────────────

const BARREL_MAPS = {
  server: SERVER_MAP,
  auth: AUTH_MAP,
  integrations: INTEGRATIONS_MAP,
  notifications: NOTIFICATIONS_MAP,
  // Root barrel: key 'ROOT' is special — matched as '@pagespace/lib' (no subpath)
  ROOT: LIB_ROOT_MAP,
};

// ─── File walker ─────────────────────────────────────────────────────────────

function getAllFiles(dir, exts = ['.ts', '.tsx']) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === 'dist') continue;
      results.push(...getAllFiles(full, exts));
    } else if (exts.includes(extname(full))) {
      results.push(full);
    }
  }
  return results;
}

// ─── Import block parser ─────────────────────────────────────────────────────

/**
 * Parse a single import statement block and extract:
 * - isTypeImport: true if `import type {`
 * - symbols: array of { name, alias, isType }
 * - fullMatch: the entire import statement string
 * - start/end positions in the source
 */
function parseImportBlock(source, barrel) {
  const results = [];
  // For root barrel (barrel=''), match '@pagespace/lib' followed immediately by quote (no subpath).
  // For subpath barrels, match '@pagespace/lib/<barrel>'.
  const escapedBarrel = escapeRegExp(barrel);
  const pattern = barrel === ''
    ? `import(\\s+type)?\\s+\\{([^}]+)\\}\\s+from\\s+'@pagespace/lib'`
    : `import(\\s+type)?\\s+\\{([^}]+)\\}\\s+from\\s+'@pagespace/lib/${escapedBarrel}'`;
  const regex = new RegExp(pattern, 'gs');

  let match;
  while ((match = regex.exec(source)) !== null) {
    const isTypeImport = Boolean(match[1]);
    const symbolsRaw = match[2];
    const symbols = symbolsRaw
      .split(',')
      .map(s => s.trim())
      .filter(s => s && !s.startsWith('//') && !s.startsWith('*'))
      .map(s => {
        // Handle `type Foo` prefix within non-type imports
        const isType = isTypeImport || s.startsWith('type ');
        const withoutType = s.replace(/^type\s+/, '');
        // Handle `Foo as Bar` aliases
        const [name, alias] = withoutType.split(/\s+as\s+/).map(p => p.trim());
        return { name, alias: alias || null, isType };
      })
      .filter(s => s.name);

    results.push({
      fullMatch: match[0],
      start: match.index,
      end: match.index + match[0].length,
      isTypeImport,
      symbols,
    });
  }

  return results;
}

/**
 * Build replacement import statements for a set of symbols given a barrel map.
 * Groups symbols by their target subpath and emits one import per subpath.
 * Unknown symbols are grouped into a fallback import from the barrel itself.
 */
function buildReplacementImports(symbols, barrelMap, barrel) {
  const bySubpath = new Map();
  const unknown = [];

  for (const sym of symbols) {
    const subpath = barrelMap[sym.name];
    if (subpath) {
      if (!bySubpath.has(subpath)) bySubpath.set(subpath, []);
      bySubpath.get(subpath).push(sym);
    } else {
      unknown.push(sym);
    }
  }

  const lines = [];

  for (const [subpath, syms] of bySubpath) {
    const allType = syms.every(s => s.isType);
    const hasType = syms.some(s => s.isType);

    let parts;
    if (allType) {
      // `import type { A, B } from '...'`
      const names = syms.map(s => (s.alias ? `${s.name} as ${s.alias}` : s.name)).join(', ');
      parts = `import type { ${names} } from '${subpath}'`;
    } else if (hasType) {
      // Mixed: inline `type` keywords
      const names = syms.map(s => {
        const prefix = s.isType ? 'type ' : '';
        return s.alias ? `${prefix}${s.name} as ${s.alias}` : `${prefix}${s.name}`;
      }).join(', ');
      parts = `import { ${names} } from '${subpath}'`;
    } else {
      const names = syms.map(s => (s.alias ? `${s.name} as ${s.alias}` : s.name)).join(', ');
      parts = `import { ${names} } from '${subpath}'`;
    }
    lines.push(parts);
  }

  if (unknown.length > 0) {
    const allType = unknown.every(s => s.isType);
    const hasType = unknown.some(s => s.isType);
    const fallbackPath = `@pagespace/lib/${barrel}`;

    let parts;
    if (allType) {
      const names = unknown.map(s => (s.alias ? `${s.name} as ${s.alias}` : s.name)).join(', ');
      parts = `import type { ${names} } from '${fallbackPath}'`;
    } else if (hasType) {
      const names = unknown.map(s => {
        const prefix = s.isType ? 'type ' : '';
        return s.alias ? `${prefix}${s.name} as ${s.alias}` : `${prefix}${s.name}`;
      }).join(', ');
      parts = `import { ${names} } from '${fallbackPath}'`;
    } else {
      const names = unknown.map(s => (s.alias ? `${s.name} as ${s.alias}` : s.name)).join(', ');
      parts = `import { ${names} } from '${fallbackPath}'`;
    }
    lines.push(parts);
    console.warn(`  [WARN] Unknown symbols kept in ${barrel} barrel: ${unknown.map(s => s.name).join(', ')}`);
  }

  return lines.join('\n');
}

// ─── Migrate a single file ────────────────────────────────────────────────────

function migrateFile(filePath, barrel, barrelMap) {
  const source = readFileSync(filePath, 'utf8');
  const blocks = parseImportBlock(source, barrel);

  if (blocks.length === 0) return false;

  // Work backwards to preserve positions
  let modified = source;
  for (const block of blocks.reverse()) {
    const replacement = buildReplacementImports(block.symbols, barrelMap, barrel);
    modified = modified.slice(0, block.start) + replacement + modified.slice(block.end);
  }

  if (modified !== source) {
    writeFileSync(filePath, modified, 'utf8');
    return true;
  }
  return false;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const targetBarrels = args.length > 0 ? args : Object.keys(BARREL_MAPS);

const files = getAllFiles(APPS_DIR);
let totalMigrated = 0;
const warnings = [];

for (const barrel of targetBarrels) {
  const barrelMap = BARREL_MAPS[barrel];
  if (!barrelMap) {
    console.error(`Unknown barrel: ${barrel}`);
    continue;
  }

  // Root barrel is matched as '@pagespace/lib' exactly (no subpath suffix)
  const importPath = barrel === 'ROOT' ? '' : barrel;
  const importMatch = barrel === 'ROOT'
    ? `from '@pagespace/lib'`
    : `from '@pagespace/lib/${barrel}'`;

  let count = 0;
  console.log(`\nMigrating @pagespace/lib${importPath ? '/' + importPath : ''} barrel...`);

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    if (!source.includes(importMatch)) continue;

    const migrated = migrateFile(file, importPath, barrelMap);
    if (migrated) {
      count++;
      console.log(`  ✓ ${file.replace(ROOT, '')}`);
    }
  }

  console.log(`  → Migrated ${count} files`);
  totalMigrated += count;
}

console.log(`\nDone. Total files migrated: ${totalMigrated}`);
