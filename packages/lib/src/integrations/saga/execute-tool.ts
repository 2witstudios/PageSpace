/**
 * Execute Tool Saga
 *
 * Main orchestration for executing integration tool calls.
 * Combines pure functions with IO operations in a testable way.
 */

import type {
  ToolCallRequest,
  ToolCallResult,
  IntegrationProviderConfig,
  HttpExecutionConfig,
} from '../types';
import { isToolAllowed } from '../validation/is-tool-allowed';
import { applyAuth } from '../auth/apply-auth';
import { buildHttpRequest } from '../execution/build-request';
import { transformOutput } from '../execution/transform-output';
import { executeHttpRequest, type ExecuteResult } from '../execution/http-executor';
import { decryptCredentials } from '../credentials/encrypt-credentials';
import { checkIntegrationRateLimit } from '../rate-limit/integration-rate-limiter';
import { calculateEffectiveRateLimit } from '../rate-limit/calculate-limit';

/**
 * Dependencies that can be injected for testing.
 */
export interface ExecuteToolDependencies {
  loadConnection: (connectionId: string) => Promise<ConnectionWithProvider | null>;
  logAudit: (entry: AuditEntry) => Promise<void>;
}

interface ConnectionWithProvider {
  id: string;
  providerId: string;
  name: string;
  status: string;
  credentials: unknown;
  baseUrlOverride?: string | null;
  provider?: {
    id: string;
    slug: string;
    name: string;
    config: IntegrationProviderConfig;
  } | null;
}

interface AuditEntry {
  success: boolean;
  errorType?: string;
  errorMessage?: string;
  responseCode?: number;
  durationMs: number;
}

/**
 * Execute a tool call with full validation and error handling.
 *
 * Pipeline:
 * 1. Load connection with provider config
 * 2. Validate tool is allowed
 * 3. Check rate limits
 * 4. Decrypt credentials
 * 5. Build HTTP request
 * 6. Apply authentication
 * 7. Execute request
 * 8. Transform output
 * 9. Log audit entry
 */
export const executeToolSaga = async (
  request: ToolCallRequest,
  deps: ExecuteToolDependencies
): Promise<ToolCallResult> => {
  const startTime = Date.now();

  try {
    // 1. Load connection with provider config
    const connection = await deps.loadConnection(request.connectionId);

    if (!connection) {
      return {
        success: false,
        error: 'Connection not found',
        errorType: 'validation',
      };
    }

    if (connection.status !== 'active') {
      await deps.logAudit({
        success: false,
        errorType: 'INTEGRATION_INACTIVE',
        errorMessage: `Integration is ${connection.status}`,
        durationMs: Date.now() - startTime,
      });

      return {
        success: false,
        error: `Integration is ${connection.status}`,
        errorType: 'validation',
      };
    }

    if (!connection.provider?.config) {
      return {
        success: false,
        error: 'Provider config not found',
        errorType: 'validation',
      };
    }

    const providerConfig = connection.provider.config;

    // 2. Validate tool is allowed (pure function)
    const toolCheck = isToolAllowed(request.toolName, {
      providerTools: providerConfig.tools,
      grantAllowedTools: request.grant?.allowedTools ?? null,
      grantDeniedTools: request.grant?.deniedTools ?? null,
      grantReadOnly: request.grant?.readOnly ?? false,
    });

    if (!toolCheck.allowed) {
      await deps.logAudit({
        success: false,
        errorType: 'TOOL_NOT_ALLOWED',
        errorMessage: toolCheck.reason,
        durationMs: Date.now() - startTime,
      });

      return {
        success: false,
        error: toolCheck.reason,
        errorType: 'validation',
      };
    }

    // 3. Find tool definition
    const tool = providerConfig.tools.find((t) => t.id === request.toolName);

    if (!tool) {
      return {
        success: false,
        error: `Tool '${request.toolName}' not found in provider`,
        errorType: 'validation',
      };
    }

    if (tool.execution.type !== 'http') {
      return {
        success: false,
        error: `Tool execution type '${tool.execution.type}' not yet supported`,
        errorType: 'validation',
      };
    }

    // 4. Calculate and check rate limit (includes tool-specific limit)
    const effectiveRateLimit = calculateEffectiveRateLimit({
      provider: providerConfig.rateLimit,
      connection: undefined, // TODO: Load from connection.configOverrides
      grant: request.grant?.rateLimitOverride ?? undefined,
      tool: tool.rateLimit,
    });

    const rateCheck = await checkIntegrationRateLimit({
      connectionId: request.connectionId,
      agentId: request.agentId,
      toolName: request.toolName,
      requestsPerMinute: effectiveRateLimit,
    });

    if (!rateCheck.allowed) {
      await deps.logAudit({
        success: false,
        errorType: 'RATE_LIMITED',
        errorMessage: 'Rate limit exceeded',
        durationMs: Date.now() - startTime,
      });

      return {
        success: false,
        error: 'Rate limit exceeded',
        errorType: 'rate_limit',
        retryAfter: rateCheck.retryAfter,
      };
    }

    // 5. Decrypt credentials (skip for 'none' auth or null credentials)
    const credentials =
      providerConfig.authMethod.type === 'none' || !connection.credentials
        ? {}
        : await decryptCredentials(
            connection.credentials as Record<string, string>
          );

    // 6. Build HTTP request (pure function)
    const baseUrl = connection.baseUrlOverride || providerConfig.baseUrl;
    const httpRequest = buildHttpRequest(
      tool.execution.config as HttpExecutionConfig,
      request.input,
      baseUrl
    );

    // 7. Apply authentication (pure function)
    const auth = applyAuth(credentials, providerConfig.authMethod);
    httpRequest.headers = { ...httpRequest.headers, ...auth.headers };

    // Add auth query params to URL if present
    if (Object.keys(auth.queryParams).length > 0) {
      const url = new URL(httpRequest.url);
      for (const [key, value] of Object.entries(auth.queryParams)) {
        url.searchParams.append(key, value);
      }
      httpRequest.url = url.toString();
    }

    // 8. Execute request
    const response: ExecuteResult = await executeHttpRequest(httpRequest);

    if (!response.success) {
      await deps.logAudit({
        success: false,
        errorType: response.errorType?.toUpperCase() || 'HTTP_ERROR',
        errorMessage: response.error,
        responseCode: response.response?.status,
        durationMs: Date.now() - startTime,
      });

      return {
        success: false,
        error: response.error,
        errorType: 'http',
      };
    }

    // 9. Transform output (pure function)
    const result = tool.outputTransform
      ? transformOutput(response.response?.body, tool.outputTransform)
      : response.response?.body;

    // 10. Log success
    await deps.logAudit({
      success: true,
      responseCode: response.response?.status,
      durationMs: Date.now() - startTime,
    });

    return {
      success: true,
      data: result,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    await deps.logAudit({
      success: false,
      errorType: 'INTERNAL_ERROR',
      errorMessage,
      durationMs: Date.now() - startTime,
    });

    return {
      success: false,
      error: errorMessage,
      errorType: 'internal',
    };
  }
};

/**
 * Create a configured saga executor with injected dependencies.
 * This is the primary way to use the saga in production.
 */
export const createToolExecutor = (deps: ExecuteToolDependencies) => {
  return (request: ToolCallRequest) => executeToolSaga(request, deps);
};
