# AI API Sandbox Epic

**Status**: 📋 PLANNED
**Goal**: Enable AI agents to safely call external APIs with zero-trust security, supporting user and drive scoped integrations.

## Overview

Users want their AI agents (especially the global assistant) to interact with external services like GitHub, Slack, Notion, and custom APIs. Currently, there's no secure way to give agents access to external tools. This epic builds a generic API integration sandbox that:

1. **Never exposes credentials to LLMs** - tokens are decrypted server-side only during execution
2. **Supports hybrid scoping** - user integrations (follow you everywhere) and drive integrations (team-scoped isolation)
3. **Is generic, not GitHub-specific** - supports any HTTP/GraphQL API via multiple auth methods
4. **Enables easy adapter addition** - built-in adapters, OpenAPI import, custom tool builder, MCP servers
5. **Provides admin control** - per-drive and per-user configuration consoles
6. **Enforces zero-trust validation** - every tool call validates user → drive → integration → tool chain

---

## Core Abstractions

### Authentication Methods

```typescript
type AuthMethod =
  | { type: 'oauth2'; config: OAuth2Config }
  | { type: 'api_key'; config: ApiKeyConfig }
  | { type: 'bearer_token'; config: BearerTokenConfig }
  | { type: 'basic_auth'; config: BasicAuthConfig }
  | { type: 'custom_header'; config: CustomHeaderConfig }
  | { type: 'none' };
```

### Tool Execution Types

```typescript
type ToolExecution =
  | { type: 'http'; config: HttpExecutionConfig }
  | { type: 'graphql'; config: GraphQLExecutionConfig }
  | { type: 'function'; handler: string }
  | { type: 'chain'; steps: ToolExecution[] };
```

### Provider Types

```typescript
type ProviderType = 'builtin' | 'openapi' | 'custom' | 'mcp' | 'webhook';
```

### Scoping Model

```
User Integrations (personal, follow you across drives)
  └─ visibility: 'private' | 'owned_drives' | 'all_drives'

Drive Integrations (team-scoped, shared with members)
  └─ scopes: specific resources (repos, channels, databases)
     └─ agent bindings: which agents can use which scopes
```

---

## Database Schema

### Integration Providers

Defines available integration types (system-level or custom).

```typescript
integrationProviders = {
  id: string,              // cuid or slug for builtins
  slug: string,            // 'github', 'slack', 'my-custom-api'
  name: string,            // 'GitHub'
  description: string,
  iconUrl: string,
  documentationUrl: string,

  providerType: ProviderType,
  config: IntegrationProviderConfig,  // Full provider definition as JSON
  openApiSpec: string,                // For OpenAPI imports

  isSystem: boolean,       // Built-in vs user-created
  createdBy: userId,       // For custom providers
  driveId: driveId,        // If drive-specific custom provider

  enabled: boolean,
  createdAt: timestamp,
  updatedAt: timestamp,
}
```

### Integration Connections

Authenticated connections to providers (user or drive owned).

```typescript
integrationConnections = {
  id: string,
  providerId: string,      // → integrationProviders.id

  // EITHER user OR drive (determines scope)
  userId: string | null,   // → users.id
  driveId: string | null,  // → drives.id

  name: string,            // 'My GitHub', 'Work GitHub'

  status: 'active' | 'expired' | 'error' | 'pending' | 'revoked',
  statusMessage: string,

  credentials: encrypted<Record<string, string>>,  // All values encrypted at rest
  baseUrlOverride: string,                         // For self-hosted instances
  configOverrides: { defaultHeaders, timeout, retryConfig },

  accountMetadata: { accountId, accountName, email, avatarUrl, workspaceName },

  visibility: 'private' | 'owned_drives' | 'all_drives',  // For user connections

  connectedBy: userId,
  connectedAt: timestamp,
  lastUsedAt: timestamp,
  lastHealthCheck: timestamp,

  createdAt: timestamp,
  updatedAt: timestamp,
}
```

### Integration Tool Grants

Which tools from a connection an agent can use.

```typescript
integrationToolGrants = {
  id: string,
  agentId: string,         // → pages.id (AI_CHAT)
  connectionId: string,    // → integrationConnections.id

  allowedTools: string[],  // null = all tools from provider
  deniedTools: string[],
  readOnly: boolean,

  rateLimitOverride: { requestsPerMinute },

  createdAt: timestamp,
}
```

