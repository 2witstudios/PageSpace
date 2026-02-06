/**
 * AI API Sandbox - Core Type Definitions
 *
 * Generic integration system for connecting AI agents to external APIs.
 * Supports OAuth, API keys, bearer tokens, and custom auth methods.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// AUTHENTICATION TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface OAuth2Config {
  authorizationUrl: string;
  tokenUrl: string;
  revokeUrl?: string;
  scopes: string[];
  pkceRequired?: boolean;
  tokenPlacement?: 'header' | 'query';
  tokenPrefix?: string;
}

export interface ApiKeyConfig {
  placement: 'header' | 'query' | 'body';
  paramName: string;
  prefix?: string;
}

export interface BearerTokenConfig {
  headerName?: string;
  prefix?: string;
}

export interface BasicAuthConfig {
  usernameField: string;
  passwordField: string;
}

export interface CustomHeaderConfig {
  headers: Array<{
    name: string;
    valueFrom: 'credential' | 'static';
    credentialKey?: string;
    staticValue?: string;
  }>;
}

export type AuthMethod =
  | { type: 'oauth2'; config: OAuth2Config }
  | { type: 'api_key'; config: ApiKeyConfig }
  | { type: 'bearer_token'; config: BearerTokenConfig }
  | { type: 'basic_auth'; config: BasicAuthConfig }
  | { type: 'custom_header'; config: CustomHeaderConfig }
  | { type: 'none' };

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL EXECUTION TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type BodyEncoding = 'json' | 'form' | 'multipart';

export interface ParameterRef {
  $param: string;
  transform?: 'string' | 'number' | 'boolean' | 'json';
}

export interface HttpExecutionConfig {
  method: HttpMethod;
  pathTemplate: string;
  queryParams?: Record<string, string | ParameterRef>;
  headers?: Record<string, string | ParameterRef>;
  bodyTemplate?: Record<string, unknown> | string;
  bodyEncoding?: BodyEncoding;
}

export interface GraphQLExecutionConfig {
  query: string;
  variables?: Record<string, ParameterRef>;
  operationName?: string;
}

export type ToolExecution =
  | { type: 'http'; config: HttpExecutionConfig }
  | { type: 'graphql'; config: GraphQLExecutionConfig }
  | { type: 'function'; handler: string }
  | { type: 'chain'; steps: ToolExecution[] };

// ═══════════════════════════════════════════════════════════════════════════════
// OUTPUT TRANSFORMATION
// ═══════════════════════════════════════════════════════════════════════════════

export interface OutputTransform {
  extract?: string;
  mapping?: Record<string, string>;
  maxLength?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL DEFINITION
// ═══════════════════════════════════════════════════════════════════════════════

export type ToolCategory = 'read' | 'write' | 'admin' | 'dangerous';

export interface RateLimitConfig {
  requests: number;
  windowMs: number;
}

export interface RetryConfig {
  maxAttempts: number;
  backoffMs: number;
  retryableStatuses: number[];
}

export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  category: ToolCategory;
  inputSchema: Record<string, unknown>;
  execution: ToolExecution;
  outputTransform?: OutputTransform;
  rateLimit?: RateLimitConfig;
  retry?: RetryConfig;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROVIDER TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type ProviderType = 'builtin' | 'openapi' | 'custom' | 'mcp' | 'webhook';

export interface HealthCheckConfig {
  endpoint: string;
  expectedStatus: number;
}

export interface IntegrationProviderConfig {
  id: string;
  name: string;
  description?: string;
  iconUrl?: string;
  documentationUrl?: string;
  authMethod: AuthMethod;
  baseUrl: string;
  defaultHeaders?: Record<string, string>;
  tools: ToolDefinition[];
  credentialSchema?: Record<string, unknown>;
  healthCheck?: HealthCheckConfig;
  rateLimit?: { requests: number; windowMs: number };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONNECTION TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type ConnectionStatus = 'active' | 'expired' | 'error' | 'pending' | 'revoked';
export type ConnectionVisibility = 'private' | 'owned_drives' | 'all_drives';

export interface ConnectionConfigOverrides {
  defaultHeaders?: Record<string, string>;
  timeout?: number;
  retryConfig?: RetryConfig;
}

export interface AccountMetadata {
  accountId?: string;
  accountName?: string;
  email?: string;
  avatarUrl?: string;
  workspaceName?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GRANT TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface GrantRateLimitOverride {
  requestsPerMinute?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GLOBAL ASSISTANT CONFIG
// ═══════════════════════════════════════════════════════════════════════════════

export interface DriveOverrideConfig {
  enabled: boolean;
  enabledIntegrations?: string[];
}

export interface GlobalAssistantConfigData {
  enabledUserIntegrations?: string[] | null;
  driveOverrides?: Record<string, DriveOverrideConfig>;
  inheritDriveIntegrations?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXECUTION CONTEXT
// ═══════════════════════════════════════════════════════════════════════════════

export interface ToolGrant {
  allowedTools: string[] | null;
  deniedTools: string[] | null;
  readOnly: boolean;
  rateLimitOverride?: { requestsPerMinute: number };
}

export interface ToolCallRequest {
  userId: string;
  agentId: string;
  driveId: string | null;
  connectionId: string;
  toolName: string;
  input: Record<string, unknown>;
  grant?: ToolGrant;
}

export type ToolCallErrorType =
  | 'validation'
  | 'rate_limit'
  | 'http'
  | 'internal'
  | 'timeout'
  | 'network';

export interface ToolCallResult {
  success: boolean;
  data?: unknown;
  error?: string;
  errorCode?: string;
  errorType?: ToolCallErrorType;
  retryAfter?: number;
}

export interface AuthResult {
  headers: Record<string, string>;
  queryParams: Record<string, string>;
}

export interface HttpRequest {
  url: string;
  method: HttpMethod;
  headers: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  durationMs: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// VALIDATION TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface ToolAllowedResult {
  allowed: boolean;
  reason?: string;
}

export interface ToolAllowedConfig {
  providerTools: ToolDefinition[];
  grantAllowedTools: string[] | null;
  grantDeniedTools: string[] | null;
  grantReadOnly: boolean;
}

export interface ValidationResult {
  valid: boolean;
  errorCode?: string;
  error?: string;
}

export interface ZeroTrustValidationResult extends ValidationResult {
  connection?: unknown;
  grant?: unknown;
}

export type ZeroTrustErrorCode =
  | 'NO_DRIVE_ACCESS'
  | 'WRONG_DRIVE'
  | 'INTEGRATION_NOT_VISIBLE'
  | 'INTEGRATION_INACTIVE'
  | 'NO_AGENT_GRANT'
  | 'TOOL_NOT_ALLOWED'
  | 'RATE_LIMITED';

// ═══════════════════════════════════════════════════════════════════════════════
// AUDIT TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type AuditErrorType =
  | 'rate_limit'
  | 'auth_error'
  | 'validation'
  | 'execution'
  | 'timeout'
  | 'network';

export interface AuditLogEntry {
  driveId: string | null;
  agentId: string;
  userId: string;
  connectionId: string;
  toolName: string;
  inputSummary?: string;
  success: boolean;
  responseCode?: number;
  errorType?: AuditErrorType;
  errorMessage?: string;
  durationMs?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// RATE LIMIT TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface RateLimitLevels {
  provider?: RateLimitConfig;
  connection?: { requestsPerMinute: number };
  grant?: { requestsPerMinute?: number };
  tool?: RateLimitConfig;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DRIVE ROLE TYPE (for visibility checks)
// ═══════════════════════════════════════════════════════════════════════════════

export type DriveRole = 'OWNER' | 'ADMIN' | 'MEMBER';
