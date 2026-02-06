/**
 * AI API Sandbox - Integration Module
 *
 * Exports all types and functions for the integration system.
 */

// Types
export * from './types';

// Pure Auth Functions
export { applyAuth } from './auth/apply-auth';

// Pure Validation Functions
export { isToolAllowed } from './validation/is-tool-allowed';
export { isUserIntegrationVisibleInDrive } from './validation/visibility';

// Pure Execution Functions
export {
  buildHttpRequest,
  interpolatePath,
  resolveValue,
  resolveBody,
} from './execution/build-request';
export {
  transformOutput,
  extractPath,
  applyMapping,
  truncateStrings,
} from './execution/transform-output';

// Pure Rate Limit Functions
export { calculateEffectiveRateLimit } from './rate-limit/calculate-limit';

// Credential Encryption Functions
export { encryptCredentials, decryptCredentials } from './credentials/encrypt-credentials';

// Rate Limiter
export {
  checkIntegrationRateLimit,
  resetIntegrationRateLimit,
  checkConnectionRateLimit,
  checkDriveRateLimit,
  buildRateLimitKey,
  INTEGRATION_RATE_LIMITS,
  type IntegrationRateLimitConfig,
} from './rate-limit/integration-rate-limiter';

// HTTP Executor
export {
  executeHttpRequest,
  DEFAULT_EXECUTE_OPTIONS,
  FAST_EXECUTE_OPTIONS,
  LONG_EXECUTE_OPTIONS,
  type HttpRequest,
  type HttpResponse,
  type ExecuteOptions,
  type ExecuteResult,
} from './execution/http-executor';

// Execution Saga
export {
  executeToolSaga,
  createToolExecutor,
  type ExecuteToolDependencies,
} from './saga/execute-tool';

// AI SDK Tool Converter
export {
  convertIntegrationToolsToAISDK,
  convertToolSchemaToZod,
  buildIntegrationToolName,
  parseIntegrationToolName,
  isIntegrationTool,
  type GrantWithConnectionAndProvider,
  type ExecutorContext,
  type CoreTool,
} from './converter/ai-sdk';

// OpenAPI Importer
export {
  importOpenAPISpec,
  type ImportOptions,
  type ImportResult,
} from './converter/openapi';

// Agent Integration Resolution
export {
  resolveAgentIntegrations,
  resolveGlobalAssistantIntegrations,
  type ResolutionDependencies,
  type ConnectionWithProviderForResolution,
} from './resolution/resolve-agent-integrations';

// OAuth Flow Handler
export {
  buildOAuthAuthorizationUrl,
  exchangeOAuthCode,
  refreshOAuthToken,
  generatePKCE,
  type BuildAuthUrlParams,
  type ExchangeCodeParams,
  type RefreshTokenParams,
  type TokenResponse,
  type PKCEPair,
} from './oauth/oauth-handler';

// OAuth State Utilities
export {
  createSignedState,
  verifySignedState,
} from './oauth/oauth-state';

// Provider Repository
export {
  getProviderById,
  getProviderBySlug,
  listEnabledProviders,
  listProvidersForDrive,
  createProvider,
  updateProvider,
  deleteProvider,
  countProviderConnections,
} from './repositories/provider-repository';

// Config Repository
export {
  getOrCreateConfig,
  getConfig,
  updateConfig,
} from './repositories/config-repository';

// Connection Repository
export {
  createConnection,
  getConnectionById,
  getConnectionWithProvider,
  findUserConnection,
  findDriveConnection,
  updateConnectionStatus,
  updateConnectionCredentials,
  updateConnectionLastUsed,
  deleteConnection,
  listUserConnections,
  listDriveConnections,
} from './repositories/connection-repository';

// Grant Repository
export {
  createGrant,
  getGrantById,
  findGrant,
  listGrantsByAgent,
  listGrantsByConnection,
  updateGrant,
  deleteGrant,
  deleteGrantsByConnection,
  deleteGrantsByAgent,
} from './repositories/grant-repository';

// Audit Repository
export {
  logAuditEntry,
  getAuditLogsByDrive,
  getAuditLogsByConnection,
  getAuditLogsByDateRange,
  getAuditLogsBySuccess,
  getAuditLogsByAgent,
  getAuditLogsByTool,
} from './repositories/audit-repository';
