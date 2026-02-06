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
  it('should build a namespaced tool name', () => {
    const result = buildIntegrationToolName('github', 'abc123def456', 'list_repos');
    expect(result).toBe('int__github__abc123de__list_repos');
  });

  it('should truncate connectionId to 8 chars', () => {
    const result = buildIntegrationToolName('slack', 'longconnectionidhere', 'send_message');
    expect(result).toContain('__longconn__');
  });
});

describe('parseIntegrationToolName', () => {
  it('should parse a valid integration tool name', () => {
    const result = parseIntegrationToolName('int__github__abc123de__list_repos');
    expect(result).toEqual({
      providerSlug: 'github',
      connectionId: 'abc123de',
      toolId: 'list_repos',
    });
  });

  it('should handle tool IDs with double underscores', () => {
    const result = parseIntegrationToolName('int__github__abc123de__list__all__repos');
    expect(result).toEqual({
      providerSlug: 'github',
      connectionId: 'abc123de',
      toolId: 'list__all__repos',
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
    expect(isIntegrationTool('int__github__abc__list_repos')).toBe(true);
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
    expect(toolNames[0]).toMatch(/^int__github__conn1234__list_repos$/);
    expect(toolNames[1]).toMatch(/^int__github__conn1234__create_issue$/);
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

  it('should throw on executor error', async () => {
    const mockExecutor = vi.fn().mockResolvedValue({
      success: false,
      error: 'Rate limit exceeded',
      errorType: 'rate_limit',
    });

    const tools = convertIntegrationToolsToAISDK([mockGrant], executorContext, mockExecutor);
    const firstTool = Object.values(tools)[0];

    await expect(firstTool.execute({})).rejects.toThrow('Rate limit exceeded');
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
});