### Global Assistant Config

Per-user preferences for their global assistant.

```typescript
globalAssistantConfig = {
  id: string,
  userId: string,          // → users.id (unique)

  enabledUserIntegrations: string[],  // null = all
  driveOverrides: {
    [driveId]: {
      enabled: boolean,
      enabledIntegrations: string[],
    }
  },
  inheritDriveIntegrations: boolean,

  createdAt: timestamp,
  updatedAt: timestamp,
}
```

### Integration Audit Log

Every external API call is logged.

```typescript
integrationAuditLog = {
  id: string,

  driveId: string,
  agentId: string,
  userId: string,
  connectionId: string,

  toolName: string,
  inputSummary: string,    // Sanitized, not full input

  success: boolean,
  responseCode: number,
  errorType: string,       // 'rate_limit', 'auth_error', 'validation', etc.
  errorMessage: string,

  durationMs: number,
  createdAt: timestamp,
}
```

---

## Pure Functions (Unit Testable)

These functions contain NO side effects and are the core of the system.

### Auth Method Application

```typescript
// Pure: builds auth headers/params from credentials + method
applyAuth = (
  credentials: Record<string, string>,
  authMethod: AuthMethod
) => { headers: Record<string, string>, queryParams: Record<string, string> }
```

### Tool Validation

```typescript
// Pure: checks if a tool is allowed given all permission layers
isToolAllowed = (
  toolName: string,
  config: {
    providerTools: ToolDefinition[],
    grantAllowedTools: string[] | null,
    grantDeniedTools: string[] | null,
    grantReadOnly: boolean,
  }
) => { allowed: boolean, reason?: string }
```

### Rate Limit Calculation

```typescript
// Pure: finds most restrictive rate limit
calculateEffectiveRateLimit = (limits: {
  provider?: { requests: number, windowMs: number },
  connection?: { requestsPerMinute: number },
  grant?: { requestsPerMinute: number },
}) => number
```

### Request Building

```typescript
// Pure: builds HTTP request from template + input
buildHttpRequest = (
  config: HttpExecutionConfig,
  input: Record<string, unknown>,
  baseUrl: string
) => { url: string, method: string, headers: Record<string, string>, body?: string }
```

### Output Transformation

```typescript
// Pure: extracts/maps response data
transformOutput = (
  response: unknown,
  transform: OutputTransform
) => unknown
```

### Input Validation

```typescript
// Pure: validates input against JSON Schema
validateInput = (
  input: unknown,
  schema: JSONSchema7
) => { valid: boolean, errors?: string[] }
```

### Visibility Check

```typescript
// Pure: checks if user integration is visible in a drive
isUserIntegrationVisibleInDrive = (
  visibility: 'private' | 'owned_drives' | 'all_drives',
  userDriveRole: 'OWNER' | 'ADMIN' | 'MEMBER' | null
) => boolean
```

---

## IO Functions (Integration Tested)

These functions perform side effects and compose pure functions.

### Database Operations

```typescript
// Loads connection with provider config
loadConnection = (connectionId: string) => Promise<ConnectionWithProvider>

// Loads user's global assistant config
loadGlobalAssistantConfig = (userId: string) => Promise<GlobalAssistantConfig>

// Logs audit entry
logAuditEntry = (entry: AuditLogEntry) => Promise<void>

// Updates connection status
updateConnectionStatus = (connectionId: string, status: ConnectionStatus) => Promise<void>
```

### Crypto Operations

```typescript
// Decrypts credential values
decryptCredentials = (encrypted: Record<string, string>) => Record<string, string>

// Encrypts credential values
encryptCredentials = (plain: Record<string, string>) => Record<string, string>
```

### HTTP Execution

```typescript
// Executes HTTP request
executeHttpRequest = (request: HttpRequest) => Promise<HttpResponse>

// Executes GraphQL request
executeGraphQLRequest = (request: GraphQLRequest) => Promise<GraphQLResponse>
```

---

## Saga-Style Orchestration

Main execution flow using saga pattern for testability.

