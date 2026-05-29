import { describe, it, expect, vi } from 'vitest';
import {
  buildIntegrationToolName,
  parseIntegrationToolName,
  isIntegrationTool,
  convertToolSchemaToZod,
  convertIntegrationToolsToAISDK,
  type GrantWithConnectionAndProvider,
} from './ai-sdk';
import type { IntegrationProviderConfig, ToolCallResult } from '../types';

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL NAME UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildIntegrationToolName', () => {
  it('should build a compact namespaced tool name without a connection segment', () => {
    const result = buildIntegrationToolName('github', 'list_repos');
    expect(result).toBe('int__github__list_repos');
  });

  it('should append a ~-prefixed 8-char disambiguator when a connectionId is given', () => {
    const result = buildIntegrationToolName('github', 'list_repos', 'abc123def456');
    expect(result).toBe('int__github__list_repos__~abc123de');
  });

  it('should truncate the disambiguator connectionId to 8 chars', () => {
    const result = buildIntegrationToolName('slack', 'send_message', 'longconnectionidhere');
    expect(result).toContain('__~longconn');
  });
});

describe('parseIntegrationToolName', () => {
  it('should parse a compact integration tool name', () => {
    const result = parseIntegrationToolName('int__github__list_repos');
    expect(result).toEqual({
      providerSlug: 'github',
      toolId: 'list_repos',
    });
  });

  it('should parse a disambiguated tool name and recover the connection short id', () => {
    const result = parseIntegrationToolName('int__github__list_repos__~abc123de');
    expect(result).toEqual({
      providerSlug: 'github',
      toolId: 'list_repos',
      connectionShortId: 'abc123de',
    });
  });

  it('should handle tool IDs with double underscores', () => {
    const result = parseIntegrationToolName('int__github__list__all__repos');
    expect(result).toEqual({
      providerSlug: 'github',
      toolId: 'list__all__repos',
    });
  });

  it('should handle double-underscore tool IDs alongside a disambiguator', () => {
    const result = parseIntegrationToolName('int__github__list__all__repos__~abc123de');
    expect(result).toEqual({
      providerSlug: 'github',
      toolId: 'list__all__repos',
      connectionShortId: 'abc123de',
    });
  });

  it('should return null for non-integration tool names', () => {
    expect(parseIntegrationToolName('mcp__filesystem__read')).toBeNull();
    expect(parseIntegrationToolName('some_tool')).toBeNull();
  });

  it('should return null for malformed names', () => {
    expect(parseIntegrationToolName('int__github')).toBeNull();
    expect(parseIntegrationToolName('int__')).toBeNull();
  });
});

