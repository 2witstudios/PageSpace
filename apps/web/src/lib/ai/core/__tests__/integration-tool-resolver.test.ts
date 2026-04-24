/**
 * Integration Tool Resolver Tests
 *
 * Verifies that resolvePageAgentIntegrationTools correctly wires
 * resolution, conversion, and execution dependencies together.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all integration module imports
vi.mock('@pagespace/db/db', () => ({
  db: {},
}));

vi.mock('@pagespace/lib/integrations/resolution/resolve-agent-integrations', () => ({
  resolveAgentIntegrations: vi.fn(),
  resolveGlobalAssistantIntegrations: vi.fn(),
}));
vi.mock('@pagespace/lib/integrations/converter/ai-sdk', () => ({
  convertIntegrationToolsToAISDK: vi.fn(),
}));
vi.mock('@pagespace/lib/integrations/saga/execute-tool', () => ({
  createToolExecutor: vi.fn(),
}));
vi.mock('@pagespace/lib/integrations/repositories/connection-repository', () => ({
  getConnectionWithProvider: vi.fn(),
  listUserConnections: vi.fn(),
  listDriveConnections: vi.fn(),
}));
vi.mock('@pagespace/lib/integrations/repositories/audit-repository', () => ({
  logAuditEntry: vi.fn(),
}));
vi.mock('@pagespace/lib/integrations/repositories/grant-repository', () => ({
  listGrantsByAgent: vi.fn(),
}));
vi.mock('@pagespace/lib/integrations/repositories/config-repository', () => ({
  getConfig: vi.fn(),
}));

import {
  resolveAgentIntegrations,
  resolveGlobalAssistantIntegrations,
} from '@pagespace/lib/integrations/resolution/resolve-agent-integrations';
import {
  convertIntegrationToolsToAISDK,
  type GrantWithConnectionAndProvider,
} from '@pagespace/lib/integrations/converter/ai-sdk';
import { createToolExecutor } from '@pagespace/lib/integrations/saga/execute-tool';
import { resolvePageAgentIntegrationTools, resolveGlobalAssistantIntegrationTools } from '../integration-tool-resolver';

const mockResolveAgentIntegrations = vi.mocked(resolveAgentIntegrations);
const mockResolveGlobalIntegrations = vi.mocked(resolveGlobalAssistantIntegrations);
const mockConvert = vi.mocked(convertIntegrationToolsToAISDK);
const mockCreateExecutor = vi.mocked(createToolExecutor);

describe('resolvePageAgentIntegrationTools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('given no grants, should return empty tool set', async () => {
    mockResolveAgentIntegrations.mockResolvedValue([]);

    const result = await resolvePageAgentIntegrationTools({
      agentId: 'agent-1',
      userId: 'user-1',
      driveId: 'drive-1',
    });

    expect(result).toEqual({});
    expect(mockConvert).not.toHaveBeenCalled();
  });

  it('given active grants, should convert to AI SDK tools', async () => {
    const mockGrants = [{
      id: 'grant-1',
      agentId: 'agent-1',
      connectionId: 'conn-1',
      allowedTools: null,
      deniedTools: null,
      readOnly: false,
      rateLimitOverride: null,
      connection: {
        id: 'conn-1',
        name: 'GitHub',
        status: 'active',
        providerId: 'prov-1',
        provider: {
          id: 'prov-1',
          slug: 'github',
          name: 'GitHub',
          config: { id: 'github', name: 'GitHub', tools: [], baseUrl: 'https://api.github.com', authMethod: { type: 'oauth2', config: {} } },
        },
      },
    }] as unknown as GrantWithConnectionAndProvider[];

    mockResolveAgentIntegrations.mockResolvedValue(mockGrants);
    const mockExecutor = vi.fn();
    mockCreateExecutor.mockReturnValue(mockExecutor);
    mockConvert.mockReturnValue({
      'int__github__conn1234__list_repos': {
        description: '[GitHub] List repos',
        inputSchema: {} as never,
        execute: vi.fn(),
      },
    });

    const result = await resolvePageAgentIntegrationTools({
      agentId: 'agent-1',
      userId: 'user-1',
      driveId: 'drive-1',
    });

    expect(Object.keys(result)).toHaveLength(1);
    expect(result).toHaveProperty('int__github__conn1234__list_repos');
    expect(mockConvert).toHaveBeenCalledWith(
      mockGrants,
      { userId: 'user-1', agentId: 'agent-1', driveId: 'drive-1' },
      mockExecutor
    );
  });
});

describe('resolveGlobalAssistantIntegrationTools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('given no grants, should return empty tool set', async () => {
    mockResolveGlobalIntegrations.mockResolvedValue([]);

    const result = await resolveGlobalAssistantIntegrationTools({
      userId: 'user-1',
      driveId: null,
      userDriveRole: null,
    });

    expect(result).toEqual({});
  });
});