```typescript
// Generator-based for deterministic testing
function* executeIntegrationTool(request: ToolCallRequest) {
  // 1. Load connection
  const connection = yield call(loadConnection, request.connectionId);

  // 2. Validate tool is allowed (pure)
  const toolCheck = isToolAllowed(request.toolName, {
    providerTools: connection.provider.config.tools,
    grantAllowedTools: request.grant.allowedTools,
    grantDeniedTools: request.grant.deniedTools,
    grantReadOnly: request.grant.readOnly,
  });

  if (!toolCheck.allowed) {
    yield call(logAuditEntry, { success: false, errorType: 'TOOL_NOT_ALLOWED' });
    return { success: false, error: toolCheck.reason };
  }

  // 3. Check rate limit
  const rateLimit = calculateEffectiveRateLimit({ ... });
  const allowed = yield call(checkRateLimit, request.rateLimitKey, rateLimit);

  if (!allowed) {
    yield call(logAuditEntry, { success: false, errorType: 'RATE_LIMITED' });
    return { success: false, error: 'Rate limit exceeded' };
  }

  // 4. Decrypt credentials
  const credentials = yield call(decryptCredentials, connection.credentials);

  // 5. Build request (pure)
  const tool = connection.provider.config.tools.find(t => t.id === request.toolName);
  const httpRequest = buildHttpRequest(
    tool.execution.config,
    request.input,
    connection.baseUrlOverride || connection.provider.config.baseUrl
  );

  // 6. Apply auth (pure)
  const auth = applyAuth(credentials, connection.provider.config.authMethod);
  httpRequest.headers = { ...httpRequest.headers, ...auth.headers };

  // 7. Execute
  const response = yield call(executeHttpRequest, httpRequest);

  // 8. Transform output (pure)
  const result = transformOutput(response.body, tool.outputTransform);

  // 9. Log success
  yield call(logAuditEntry, { success: true, durationMs: response.durationMs });

  return { success: true, data: result };
}
```

---

## Zero-Trust Validation Chain

Every tool call passes through this validation.

```typescript
function* validateZeroTrust(request: ToolCallRequest) {
  // 1. User has access to drive
  const driveAccess = yield call(getUserDriveRole, request.userId, request.driveId);
  if (!driveAccess) {
    return { valid: false, errorCode: 'NO_DRIVE_ACCESS' };
  }

  // 2. Connection belongs to this context
  const connection = yield call(loadConnection, request.connectionId);

  if (connection.driveId && connection.driveId !== request.driveId) {
    return { valid: false, errorCode: 'WRONG_DRIVE' };
  }

  if (connection.userId && connection.userId !== request.userId) {
    // User integration - check visibility
    const visible = isUserIntegrationVisibleInDrive(
      connection.visibility,
      driveAccess.role
    );
    if (!visible) {
      return { valid: false, errorCode: 'INTEGRATION_NOT_VISIBLE' };
    }
  }

  // 3. Connection is active
  if (connection.status !== 'active') {
    return { valid: false, errorCode: 'INTEGRATION_INACTIVE' };
  }

  // 4. Agent has grant to this connection
  const grant = yield call(loadGrant, request.agentId, request.connectionId);
  if (!grant) {
    return { valid: false, errorCode: 'NO_AGENT_GRANT' };
  }

  // 5. Tool is allowed
  const toolCheck = isToolAllowed(request.toolName, { ... });
  if (!toolCheck.allowed) {
    return { valid: false, errorCode: 'TOOL_NOT_ALLOWED' };
  }

  return { valid: true, connection, grant };
}
```

---

## Task 1: Core Type Definitions

Define all TypeScript types and interfaces for the integration system.

**Requirements**:
- Given an auth method type, should support oauth2, api_key, bearer_token, basic_auth, custom_header, and none
- Given a tool execution type, should support http, graphql, function, and chain
- Given a provider type, should support builtin, openapi, custom, mcp, and webhook
- Given an HTTP execution config, should include method, pathTemplate, queryParams, headers, bodyTemplate, and bodyEncoding
- Given a tool definition, should include id, name, description, category, inputSchema, execution, outputTransform, and rateLimit
- Given an integration provider config, should fully describe how to authenticate and call the API

---

## Task 2: Pure Auth Functions

Implement pure functions for authentication handling.

