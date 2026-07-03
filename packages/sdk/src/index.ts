// Errors — the taxonomy every SDK/CLI/MCP consumer catches. `classifyHttpError`
// is the pure classification core (status/headers/body -> typed error).
export {
  AuthenticationError,
  classifyHttpError,
  HttpError,
  IncompatibleServerError,
  isAuthenticationError,
  isHttpError,
  isIncompatibleServerError,
  isNetworkError,
  isNotFoundError,
  isPageSpaceError,
  isPermissionDeniedError,
  isRateLimitError,
  isResponseValidationError,
  isServerError,
  isTimeoutError,
  isValidationError,
  NetworkError,
  NotFoundError,
  PageSpaceError,
  PermissionDeniedError,
  RateLimitError,
  ResponseValidationError,
  ServerError,
  TimeoutError,
  ValidationError,
} from './errors.js';
export type {
  CompatibilityResult,
  HttpErrorHeaders,
  IncompatibilityReason,
  NetworkErrorOptions,
  PageSpaceErrorCode,
  TimeoutErrorOptions,
  ValidationIssue,
} from './errors.js';

// Versioning (ADR 0001) — the server-compatibility handshake the facade runs lazily.
export { checkServerCompatibility, compareApiVersions, MIN_SERVER_API_VERSION, parseApiVersion, SDK_VERSION } from './version.js';
export type { ParsedVersion } from './version.js';

// Auth providers — the credential sources every PageSpaceClient accepts.
export type { AuthProvider } from './auth/provider.js';
export { StaticTokenProvider } from './auth/static.js';
export { OAuthTokenProvider } from './auth/oauth.js';
export type { OAuthTokenProviderOptions, OAuthTokens, RefreshAccessToken } from './auth/oauth.js';

// Operation registry — the source of truth SDK resource methods, CLI verbs,
// and MCP tool definitions all derive from.
export { defineOperation } from './registry/define.js';
export type { Operation, OperationConfig, PathParamNames, RequiredScope, ValidOperationConfig } from './registry/define.js';
export { createRegistry, getOperation, hasOperation, listOperations } from './registry/registry.js';
export type { OperationRegistry } from './registry/registry.js';

// Seed operations (Phase 3 grows this list).
export { listDrives } from './operations/drives.js';
export { readPage } from './operations/pages.js';
export { globSearch, multiDriveSearch, regexSearch } from './operations/search.js';

// Drives & members operations (Phase 3 task 1).
export {
  assertDriveNameConfirmed,
  createDrive,
  renameDrive,
  restoreDrive,
  trashDrive,
  updateDriveContext,
} from './operations/drives.js';
export type { ConfirmMismatch, Result } from './operations/drives.js';
export { listDriveMembers } from './operations/members.js';
export { listCollaborators } from './operations/collaborators.js';

// Tasks & statuses operations (Phase 3 task 4).
export {
  classifyTaskCompletionGate,
  createTask,
  createTaskStatus,
  deleteTask,
  deleteTaskTrigger,
  getAssignedTasks,
  reorderTask,
  setTaskTrigger,
  updateTask,
} from './operations/tasks.js';
export type { TaskCompletionGatedError } from './operations/tasks.js';

// Transport primitive types needed to declare custom operations. buildRequest/
// parseResponse/executeRequest stay internal — the facade is the only caller.
export type { HttpMethod } from './transport/types.js';

// Retry policy shape + default, for callers customizing PageSpaceClientOptions.retryPolicy.
export { DEFAULT_RETRY_POLICY } from './retry.js';
export type { Jitter, RetryPolicy } from './retry.js';

// The facade.
export { PageSpaceClient } from './client.js';
export type { ClientNamespaces, PageSpaceClientOptions } from './client.js';
