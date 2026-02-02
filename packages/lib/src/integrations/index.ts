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