describe('isIntegrationTool', () => {
  it('should return true for integration tools', () => {
    expect(isIntegrationTool('int__github__list_repos')).toBe(true);
  });

  it('should return false for non-integration tools', () => {
    expect(isIntegrationTool('mcp__filesystem__read')).toBe(false);
    expect(isIntegrationTool('web_search')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SCHEMA CONVERSION
// ═══════════════════════════════════════════════════════════════════════════════

describe('convertToolSchemaToZod', () => {
  it('should convert a simple schema with string and number', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name' },
        count: { type: 'number' },
      },
      required: ['name'],
    };

    const zodSchema = convertToolSchemaToZod(schema);
    const parsed = zodSchema.safeParse({ name: 'test' });
    expect(parsed.success).toBe(true);
  });

  it('should make non-required fields optional', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        optional_field: { type: 'string' },
      },
      required: ['name'],
    };

    const zodSchema = convertToolSchemaToZod(schema);
    const parsed = zodSchema.safeParse({ name: 'test' });
    expect(parsed.success).toBe(true);
  });

  it('should handle empty properties', () => {
    const schema = { type: 'object', properties: {} };
    const zodSchema = convertToolSchemaToZod(schema);
    const parsed = zodSchema.safeParse({});
    expect(parsed.success).toBe(true);
  });

  it('should skip prototype pollution properties', () => {
    const schema = {
      type: 'object',
      properties: {
        __proto__: { type: 'string' },
        constructor: { type: 'string' },
        name: { type: 'string' },
      },
      required: [],
    };

    const zodSchema = convertToolSchemaToZod(schema);
    const shape = zodSchema.shape;
    expect(shape).not.toHaveProperty('__proto__');
    expect(shape).not.toHaveProperty('constructor');
    expect(shape).toHaveProperty('name');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN CONVERTER
// ═══════════════════════════════════════════════════════════════════════════════

describe('convertIntegrationToolsToAISDK', () => {
  const mockProviderConfig: IntegrationProviderConfig = {
    id: 'provider-1',
    name: 'GitHub',
    baseUrl: 'https://api.github.com',
    authMethod: { type: 'bearer_token', config: {} },
    tools: [
      {
        id: 'list_repos',
        name: 'List Repos',
        description: 'List repositories for the authenticated user',
        category: 'read',
        inputSchema: {
          type: 'object',
          properties: {
            page: { type: 'number', description: 'Page number' },
          },
          required: [],
        },
        execution: {
          type: 'http',
          config: { method: 'GET', pathTemplate: '/user/repos' },
        },
      },
      {
        id: 'create_issue',
        name: 'Create Issue',
        description: 'Create a new issue',
        category: 'write',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            body: { type: 'string' },
          },
          required: ['title'],
        },
        execution: {
          type: 'http',
          config: { method: 'POST', pathTemplate: '/repos/{owner}/{repo}/issues' },
        },
      },
    ],
  };

  const mockGrant: GrantWithConnectionAndProvider = {
    id: 'grant-1',
    agentId: 'agent-1',
    connectionId: 'conn12345678abcdef',
    allowedTools: null,
    deniedTools: null,
    readOnly: false,
    rateLimitOverride: null,
    connection: {
      id: 'conn12345678abcdef',
      name: 'My GitHub',
      status: 'active',
      providerId: 'provider-1',
      provider: {
        id: 'provider-1',
        slug: 'github',
        name: 'GitHub',
        config: mockProviderConfig,
      },
    },
  };

  const executorContext = {
    userId: 'user-1',
    agentId: 'agent-1',
    driveId: 'drive-1',
  };

  it('should convert grants to AI SDK tools', () => {
    const mockExecutor = vi.fn();
    const tools = convertIntegrationToolsToAISDK([mockGrant], executorContext, mockExecutor);

    expect(Object.keys(tools)).toHaveLength(2);

    const toolNames = Object.keys(tools);
    expect(toolNames[0]).toBe('int__github__list_repos');
    expect(toolNames[1]).toBe('int__github__create_issue');
  });

  it('should disambiguate tool names when an agent has two connections for the same provider', () => {
    const secondConnection: GrantWithConnectionAndProvider = {
      ...mockGrant,
      id: 'grant-2',
      connectionId: 'conn99998888zzzz',
      connection: {
        ...mockGrant.connection!,
        id: 'conn99998888zzzz',
        name: 'Other GitHub',
      },
    };

    const mockExecutor = vi.fn();
    const tools = convertIntegrationToolsToAISDK(
      [mockGrant, secondConnection],
      executorContext,
      mockExecutor
    );

    const toolNames = Object.keys(tools);
    // Two connections × two tools, all uniquely named via the ~ disambiguator.
    expect(toolNames).toHaveLength(4);
    expect(new Set(toolNames).size).toBe(4);
    expect(toolNames).toContain('int__github__list_repos__~conn1234');
    expect(toolNames).toContain('int__github__list_repos__~conn9999');
    expect(toolNames.every((n) => /__~conn/.test(n))).toBe(true);
  });

  it('should prefix descriptions with provider name', () => {
    const mockExecutor = vi.fn();
    const tools = convertIntegrationToolsToAISDK([mockGrant], executorContext, mockExecutor);

    const firstTool = Object.values(tools)[0];
    expect(firstTool.description).toContain('[GitHub]');
    expect(firstTool.description).toContain('List repositories');
  });

  it('should call executor with correct request on execute', async () => {
    const mockResult: ToolCallResult = { success: true, data: { repos: [] } };
    const mockExecutor = vi.fn().mockResolvedValue(mockResult);

    const tools = convertIntegrationToolsToAISDK([mockGrant], executorContext, mockExecutor);
    const firstTool = Object.values(tools)[0];

    const result = await firstTool.execute({ page: 1 });

    expect(mockExecutor).toHaveBeenCalledWith({
      userId: 'user-1',
      agentId: 'agent-1',
      driveId: 'drive-1',
      connectionId: 'conn12345678abcdef',
      toolName: 'list_repos',
      input: { page: 1 },
      grant: {
        allowedTools: null,
        deniedTools: null,
        readOnly: false,
        rateLimitOverride: undefined,
      },
    });

    expect(result).toEqual({ repos: [] });
  });

  it('should throw on executor error with error message from result', async () => {
    const mockExecutor = vi.fn().mockResolvedValue({
      success: false,
      error: 'Rate limit exceeded',
      errorType: 'rate_limit',
    });

    const tools = convertIntegrationToolsToAISDK([mockGrant], executorContext, mockExecutor);
    const firstTool = Object.values(tools)[0];

    await expect(firstTool.execute({})).rejects.toThrow('Rate limit exceeded');
    expect(mockExecutor).toHaveBeenCalledTimes(1);
  });

  it('should skip grants with inactive connections', () => {
    const inactiveGrant: GrantWithConnectionAndProvider = {
      ...mockGrant,
      connection: { ...mockGrant.connection!, status: 'expired' },
    };

    const mockExecutor = vi.fn();
    const tools = convertIntegrationToolsToAISDK([inactiveGrant], executorContext, mockExecutor);

    expect(Object.keys(tools)).toHaveLength(0);
  });

  it('should skip grants with no connection', () => {
    const noConnectionGrant: GrantWithConnectionAndProvider = {
      ...mockGrant,
      connection: null,
    };

    const mockExecutor = vi.fn();
    const tools = convertIntegrationToolsToAISDK([noConnectionGrant], executorContext, mockExecutor);

    expect(Object.keys(tools)).toHaveLength(0);
  });

  it('should skip grants with no provider config', () => {
    const noProviderGrant: GrantWithConnectionAndProvider = {
      ...mockGrant,
      connection: { ...mockGrant.connection!, provider: null },
    };

    const mockExecutor = vi.fn();
    const tools = convertIntegrationToolsToAISDK([noProviderGrant], executorContext, mockExecutor);

    expect(Object.keys(tools)).toHaveLength(0);
  });

  it('should pass rateLimitOverride when grant has requestsPerMinute', async () => {
    const grantWithOverride: GrantWithConnectionAndProvider = {
      ...mockGrant,
      rateLimitOverride: { requestsPerMinute: 10 },
    };

    const mockResult: ToolCallResult = { success: true, data: {} };
    const mockExecutor = vi.fn().mockResolvedValue(mockResult);

    const tools = convertIntegrationToolsToAISDK([grantWithOverride], executorContext, mockExecutor);
    const firstTool = Object.values(tools)[0];

    await firstTool.execute({});

    expect(mockExecutor).toHaveBeenCalledWith(
      expect.objectContaining({
        grant: expect.objectContaining({
          rateLimitOverride: { requestsPerMinute: 10 },
        }),
      })
    );
  });

  it('should throw generic error when executor returns failure without error message', async () => {
    const mockExecutor = vi.fn().mockResolvedValue({
      success: false,
    });

    const tools = convertIntegrationToolsToAISDK([mockGrant], executorContext, mockExecutor);
    const firstTool = Object.values(tools)[0];

    const error = await firstTool.execute({}).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Integration tool execution failed');
    expect(mockExecutor).toHaveBeenCalledTimes(1);
  });

  it('should skip tools whose schema conversion throws', () => {
    const badToolConfig: IntegrationProviderConfig = {
      ...mockProviderConfig,
      tools: [
        {
          id: 'bad_tool',
          name: 'Bad Tool',
          description: 'Tool with bad schema',
          category: 'read',
          inputSchema: null as unknown as Record<string, unknown>,
          execution: {
            type: 'http',
            config: { method: 'GET', pathTemplate: '/bad' },
          },
        },
        ...mockProviderConfig.tools,
      ],
    };

    const grantWithBadTool: GrantWithConnectionAndProvider = {
      ...mockGrant,
      connection: {
        ...mockGrant.connection!,
        provider: {
          ...mockGrant.connection!.provider!,
          config: badToolConfig,
        },
      },
    };

    const mockExecutor = vi.fn();
    const tools = convertIntegrationToolsToAISDK([grantWithBadTool], executorContext, mockExecutor);

    // Bad tool should be skipped, but the two valid tools should be present
    const toolNames = Object.keys(tools);
    expect(toolNames).toHaveLength(2);
    expect(toolNames.every((name) => !name.includes('bad_tool'))).toBe(true);
    expect(toolNames.some((name) => name.includes('list_repos'))).toBe(true);
    expect(toolNames.some((name) => name.includes('create_issue'))).toBe(true);
  });
});

describe('convertToolSchemaToZod edge cases', () => {
  it('should skip properties that cause conversion errors', () => {
    const schema = {
      type: 'object',
      properties: {
        good: { type: 'string' },
        bad: null as unknown as Record<string, unknown>,
      },
      required: ['good'],
    };

    const zodSchema = convertToolSchemaToZod(schema);
    const shape = zodSchema.shape;
    expect(shape).toHaveProperty('good');
    expect(shape).not.toHaveProperty('bad');
  });
});