**Requirements**:
- Given bearer_token auth with default config, should add Authorization header with "Bearer " prefix
- Given bearer_token auth with custom prefix, should use the specified prefix
- Given api_key auth with header placement, should add the key to specified header
- Given api_key auth with query placement, should add the key to URL query params
- Given basic_auth config, should create Base64-encoded Authorization header
- Given oauth2 auth, should add access token with configured prefix
- Given custom_header auth, should add all specified headers with values from credentials or static
- Given none auth, should return empty headers and params

---

## Task 3: Pure Tool Validation Functions

Implement pure functions for tool permission checking.

**Requirements**:
- Given a tool not in provider's tool list, should return not allowed with reason
- Given grant with null allowedTools, should allow all provider tools
- Given grant with specific allowedTools, should only allow listed tools
- Given grant with deniedTools, should deny those tools even if in allowedTools
- Given grant with readOnly true, should deny tools with category !== 'read'
- Given tool with category 'dangerous', should require explicit allowedTools entry

---

## Task 4: Pure Request Building Functions

Implement pure functions for building HTTP/GraphQL requests.

**Requirements**:
- Given path template with {param} placeholders, should interpolate values from input
- Given query params with $param references, should resolve from input
- Given body template with nested $param references, should deep-resolve all values
- Given body encoding 'json', should JSON.stringify the body
- Given body encoding 'form', should URL-encode the body
- Given missing required param, should throw validation error
- Given GraphQL config, should build proper query with variables

---

## Task 5: Pure Output Transform Functions

Implement pure functions for response transformation.

**Requirements**:
- Given extract with JSONPath expression, should extract matching value
- Given mapping config, should rename fields in output
- Given maxLength config, should truncate string values
- Given array output with extract, should apply to each element
- Given null/undefined response, should return null gracefully

---

## Task 6: Pure Rate Limit Calculation

Implement pure function for calculating effective rate limits.

**Requirements**:
- Given no rate limits, should return default 30/min
- Given provider-level limit only, should use provider limit
- Given connection-level limit, should use most restrictive of provider and connection
- Given grant-level override, should use most restrictive of all levels
- Given tool-specific limit, should factor into calculation

---

## Task 7: Pure Visibility Check Functions

Implement pure functions for integration visibility.

**Requirements**:
- Given visibility 'private', should return false for all drives
- Given visibility 'owned_drives' and role OWNER, should return true
- Given visibility 'owned_drives' and role ADMIN, should return true
- Given visibility 'owned_drives' and role MEMBER, should return false
- Given visibility 'all_drives' and any role, should return true
- Given visibility 'all_drives' and no role, should return false

---

## Task 8: Database Schema Migration

Create Drizzle schema and generate migration.

**Requirements**:
- Given integrationProviders table, should store provider definitions with JSON config
- Given integrationConnections table, should support both userId and driveId ownership
- Given integrationToolGrants table, should link agents to connections with tool filtering
- Given globalAssistantConfig table, should store per-user assistant preferences
- Given integrationAuditLog table, should capture all tool executions
- Given foreign key relationships, should cascade delete appropriately
- Given credential storage, should be encrypted at rest

---

## Task 9: Encryption Utilities

Implement credential encryption/decryption.

**Requirements**:
- Given plaintext credentials, should encrypt with AES-256-GCM
- Given encrypted credentials, should decrypt to original values
- Given tampered ciphertext, should throw integrity error
- Given different encryption key, should not decrypt
- Given empty credentials object, should handle gracefully

---

## Task 10: Connection Repository

Implement database operations for connections.

**Requirements**:
- Given valid connection data, should create and return new connection
- Given connection ID, should load with provider config eagerly
- Given user ID and provider ID, should find existing user connection
- Given drive ID and provider ID, should find existing drive connection
- Given status update, should update connection status and message
- Given connection deletion, should cascade to grants and audit logs

---

## Task 11: Grant Repository

Implement database operations for tool grants.

**Requirements**:
- Given agent ID and connection ID, should create new grant
- Given agent ID, should list all grants with connection details
- Given connection ID, should list all agents with grants
- Given grant update, should update allowed/denied tools
- Given grant deletion, should remove the grant

---

## Task 12: Audit Log Repository

Implement database operations for audit logging.

**Requirements**:
- Given audit entry, should insert with timestamp
- Given drive ID, should query recent logs for that drive
- Given connection ID, should query logs for that connection
- Given date range, should filter logs accordingly
- Given success filter, should query only successes or failures

