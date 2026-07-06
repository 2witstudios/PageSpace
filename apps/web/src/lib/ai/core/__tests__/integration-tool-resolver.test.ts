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
vi.mock('@pagespace/lib/integrations/converter/ai-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pagespace/lib/integrations/converter/ai-sdk')>();
  return {
    ...actual,
    convertIntegrationToolsToAISDK: vi.fn(),
  };
});
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
vi.mock('@pagespace/lib/services/sandbox/can-run-code', () => ({
  canRunCode: vi.fn(),
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
import { canRunCode } from '@pagespace/lib/services/sandbox/can-run-code';
import { resolvePageAgentIntegrationTools, resolveGlobalAssistantIntegrationTools } from '../integration-tool-resolver';

const mockResolveAgentIntegrations = vi.mocked(resolveAgentIntegrations);
const mockResolveGlobalIntegrations = vi.mocked(resolveGlobalAssistantIntegrations);
const mockConvert = vi.mocked(convertIntegrationToolsToAISDK);
const mockCreateExecutor = vi.mocked(createToolExecutor);
const mockCanRunCode = vi.mocked(canRunCode);

describe('resolvePageAgentIntegrationTools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanRunCode.mockResolvedValue({ ok: true });
  });

  it('given no grants, should return empty tool set', async () => {
    mockResolveAgentIntegrations.mockResolvedValue([]);

    const result = await resolvePageAgentIntegrationTools({
      agentId: 'agent-1',
      userId: 'user-1',
      driveId: 'drive-1',
      currentTools: {},
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
      currentTools: {},
    });

    expect(Object.keys(result)).toHaveLength(1);
    expect(result).toHaveProperty('int__github__conn1234__list_repos');
    expect(mockConvert).toHaveBeenCalledWith(
      mockGrants,
      { userId: 'user-1', agentId: 'agent-1', driveId: 'drive-1' },
      mockExecutor
    );
  });

  it('given sandbox git tools active in currentTools, suppresses GitHub integration tools', async () => {
    const mockGrants = [{ id: 'grant-1' }] as unknown as GrantWithConnectionAndProvider[];
    mockResolveAgentIntegrations.mockResolvedValue(mockGrants);
    mockCreateExecutor.mockReturnValue(vi.fn());
    mockConvert.mockReturnValue({
      'int__github__list_repos': { description: 'x', inputSchema: {} as never, execute: vi.fn() },
      'int__slack__send_message': { description: 'x', inputSchema: {} as never, execute: vi.fn() },
    });

    const result = await resolvePageAgentIntegrationTools({
      agentId: 'agent-1',
      userId: 'user-1',
      driveId: 'drive-1',
      currentTools: { git_clone: {} },
    });

    expect(result).not.toHaveProperty('int__github__list_repos');
    expect(result).toHaveProperty('int__slack__send_message');
  });

  it('given sandbox git tools present but not authorized for this caller, keeps GitHub integration tools', async () => {
    mockCanRunCode.mockResolvedValue({ ok: false, reason: 'app_admin_required' });
    const mockGrants = [{ id: 'grant-1' }] as unknown as GrantWithConnectionAndProvider[];
    mockResolveAgentIntegrations.mockResolvedValue(mockGrants);
    mockCreateExecutor.mockReturnValue(vi.fn());
    mockConvert.mockReturnValue({
      'int__github__list_repos': { description: 'x', inputSchema: {} as never, execute: vi.fn() },
      'int__slack__send_message': { description: 'x', inputSchema: {} as never, execute: vi.fn() },
    });

    const result = await resolvePageAgentIntegrationTools({
      agentId: 'agent-1',
      userId: 'user-1',
      driveId: 'drive-1',
      currentTools: { git_clone: {} },
    });

    expect(result).toHaveProperty('int__github__list_repos');
    expect(result).toHaveProperty('int__slack__send_message');
  });

  it('given no sandbox git tools in currentTools, keeps GitHub integration tools', async () => {
    const mockGrants = [{ id: 'grant-1' }] as unknown as GrantWithConnectionAndProvider[];
    mockResolveAgentIntegrations.mockResolvedValue(mockGrants);
    mockCreateExecutor.mockReturnValue(vi.fn());
    mockConvert.mockReturnValue({
      'int__github__list_repos': { description: 'x', inputSchema: {} as never, execute: vi.fn() },
    });

    const result = await resolvePageAgentIntegrationTools({
      agentId: 'agent-1',
      userId: 'user-1',
      driveId: 'drive-1',
      currentTools: { read_page: {} },
    });

    expect(result).toHaveProperty('int__github__list_repos');
  });
});

