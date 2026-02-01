/**
 * Execute Tool Saga Tests
 *
 * Tests for the main execution saga that orchestrates tool calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ToolCallRequest,
  ToolCallResult,
  ToolDefinition,
  IntegrationProviderConfig,
} from '../types';

// Mock dependencies
const mockLoadConnection = vi.fn();
const mockDecryptCredentials = vi.fn();
const mockCheckRateLimit = vi.fn();
const mockExecuteHttp = vi.fn();
const mockLogAudit = vi.fn();
const mockIsToolAllowed = vi.fn();
const mockBuildHttpRequest = vi.fn();
const mockApplyAuth = vi.fn();
const mockTransformOutput = vi.fn();

// Create test fixtures
const createTestTool = (overrides: Partial<ToolDefinition> = {}): ToolDefinition => ({
  id: 'list_repos',
  name: 'List Repositories',
  description: 'Lists repositories for the authenticated user',
  category: 'read',
  inputSchema: { type: 'object' },
  execution: {
    type: 'http',
    config: {
      method: 'GET',
      pathTemplate: '/user/repos',
    },
  },
  ...overrides,
});

const createTestProvider = (overrides: Partial<IntegrationProviderConfig> = {}): IntegrationProviderConfig => ({
  id: 'github',
  name: 'GitHub',
  baseUrl: 'https://api.github.com',
  authMethod: { type: 'bearer_token', config: {} },
  tools: [createTestTool()],
  ...overrides,
});

const createTestConnection = (overrides = {}) => ({
  id: 'conn-123',
  providerId: 'github',
  name: 'My GitHub',
  status: 'active',
  credentials: { token: 'encrypted:token' },
  provider: {
    id: 'github',
    slug: 'github',
    name: 'GitHub',
    config: createTestProvider(),
  },
  ...overrides,
});

const createTestGrant = (overrides = {}) => ({
  id: 'grant-123',
  agentId: 'agent-1',
  connectionId: 'conn-123',
  allowedTools: null,
  deniedTools: null,
  readOnly: false,
  ...overrides,
});

// Inline saga implementation for testing
const executeToolSaga = async (
  request: ToolCallRequest,
  deps: {
    loadConnection: typeof mockLoadConnection;
    decryptCredentials: typeof mockDecryptCredentials;
    checkRateLimit: typeof mockCheckRateLimit;
    executeHttp: typeof mockExecuteHttp;
    logAudit: typeof mockLogAudit;
    isToolAllowed: typeof mockIsToolAllowed;
    buildHttpRequest: typeof mockBuildHttpRequest;
    applyAuth: typeof mockApplyAuth;
    transformOutput: typeof mockTransformOutput;
  }
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
        durationMs: Date.now() - startTime,
      });
      return {
        success: false,
        error: `Integration is ${connection.status}`,
        errorType: 'validation',
      };
    }

    const providerConfig = connection.provider?.config as IntegrationProviderConfig;

    // 2. Validate tool is allowed
    const toolCheck = deps.isToolAllowed(request.toolName, {
      providerTools: providerConfig.tools,
      grantAllowedTools: request.grant?.allowedTools ?? null,
      grantDeniedTools: request.grant?.deniedTools ?? null,
      grantReadOnly: request.grant?.readOnly ?? false,
    });

    if (!toolCheck.allowed) {
      await deps.logAudit({
        success: false,
        errorType: 'TOOL_NOT_ALLOWED',
        durationMs: Date.now() - startTime,
      });
      return {
        success: false,
        error: toolCheck.reason,
        errorType: 'validation',
      };
    }

    // 3. Check rate limit
    const rateCheck = await deps.checkRateLimit({
      connectionId: request.connectionId,
      agentId: request.agentId,
      toolName: request.toolName,
      requestsPerMinute: 30,
    });

    if (!rateCheck.allowed) {
      await deps.logAudit({
        success: false,
        errorType: 'RATE_LIMITED',
        durationMs: Date.now() - startTime,
      });
      return {
        success: false,
        error: 'Rate limit exceeded',
        errorType: 'rate_limit',
        retryAfter: rateCheck.retryAfter,
      };
    }

    // 4. Decrypt credentials
    const credentials = await deps.decryptCredentials(connection.credentials as Record<string, string>);

    // 5. Find tool definition
    const tool = providerConfig.tools.find((t) => t.id === request.toolName);
    if (!tool || tool.execution.type !== 'http') {
      return {
        success: false,
        error: 'Tool not found or not HTTP type',
        errorType: 'validation',
      };
    }

    // 6. Build HTTP request
    const httpRequest = deps.buildHttpRequest(
      tool.execution.config,
      request.input,
      providerConfig.baseUrl
    );

    // 7. Apply authentication
    const auth = deps.applyAuth(credentials, providerConfig.authMethod);
    httpRequest.headers = { ...httpRequest.headers, ...auth.headers };

    // 8. Execute request
    const response = await deps.executeHttp(httpRequest);

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

    // 9. Transform output
    const result = tool.outputTransform
      ? deps.transformOutput(response.response?.body, tool.outputTransform)
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
    await deps.logAudit({
      success: false,
      errorType: 'INTERNAL_ERROR',
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
      durationMs: Date.now() - startTime,
    });

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      errorType: 'internal',
    };
  }
};

describe('executeToolSaga', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('given valid tool call, should execute full pipeline and return result', async () => {
    mockLoadConnection.mockResolvedValue(createTestConnection());
    mockIsToolAllowed.mockReturnValue({ allowed: true });
    mockCheckRateLimit.mockResolvedValue({ allowed: true });
    mockDecryptCredentials.mockResolvedValue({ token: 'decrypted-token' });
    mockBuildHttpRequest.mockReturnValue({
      url: 'https://api.github.com/user/repos',
      method: 'GET',
      headers: {},
    });
    mockApplyAuth.mockReturnValue({
      headers: { Authorization: 'Bearer decrypted-token' },
      queryParams: {},
    });
    mockExecuteHttp.mockResolvedValue({
      success: true,
      response: {
        status: 200,
        body: [{ name: 'repo1' }, { name: 'repo2' }],
      },
    });
    mockLogAudit.mockResolvedValue(undefined);

    const request: ToolCallRequest = {
      userId: 'user-1',
      driveId: 'drive-1',
      connectionId: 'conn-123',
      agentId: 'agent-1',
      toolName: 'list_repos',
      input: {},
      grant: createTestGrant(),
    };

    const result = await executeToolSaga(request, {
      loadConnection: mockLoadConnection,
      decryptCredentials: mockDecryptCredentials,
      checkRateLimit: mockCheckRateLimit,
      executeHttp: mockExecuteHttp,
      logAudit: mockLogAudit,
      isToolAllowed: mockIsToolAllowed,
      buildHttpRequest: mockBuildHttpRequest,
      applyAuth: mockApplyAuth,
      transformOutput: mockTransformOutput,
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual([{ name: 'repo1' }, { name: 'repo2' }]);
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('given invalid tool, should return error without executing', async () => {
    mockLoadConnection.mockResolvedValue(createTestConnection());
    mockIsToolAllowed.mockReturnValue({ allowed: false, reason: 'Tool not in allowed list' });
    mockLogAudit.mockResolvedValue(undefined);

    const request: ToolCallRequest = {
      userId: 'user-1',
      driveId: 'drive-1',
      connectionId: 'conn-123',
      agentId: 'agent-1',
      toolName: 'delete_repo',
      input: {},
      grant: createTestGrant({ allowedTools: ['list_repos'] }),
    };

    const result = await executeToolSaga(request, {
      loadConnection: mockLoadConnection,
      decryptCredentials: mockDecryptCredentials,
      checkRateLimit: mockCheckRateLimit,
      executeHttp: mockExecuteHttp,
      logAudit: mockLogAudit,
      isToolAllowed: mockIsToolAllowed,
      buildHttpRequest: mockBuildHttpRequest,
      applyAuth: mockApplyAuth,
      transformOutput: mockTransformOutput,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not in allowed list');
    expect(mockExecuteHttp).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      errorType: 'TOOL_NOT_ALLOWED',
    }));
  });

  it('given rate limit exceeded, should return error without executing', async () => {
    mockLoadConnection.mockResolvedValue(createTestConnection());
    mockIsToolAllowed.mockReturnValue({ allowed: true });
    mockCheckRateLimit.mockResolvedValue({ allowed: false, retryAfter: 30 });
    mockLogAudit.mockResolvedValue(undefined);

    const request: ToolCallRequest = {
      userId: 'user-1',
      driveId: 'drive-1',
      connectionId: 'conn-123',
      agentId: 'agent-1',
      toolName: 'list_repos',
      input: {},
    };

    const result = await executeToolSaga(request, {
      loadConnection: mockLoadConnection,
      decryptCredentials: mockDecryptCredentials,
      checkRateLimit: mockCheckRateLimit,
      executeHttp: mockExecuteHttp,
      logAudit: mockLogAudit,
      isToolAllowed: mockIsToolAllowed,
      buildHttpRequest: mockBuildHttpRequest,
      applyAuth: mockApplyAuth,
      transformOutput: mockTransformOutput,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Rate limit exceeded');
    expect(result.retryAfter).toBe(30);
    expect(mockExecuteHttp).not.toHaveBeenCalled();
  });

  it('given auth error from API, should log and return error', async () => {
    mockLoadConnection.mockResolvedValue(createTestConnection());
    mockIsToolAllowed.mockReturnValue({ allowed: true });
    mockCheckRateLimit.mockResolvedValue({ allowed: true });
    mockDecryptCredentials.mockResolvedValue({ token: 'bad-token' });
    mockBuildHttpRequest.mockReturnValue({
      url: 'https://api.github.com/user/repos',
      method: 'GET',
      headers: {},
    });
    mockApplyAuth.mockReturnValue({
      headers: { Authorization: 'Bearer bad-token' },
      queryParams: {},
    });
    mockExecuteHttp.mockResolvedValue({
      success: false,
      error: 'HTTP 401: Unauthorized',
      errorType: 'client_error',
      response: { status: 401 },
    });
    mockLogAudit.mockResolvedValue(undefined);

    const request: ToolCallRequest = {
      userId: 'user-1',
      driveId: 'drive-1',
      connectionId: 'conn-123',
      agentId: 'agent-1',
      toolName: 'list_repos',
      input: {},
    };

    const result = await executeToolSaga(request, {
      loadConnection: mockLoadConnection,
      decryptCredentials: mockDecryptCredentials,
      checkRateLimit: mockCheckRateLimit,
      executeHttp: mockExecuteHttp,
      logAudit: mockLogAudit,
      isToolAllowed: mockIsToolAllowed,
      buildHttpRequest: mockBuildHttpRequest,
      applyAuth: mockApplyAuth,
      transformOutput: mockTransformOutput,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('401');
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      responseCode: 401,
    }));
  });

  it('given successful execution, should log audit entry', async () => {
    mockLoadConnection.mockResolvedValue(createTestConnection());
    mockIsToolAllowed.mockReturnValue({ allowed: true });
    mockCheckRateLimit.mockResolvedValue({ allowed: true });
    mockDecryptCredentials.mockResolvedValue({ token: 'decrypted-token' });
    mockBuildHttpRequest.mockReturnValue({
      url: 'https://api.github.com/user/repos',
      method: 'GET',
      headers: {},
    });
    mockApplyAuth.mockReturnValue({
      headers: { Authorization: 'Bearer decrypted-token' },
      queryParams: {},
    });
    mockExecuteHttp.mockResolvedValue({
      success: true,
      response: { status: 200, body: [] },
    });
    mockLogAudit.mockResolvedValue(undefined);

    const request: ToolCallRequest = {
      userId: 'user-1',
      driveId: 'drive-1',
      connectionId: 'conn-123',
      agentId: 'agent-1',
      toolName: 'list_repos',
      input: {},
    };

    await executeToolSaga(request, {
      loadConnection: mockLoadConnection,
      decryptCredentials: mockDecryptCredentials,
      checkRateLimit: mockCheckRateLimit,
      executeHttp: mockExecuteHttp,
      logAudit: mockLogAudit,
      isToolAllowed: mockIsToolAllowed,
      buildHttpRequest: mockBuildHttpRequest,
      applyAuth: mockApplyAuth,
      transformOutput: mockTransformOutput,
    });

    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      responseCode: 200,
    }));
  });

  it('given failed execution, should log audit entry with error', async () => {
    mockLoadConnection.mockResolvedValue(createTestConnection());
    mockIsToolAllowed.mockReturnValue({ allowed: true });
    mockCheckRateLimit.mockResolvedValue({ allowed: true });
    mockDecryptCredentials.mockResolvedValue({ token: 'decrypted-token' });
    mockBuildHttpRequest.mockReturnValue({
      url: 'https://api.github.com/user/repos',
      method: 'GET',
      headers: {},
    });
    mockApplyAuth.mockReturnValue({
      headers: { Authorization: 'Bearer decrypted-token' },
      queryParams: {},
    });
    mockExecuteHttp.mockResolvedValue({
      success: false,
      error: 'Server error',
      errorType: 'server_error',
      response: { status: 500 },
    });
    mockLogAudit.mockResolvedValue(undefined);

    const request: ToolCallRequest = {
      userId: 'user-1',
      driveId: 'drive-1',
      connectionId: 'conn-123',
      agentId: 'agent-1',
      toolName: 'list_repos',
      input: {},
    };

    await executeToolSaga(request, {
      loadConnection: mockLoadConnection,
      decryptCredentials: mockDecryptCredentials,
      checkRateLimit: mockCheckRateLimit,
      executeHttp: mockExecuteHttp,
      logAudit: mockLogAudit,
      isToolAllowed: mockIsToolAllowed,
      buildHttpRequest: mockBuildHttpRequest,
      applyAuth: mockApplyAuth,
      transformOutput: mockTransformOutput,
    });

    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      errorMessage: 'Server error',
      responseCode: 500,
    }));
  });

  it('given inactive connection, should return error', async () => {
    mockLoadConnection.mockResolvedValue(createTestConnection({ status: 'expired' }));
    mockLogAudit.mockResolvedValue(undefined);

    const request: ToolCallRequest = {
      userId: 'user-1',
      driveId: 'drive-1',
      connectionId: 'conn-123',
      agentId: 'agent-1',
      toolName: 'list_repos',
      input: {},
    };

    const result = await executeToolSaga(request, {
      loadConnection: mockLoadConnection,
      decryptCredentials: mockDecryptCredentials,
      checkRateLimit: mockCheckRateLimit,
      executeHttp: mockExecuteHttp,
      logAudit: mockLogAudit,
      isToolAllowed: mockIsToolAllowed,
      buildHttpRequest: mockBuildHttpRequest,
      applyAuth: mockApplyAuth,
      transformOutput: mockTransformOutput,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('expired');
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      errorType: 'INTEGRATION_INACTIVE',
    }));
  });
});