---

## Task 13: Rate Limiter Integration

Implement rate limiting for tool execution.

**Requirements**:
- Given rate limit key and limit, should track request count
- Given count under limit, should allow request
- Given count at limit, should deny request
- Given window expiration, should reset count
- Given different keys, should track independently

---

## Task 14: HTTP Executor

Implement HTTP request execution with retry logic.

**Requirements**:
- Given valid request, should execute and return response
- Given timeout config, should abort after specified time
- Given 5xx response, should retry with backoff
- Given 429 response, should retry with Retry-After header
- Given 4xx response, should not retry and return error
- Given network error, should retry with backoff
- Given max retries exceeded, should return last error

---

## Task 15: Integration Executor Saga

Implement the main execution saga.

**Requirements**:
- Given valid tool call, should execute full pipeline and return result
- Given invalid tool, should return error without executing
- Given rate limit exceeded, should return error without executing
- Given auth error from API, should update connection status
- Given successful execution, should log audit entry
- Given failed execution, should log audit entry with error

---

## Task 16: Zero-Trust Validator Saga

Implement the validation chain saga.

**Requirements**:
- Given user without drive access, should reject with NO_DRIVE_ACCESS
- Given drive connection for different drive, should reject with WRONG_DRIVE
- Given user connection not visible in drive, should reject with INTEGRATION_NOT_VISIBLE
- Given inactive connection, should reject with INTEGRATION_INACTIVE
- Given agent without grant, should reject with NO_AGENT_GRANT
- Given disallowed tool, should reject with TOOL_NOT_ALLOWED
- Given all checks pass, should return valid with context

---

## Task 17: AI SDK Tool Converter

Convert integration tools to Vercel AI SDK format.

**Requirements**:
- Given agent with tool grants, should return AI SDK tools object
- Given tool name, should namespace as {provider}:{connection}:{tool}
- Given tool description, should prefix with provider name
- Given tool execution, should route through sandbox executor
- Given inactive connection, should exclude from tools
- Given empty grants, should return empty tools object

---

## Task 18: Agent Integration Resolution

Resolve which integrations an agent can access.

**Requirements**:
- Given agent with grants, should return resolved integrations
- Given global assistant, should include user integrations based on visibility
- Given global assistant in drive context, should include drive integrations
- Given drive overrides disabling integrations, should exclude them
- Given inherited drive integrations, should include them

---

## Task 19: OpenAPI Importer

Import OpenAPI specs to create providers.

**Requirements**:
- Given valid OpenAPI 3.x spec URL, should fetch and parse
- Given valid OpenAPI 3.x spec content, should parse directly
- Given spec with operations, should create tool for each
- Given spec with security definitions, should detect auth method
- Given spec with path parameters, should create input schema
- Given spec with request body, should include in input schema
- Given invalid spec, should return validation errors

---

## Task 20: OAuth Flow Handler

Handle OAuth authorization flows.

**Requirements**:
- Given provider with OAuth config, should build authorization URL
- Given authorization URL, should include PKCE if required
- Given callback with code, should exchange for tokens
- Given successful exchange, should encrypt and store tokens
- Given token refresh needed, should refresh and update
- Given refresh failed, should update connection status to expired

---

## Task 21: Provider Settings API

API routes for managing providers.

**Requirements**:
- Given GET /api/integrations/providers, should list enabled providers
- Given POST /api/integrations/providers (admin), should create custom provider
- Given PUT /api/integrations/providers/:id (admin), should update provider
- Given DELETE /api/integrations/providers/:id (admin), should delete custom provider
- Given provider with connections, should prevent deletion

---

## Task 22: User Connections API

API routes for user integration connections.

**Requirements**:
- Given GET /api/user/integrations, should list user's connections
- Given POST /api/user/integrations, should initiate connection (OAuth or API key)
- Given DELETE /api/user/integrations/:id, should disconnect and clean up
- Given PATCH /api/user/integrations/:id, should update visibility/config
- Given OAuth callback, should complete connection setup

---

## Task 23: Drive Connections API

API routes for drive integration connections.