describe('resolveGlobalAssistantIntegrationTools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanRunCode.mockResolvedValue({ ok: true });
  });

  it('given no grants, should return empty tool set', async () => {
    mockResolveGlobalIntegrations.mockResolvedValue([]);

    const result = await resolveGlobalAssistantIntegrationTools({
      userId: 'user-1',
      driveId: null,
      userDriveRole: null,
      currentTools: {},
    });

    expect(result).toEqual({});
  });

  it('given sandbox git tools active in currentTools, suppresses GitHub integration tools', async () => {
    mockResolveGlobalIntegrations.mockResolvedValue([{ id: 'grant-1' }] as never);
    mockCreateExecutor.mockReturnValue(vi.fn());
    mockConvert.mockReturnValue({
      'int__github__list_repos': { description: 'x', inputSchema: {} as never, execute: vi.fn() },
      'int__slack__send_message': { description: 'x', inputSchema: {} as never, execute: vi.fn() },
    });

    const result = await resolveGlobalAssistantIntegrationTools({
      userId: 'user-1',
      driveId: null,
      userDriveRole: null,
      currentTools: { gh_pr_view: {} },
    });

    expect(result).not.toHaveProperty('int__github__list_repos');
    expect(result).toHaveProperty('int__slack__send_message');
  });

  it('given sandbox git tools present but not authorized for this caller, keeps GitHub integration tools', async () => {
    mockCanRunCode.mockResolvedValue({ ok: false, reason: 'app_admin_required' });
    mockResolveGlobalIntegrations.mockResolvedValue([{ id: 'grant-1' }] as never);
    mockCreateExecutor.mockReturnValue(vi.fn());
    mockConvert.mockReturnValue({
      'int__github__list_repos': { description: 'x', inputSchema: {} as never, execute: vi.fn() },
      'int__slack__send_message': { description: 'x', inputSchema: {} as never, execute: vi.fn() },
    });

    const result = await resolveGlobalAssistantIntegrationTools({
      userId: 'user-1',
      driveId: null,
      userDriveRole: null,
      currentTools: { gh_pr_view: {} },
    });

    expect(result).toHaveProperty('int__github__list_repos');
    expect(result).toHaveProperty('int__slack__send_message');
  });
});

// ─── Tool key order determinism ──────────────────────────────────────────────

describe('integration tool key order determinism', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolvePageAgentIntegrationTools — two identical builds produce identical JSON.stringify(Object.keys(tools))', async () => {
    // Simulate a converter returning keys in non-alphabetical order
    const unorderedTools = {
      'int__z_tool': { description: 'Z', inputSchema: { type: 'object', properties: {} } as never, execute: vi.fn() },
      'int__a_tool': { description: 'A', inputSchema: { type: 'object', properties: {} } as never, execute: vi.fn() },
      'int__m_tool': { description: 'M', inputSchema: { type: 'object', properties: {} } as never, execute: vi.fn() },
    };

    mockResolveAgentIntegrations.mockResolvedValue([{} as never]);
    mockCreateExecutor.mockReturnValue(vi.fn());
    // Return the SAME object reference both times so any non-determinism comes
    // only from the sort step (not from mockConvert itself).
    mockConvert.mockReturnValue(unorderedTools);

    const build1 = await resolvePageAgentIntegrationTools({ agentId: 'a', userId: 'u', driveId: 'd', currentTools: {} });
    mockConvert.mockReturnValue(unorderedTools);
    const build2 = await resolvePageAgentIntegrationTools({ agentId: 'a', userId: 'u', driveId: 'd', currentTools: {} });

    expect(JSON.stringify(Object.keys(build1))).toBe(JSON.stringify(Object.keys(build2)));
    // Keys must be alphabetically sorted
    expect(Object.keys(build1)).toEqual(['int__a_tool', 'int__m_tool', 'int__z_tool']);
  });

  it('resolvePageAgentIntegrationTools — serialized schemas are identical across two builds', async () => {
    const toolDef = { description: 'T', inputSchema: { type: 'object', properties: { x: { type: 'string' } } } as never, execute: vi.fn() };
    const tools = { 'tool_b': toolDef, 'tool_a': toolDef };

    mockResolveAgentIntegrations.mockResolvedValue([{} as never]);
    mockCreateExecutor.mockReturnValue(vi.fn());
    mockConvert.mockReturnValue(tools);
    const build1 = await resolvePageAgentIntegrationTools({ agentId: 'a', userId: 'u', driveId: 'd', currentTools: {} });
    mockConvert.mockReturnValue(tools);
    const build2 = await resolvePageAgentIntegrationTools({ agentId: 'a', userId: 'u', driveId: 'd', currentTools: {} });

    // Both serializations must be byte-identical
    expect(JSON.stringify(build1)).toBe(JSON.stringify(build2));
  });
});
