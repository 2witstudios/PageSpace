/**
 * Execute Tool Saga Tests
 *
 * Tests for the main execution saga that orchestrates tool calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ToolCallRequest,
  ToolDefinition,
  IntegrationProviderConfig,
} from '../types';
import { executeToolSaga, type ExecuteToolDependencies } from './execute-tool';

// Mock the imported modules
vi.mock('../validation/is-tool-allowed', () => ({
  isToolAllowed: vi.fn(),
}));

vi.mock('../auth/apply-auth', () => ({
  applyAuth: vi.fn(),
}));

vi.mock('../execution/build-request', () => ({
  buildHttpRequest: vi.fn(),
}));

vi.mock('../execution/transform-output', () => ({
  transformOutput: vi.fn(),
}));

vi.mock('../execution/http-executor', () => ({
  executeHttpRequest: vi.fn(),
}));

vi.mock('../credentials/encrypt-credentials', () => ({
  decryptCredentials: vi.fn(),
}));

vi.mock('../rate-limit/integration-rate-limiter', () => ({
  checkIntegrationRateLimit: vi.fn(),
}));

vi.mock('../rate-limit/calculate-limit', () => ({
  calculateEffectiveRateLimit: vi.fn(),
}));

// Import the mocked modules to control them in tests
import { isToolAllowed } from '../validation/is-tool-allowed';
import { applyAuth } from '../auth/apply-auth';
import { buildHttpRequest } from '../execution/build-request';
import { transformOutput } from '../execution/transform-output';
import { executeHttpRequest } from '../execution/http-executor';
import { decryptCredentials } from '../credentials/encrypt-credentials';
import { checkIntegrationRateLimit } from '../rate-limit/integration-rate-limiter';
import { calculateEffectiveRateLimit } from '../rate-limit/calculate-limit';

// Mock dependencies injected into the saga
const mockLoadConnection = vi.fn();
const mockLogAudit = vi.fn();

const mockDeps: ExecuteToolDependencies = {
  loadConnection: mockLoadConnection,
  logAudit: mockLogAudit,
};

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

describe('executeToolSaga', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Set default mock implementations
    vi.mocked(calculateEffectiveRateLimit).mockReturnValue(30);
    vi.mocked(checkIntegrationRateLimit).mockResolvedValue({ allowed: true });
    vi.mocked(isToolAllowed).mockReturnValue({ allowed: true });
    vi.mocked(decryptCredentials).mockResolvedValue({ token: 'decrypted-token' });
    vi.mocked(buildHttpRequest).mockReturnValue({
      url: 'https://api.github.com/user/repos',
      method: 'GET',
      headers: {},
    });
    vi.mocked(applyAuth).mockReturnValue({
      headers: { Authorization: 'Bearer decrypted-token' },
      queryParams: {},
    });
    vi.mocked(executeHttpRequest).mockResolvedValue({
      success: true,
      response: {
        status: 200,
        statusText: 'OK',
        headers: {},
        body: [{ name: 'repo1' }, { name: 'repo2' }],
        durationMs: 100,
      },
      retries: 0,
    });
    mockLogAudit.mockResolvedValue(undefined);
  });

  it('given valid tool call, should execute full pipeline and return result', async () => {
    mockLoadConnection.mockResolvedValue(createTestConnection());

    const request: ToolCallRequest = {
      userId: 'user-1',
      driveId: 'drive-1',
      connectionId: 'conn-123',
      agentId: 'agent-1',
      toolName: 'list_repos',
      input: {},
      grant: createTestGrant(),
    };

    const result = await executeToolSaga(request, mockDeps);

    expect(result.success).toBe(true);
    expect(result.data).toEqual([{ name: 'repo1' }, { name: 'repo2' }]);
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('given invalid tool, should return error without executing', async () => {
    mockLoadConnection.mockResolvedValue(createTestConnection());
    vi.mocked(isToolAllowed).mockReturnValue({ allowed: false, reason: 'Tool not in allowed list' });

    const request: ToolCallRequest = {
      userId: 'user-1',
      driveId: 'drive-1',
      connectionId: 'conn-123',
      agentId: 'agent-1',
      toolName: 'delete_repo',
      input: {},
      grant: createTestGrant({ allowedTools: ['list_repos'] }),
    };

    const result = await executeToolSaga(request, mockDeps);

    expect(result.success).toBe(false);
    expect(result.error).toContain('not in allowed list');
    expect(executeHttpRequest).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      errorType: 'TOOL_NOT_ALLOWED',
    }));
  });

  it('given rate limit exceeded, should return error without executing', async () => {
    mockLoadConnection.mockResolvedValue(createTestConnection());
    vi.mocked(checkIntegrationRateLimit).mockResolvedValue({ allowed: false, retryAfter: 30 });

    const request: ToolCallRequest = {
      userId: 'user-1',
      driveId: 'drive-1',
      connectionId: 'conn-123',
      agentId: 'agent-1',
      toolName: 'list_repos',
      input: {},
    };

    const result = await executeToolSaga(request, mockDeps);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Rate limit exceeded');
    expect(result.retryAfter).toBe(30);
    expect(executeHttpRequest).not.toHaveBeenCalled();
  });

  it('given auth error from API, should log and return error', async () => {
    mockLoadConnection.mockResolvedValue(createTestConnection());
    vi.mocked(executeHttpRequest).mockResolvedValue({
      success: false,
      error: 'HTTP 401: Unauthorized',
      errorType: 'client_error',
      response: {
        status: 401,
        statusText: 'Unauthorized',
        headers: {},
        body: null,
        durationMs: 50,
      },
      retries: 0,
    });

    const request: ToolCallRequest = {
      userId: 'user-1',
      driveId: 'drive-1',
      connectionId: 'conn-123',
      agentId: 'agent-1',
      toolName: 'list_repos',
      input: {},
    };

    const result = await executeToolSaga(request, mockDeps);

    expect(result.success).toBe(false);
    expect(result.error).toContain('401');
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      responseCode: 401,
    }));
  });

  it('given successful execution, should log audit entry', async () => {
    mockLoadConnection.mockResolvedValue(createTestConnection());

    const request: ToolCallRequest = {
      userId: 'user-1',
      driveId: 'drive-1',
      connectionId: 'conn-123',
      agentId: 'agent-1',
      toolName: 'list_repos',
      input: {},
    };

    await executeToolSaga(request, mockDeps);

    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      responseCode: 200,
    }));
  });

  it('given failed execution, should log audit entry with error', async () => {
    mockLoadConnection.mockResolvedValue(createTestConnection());
    vi.mocked(executeHttpRequest).mockResolvedValue({
      success: false,
      error: 'Server error',
      errorType: 'server_error',
      response: {
        status: 500,
        statusText: 'Internal Server Error',
        headers: {},
        body: null,
        durationMs: 100,
      },
      retries: 3,
    });

    const request: ToolCallRequest = {
      userId: 'user-1',
      driveId: 'drive-1',
      connectionId: 'conn-123',
      agentId: 'agent-1',
      toolName: 'list_repos',
      input: {},
    };

    await executeToolSaga(request, mockDeps);

    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      errorMessage: 'Server error',
      responseCode: 500,
    }));
  });

  it('given inactive connection, should return error', async () => {
    mockLoadConnection.mockResolvedValue(createTestConnection({ status: 'expired' }));

    const request: ToolCallRequest = {
      userId: 'user-1',
      driveId: 'drive-1',
      connectionId: 'conn-123',
      agentId: 'agent-1',
      toolName: 'list_repos',
      input: {},
    };

    const result = await executeToolSaga(request, mockDeps);

    expect(result.success).toBe(false);
    expect(result.error).toContain('expired');
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      errorType: 'INTEGRATION_INACTIVE',
    }));
  });

  it('given connection with authMethod none and null credentials, should execute without crash', async () => {
    const noneAuthProvider = createTestProvider({
      authMethod: { type: 'none' },
    });
    mockLoadConnection.mockResolvedValue(
      createTestConnection({
        credentials: null,
        provider: {
          id: 'public-api',
          slug: 'public-api',
          name: 'Public API',
          config: noneAuthProvider,
        },
      })
    );
    vi.mocked(executeHttpRequest).mockResolvedValue({
      success: true,
      response: {
        status: 200,
        statusText: 'OK',
        headers: {},
        body: [],
        durationMs: 50,
      },
      retries: 0,
    });

    const request: ToolCallRequest = {
      userId: 'user-1',
      driveId: 'drive-1',
      connectionId: 'conn-123',
      agentId: 'agent-1',
      toolName: 'list_repos',
      input: {},
    };

    const result = await executeToolSaga(request, mockDeps);

    expect(result.success).toBe(true);
    expect(decryptCredentials).not.toHaveBeenCalled();
  });
});