**Requirements**:
- Given GET /api/drives/:driveId/integrations, should list drive connections
- Given POST /api/drives/:driveId/integrations (admin), should initiate connection
- Given DELETE /api/drives/:driveId/integrations/:id (admin), should disconnect
- Given non-admin user, should reject mutation requests
- Given member user, should allow read access

---

## Task 24: Agent Grants API

API routes for managing agent tool grants.

**Requirements**:
- Given GET /api/agents/:agentId/integrations, should list agent's grants
- Given POST /api/agents/:agentId/integrations, should create new grant
- Given PUT /api/agents/:agentId/integrations/:grantId, should update grant
- Given DELETE /api/agents/:agentId/integrations/:grantId, should remove grant
- Given user without agent access, should reject

---

## Task 25: Global Assistant Config API

API routes for global assistant preferences.

**Requirements**:
- Given GET /api/user/assistant-config, should return config or defaults
- Given PUT /api/user/assistant-config, should update preferences
- Given drive override update, should merge with existing overrides
- Given integration toggle, should update enabledUserIntegrations

---

## Task 26: Chat Route Integration

Integrate with existing AI chat route.

**Requirements**:
- Given agent with tool grants, should include integration tools in available tools
- Given global assistant, should resolve integrations based on config
- Given tool call to integration tool, should route through sandbox executor
- Given tool result, should include in response stream
- Given tool error, should include error in response

---

## Task 27: Built-in GitHub Adapter

Implement GitHub integration adapter.

**Requirements**:
- Given GitHub OAuth config, should have correct scopes
- Given list_repos tool, should list user's repositories
- Given get_issues tool, should fetch issues with filters
- Given create_issue tool, should create new issue
- Given create_pr_comment tool, should add PR comment
- Given GitHub API error, should return structured error

---

## Task 28: Built-in Slack Adapter

Implement Slack integration adapter.

**Requirements**:
- Given Slack OAuth config, should request appropriate scopes
- Given list_channels tool, should list accessible channels
- Given send_message tool, should post to channel
- Given list_messages tool, should fetch recent messages
- Given Slack API error, should return structured error

---

## Task 29: Built-in Notion Adapter

Implement Notion integration adapter.

**Requirements**:
- Given Notion OAuth config, should request appropriate scopes
- Given search tool, should search across workspace
- Given get_page tool, should fetch page content
- Given update_page tool, should update page properties
- Given Notion API error, should return structured error

---

## Task 30: Generic Webhook Adapter

Implement generic webhook sender.

**Requirements**:
- Given webhook URL in connection, should send to that URL
- Given send_webhook tool, should POST JSON payload
- Given secret header configured, should include it
- Given webhook error, should return status

---

## Task 31: User Integrations Settings Page

Implement user settings page for integrations.

**Requirements**:
- Given user on settings page, should list connected integrations
- Given connect button, should initiate OAuth or show API key form
- Given connected integration, should show account info and visibility toggle
- Given disconnect button, should remove connection after confirmation
- Given integration with agents, should warn about affected agents

---

## Task 32: Drive Integrations Admin Page

Implement drive admin page for integrations.

**Requirements**:
- Given admin on drive settings, should see integrations section
- Given connect button, should initiate connection for drive
- Given connected integration, should show which agents have access
- Given disconnect button, should remove connection after confirmation
- Given non-admin, should not see admin controls

---

## Task 33: Agent Integration Panel

Implement agent configuration panel for integrations.

**Requirements**:
- Given agent config page, should show available integrations
- Given integration toggle, should create/remove grant
- Given integration with tools, should allow tool filtering
- Given read-only toggle, should update grant
- Given no integrations available, should show helpful message

---

## Task 34: Integration Audit Log UI

Implement audit log viewer.

**Requirements**:
- Given drive admin, should see integration audit logs
- Given log entries, should show tool, success, duration, timestamp
- Given filter by connection, should filter logs
- Given filter by success/failure, should filter logs
- Given pagination, should load more entries

---

## Task 35: Custom Tool Builder UI

Implement UI for creating custom integration tools.

**Requirements**:
- Given custom provider creation, should show tool builder
- Given tool form, should allow method, path, params, body definition
- Given input schema builder, should create JSON Schema
- Given test button, should execute tool with sample input
- Given save, should update provider config

---

## Task 36: OpenAPI Import UI

Implement UI for importing OpenAPI specs.

**Requirements**:
- Given URL input, should fetch and preview spec
- Given file upload, should parse and preview spec
- Given parsed spec, should show detected tools
- Given tool selection, should allow choosing which to import
- Given auth detection, should show detected auth method
- Given import confirm, should create provider

---

## Task 37: End-to-End Integration Tests

Implement E2E tests for the integration system.

**Requirements**:
- Given user with GitHub connection, should list repos via agent
- Given drive with Slack connection, should send message via agent
- Given agent without grant, should fail tool call
- Given expired connection, should fail with appropriate error
- Given rate limit exceeded, should fail with appropriate error

---

## Task 38: Security Audit

Conduct security review of the integration system.

**Requirements**:
- Given credential storage, should verify encryption at rest
- Given API routes, should verify authentication required
- Given admin routes, should verify role authorization
- Given tool execution, should verify no credential leakage to LLM
- Given audit logs, should verify sensitive data is not logged
- Given OAuth flow, should verify CSRF protection (state param)
- Given input validation, should verify JSON Schema enforcement

---

## Task 39: Documentation

Document the integration system.

**Requirements**:
- Given new integration feature, should update changelog
- Given admin setup, should document in admin guide
- Given user setup, should document in user guide
- Given adapter development, should document adapter interface
- Given OpenAPI import, should document supported features

---

## Appendix A: Provider Config Schema

Full JSON Schema for IntegrationProvider config object.

```json
{
  "type": "object",
  "required": ["id", "name", "authMethod", "baseUrl", "tools"],
  "properties": {
    "id": { "type": "string" },
    "name": { "type": "string" },
    "description": { "type": "string" },
    "iconUrl": { "type": "string", "format": "uri" },
    "documentationUrl": { "type": "string", "format": "uri" },
    "authMethod": { "$ref": "#/definitions/AuthMethod" },
    "baseUrl": { "type": "string", "format": "uri" },
    "defaultHeaders": {
      "type": "object",
      "additionalProperties": { "type": "string" }
    },
    "tools": {
      "type": "array",
      "items": { "$ref": "#/definitions/ToolDefinition" }
    },
    "credentialSchema": { "$ref": "http://json-schema.org/draft-07/schema#" },
    "healthCheck": {
      "type": "object",
      "properties": {
        "endpoint": { "type": "string" },
        "expectedStatus": { "type": "integer" }
      }
    }
  }
}
```

---

## Appendix B: Example Provider Configs

### API Key Provider (SendGrid)

```typescript
{
  id: 'sendgrid',
  name: 'SendGrid',
  authMethod: {
    type: 'api_key',
    config: {
      placement: 'header',
      paramName: 'Authorization',
      prefix: 'Bearer ',
    },
  },
  baseUrl: 'https://api.sendgrid.com/v3',
  tools: [{
    id: 'send_email',
    name: 'Send Email',
    description: 'Send an email via SendGrid',
    category: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', format: 'email' },
        subject: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['to', 'subject', 'body'],
    },
    execution: {
      type: 'http',
      config: {
        method: 'POST',
        pathTemplate: '/mail/send',
        bodyTemplate: {
          personalizations: [{ to: [{ email: { $param: 'to' } }] }],
          from: { email: 'noreply@example.com' },
          subject: { $param: 'subject' },
          content: [{ type: 'text/plain', value: { $param: 'body' } }],
        },
        bodyEncoding: 'json',
      },
    },
  }],
}
```

### GraphQL Provider (Linear)

```typescript
{
  id: 'linear',
  name: 'Linear',
  authMethod: {
    type: 'bearer_token',
    config: { prefix: 'Bearer ' },
  },
  baseUrl: 'https://api.linear.app',
  tools: [{
    id: 'list_issues',
    name: 'List Issues',
    description: 'List issues from Linear',
    category: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        teamId: { type: 'string' },
        state: { type: 'string' },
      },
    },
    execution: {
      type: 'graphql',
      config: {
        query: `
          query($teamId: String, $state: String) {
            issues(filter: { team: { id: { eq: $teamId } } }) {
              nodes { id title state { name } }
            }
          }
        `,
        variables: {
          teamId: { $param: 'teamId' },
          state: { $param: 'state' },
        },
      },
    },
    outputTransform: {
      extract: '$.data.issues.nodes',
    },
  }],
}
```

---

## Appendix C: Directory Structure

```
packages/
  lib/
    src/
      integrations/
        types.ts                    # All type definitions
        auth/
          apply-auth.ts             # Pure auth functions
          apply-auth.test.ts
        validation/
          is-tool-allowed.ts        # Pure validation
          is-tool-allowed.test.ts
          visibility.ts             # Pure visibility checks
          visibility.test.ts
        execution/
          build-request.ts          # Pure request building
          build-request.test.ts
          transform-output.ts       # Pure output transform
          transform-output.test.ts
        rate-limit/
          calculate-limit.ts        # Pure rate limit calc
          calculate-limit.test.ts

  db/
    src/
      schema/
        integrations.ts             # Drizzle schema

packages/
  lib/
    src/
      integrations/
        repositories/
          connection-repository.ts
          grant-repository.ts
          audit-repository.ts
        credentials/
          encrypt-credentials.ts
        execution/
          http-executor.ts
          build-request.ts
          transform-output.ts
        saga/
          execute-tool.ts           # Main execution saga
        validation/
          is-tool-allowed.ts        # Tool permission validation
        converter/
          ai-sdk.ts                 # AI SDK tool converter
          openapi.ts                # OpenAPI importer
        providers/
          github.ts
          slack.ts
          notion.ts
          webhook.ts
          index.ts                  # Provider registry

apps/
  web/
    src/
      app/
        api/
          integrations/
            providers/
              route.ts
              [providerId]/
                route.ts
          user/
            integrations/
              route.ts
              [connectionId]/
                route.ts
            assistant-config/
              route.ts
          drives/
            [driveId]/
              integrations/
                route.ts
                [connectionId]/
                  route.ts
          agents/
            [agentId]/
              integrations/
                route.ts
                [grantId]/
                  route.ts
        (authenticated)/
          settings/
            integrations/
              page.tsx
          [driveSlug]/
            settings/
              integrations/
                page.tsx
```

---

## Appendix D: Test Strategy

### Unit Tests (Pure Functions)

All pure functions tested in isolation with Riteway + Vitest.

```typescript
describe('applyAuth', async assert => {
  assert({
    given: 'bearer_token auth with default config',
    should: 'add Authorization header with Bearer prefix',
    actual: applyAuth(
      { token: 'abc123' },
      { type: 'bearer_token', config: {} }
    ),
    expected: {
      headers: { Authorization: 'Bearer abc123' },
      queryParams: {},
    },
  });
});
```

### Integration Tests (IO Functions)

Database and HTTP operations tested with real services.

```typescript
describe('connectionRepository', async assert => {
  // Use test database
  const connection = await createConnection({
    providerId: 'test',
    userId: testUser.id,
    credentials: { token: 'test' },
  });

  assert({
    given: 'valid connection data',
    should: 'create and return new connection',
    actual: connection.id !== undefined,
    expected: true,
  });

  // Cleanup
  await deleteConnection(connection.id);
});
```

### Saga Tests (Generator Testing)

Sagas tested by driving the generator.

```typescript
describe('executeIntegrationTool', async assert => {
  const gen = executeIntegrationTool({
    connectionId: 'conn1',
    toolName: 'list_repos',
    input: {},
  });

  assert({
    given: 'tool execution started',
    should: 'first call loadConnection',
    actual: gen.next().value,
    expected: call(loadConnection, 'conn1'),
  });

  // Pass fake connection
  const fakeConnection = { ... };

  assert({
    given: 'connection loaded',
    should: 'check rate limit',
    actual: gen.next(fakeConnection).value,
    expected: call(checkRateLimit, ...),
  });
});
```

### E2E Tests (Playwright)

Full user flows tested in browser.

```typescript
test('user can connect GitHub and use in agent', async ({ page }) => {
  await page.goto('/settings/integrations');
  await page.click('button:has-text("Connect GitHub")');
  // OAuth mock flow
  await page.waitForURL('/settings/integrations');
  expect(await page.textContent('.connection-status')).toBe('Connected');

  // Navigate to agent
  await page.goto('/drive/test/chat/test-agent');
  await page.fill('.chat-input', 'List my GitHub repos');
  await page.click('button:has-text("Send")');

  // Verify tool was called
  await expect(page.locator('.tool-call')).toContainText('list_repos');
});
```
