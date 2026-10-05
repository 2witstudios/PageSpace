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
vi.mock('@pagespace/lib/integrations/saga/create-configured-executor', () => ({
  createConfiguredToolExecutor: vi.fn(),
}));
vi.mock('@pagespace/lib/integrations/repositories/connection-repository', () => ({
  listUserConnections: vi.fn(),
  listDriveConnections: vi.fn(),
}));
vi.mock('@pagespace/lib/integrations/repositories/grant-repository', () => ({
  listGrantsByAgent: vi.fn(),
}));
vi.mock('@pagespace/lib/integrations/repositories/config-repository', () => ({
  getConfig: vi.fn(),
}));
vi.mock('@pagespace/lib/services/drive-service', () => ({
  getDriveAccess: vi.fn(),
}));
vi.mock('@pagespace/lib/deployment-mode', () => ({
  isOnPrem: vi.fn(() => false),
}));

import {
  resolveAgentIntegrations,
  resolveGlobalAssistantIntegrations,
} from '@pagespace/lib/integrations/resolution/resolve-agent-integrations';
import {
  convertIntegrationToolsToAISDK,
  type GrantWithConnectionAndProvider,
} from '@pagespace/lib/integrations/converter/ai-sdk';
import { createConfiguredToolExecutor } from '@pagespace/lib/integrations/saga/create-configured-executor';
import { getDriveAccess } from '@pagespace/lib/services/drive-service';
import { isOnPrem } from '@pagespace/lib/deployment-mode';
import {
  resolvePageAgentIntegrationTools,
  resolveGlobalAssistantIntegrationTools,
  resolveImagoAgentIntegrationTools,
  resolveIntegrationDriveScope,
} from '../integration-tool-resolver';

const mockResolveAgentIntegrations = vi.mocked(resolveAgentIntegrations);
const mockResolveGlobalIntegrations = vi.mocked(resolveGlobalAssistantIntegrations);
const mockConvert = vi.mocked(convertIntegrationToolsToAISDK);
const mockCreateExecutor = vi.mocked(createConfiguredToolExecutor);
const mockGetDriveAccess = vi.mocked(getDriveAccess);
const mockIsOnPrem = vi.mocked(isOnPrem);

const access = (role: 'OWNER' | 'ADMIN' | 'MEMBER' | null) => ({
  isOwner: role === 'OWNER',
  isAdmin: role === 'OWNER' || role === 'ADMIN',
  isMember: role !== null,
  role,
  customRoleId: null,
});

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
});

describe('resolveIntegrationDriveScope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('given no drive, should scope to no drive without a lookup', async () => {
    expect(await resolveIntegrationDriveScope('user-1', null)).toEqual({ driveId: null, userDriveRole: null });
    expect(mockGetDriveAccess).not.toHaveBeenCalled();
  });

  it("given a drive the user is a member of, should keep it with the user's role", async () => {
    mockGetDriveAccess.mockResolvedValue(access('ADMIN'));

    expect(await resolveIntegrationDriveScope('user-1', 'drive-1')).toEqual({ driveId: 'drive-1', userDriveRole: 'ADMIN' });
    expect(mockGetDriveAccess).toHaveBeenCalledWith('drive-1', 'user-1');
  });

  it('given a drive the user is not a member of, should drop it', async () => {
    mockGetDriveAccess.mockResolvedValue(access(null));

    expect(await resolveIntegrationDriveScope('user-1', 'drive-1')).toEqual({ driveId: null, userDriveRole: null });
  });
});

describe('resolveImagoAgentIntegrationTools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsOnPrem.mockReturnValue(false);
  });

  it('given onprem mode, should resolve nothing', async () => {
    mockIsOnPrem.mockReturnValue(true);

    const result = await resolveImagoAgentIntegrationTools({
      agentId: 'imago-1',
      userId: 'user-1',
      grantedDriveId: 'drive-1',
      currentTools: {},
    });

    expect(result).toEqual({});
    expect(mockResolveGlobalIntegrations).not.toHaveBeenCalled();
  });

  it("given a granted drive, should resolve the user's integrations there and audit as the agent", async () => {
    mockGetDriveAccess.mockResolvedValue(access('OWNER'));
    mockResolveGlobalIntegrations.mockResolvedValue([{ id: 'grant-1' }] as never);
    mockCreateExecutor.mockReturnValue(vi.fn());
    mockConvert.mockReturnValue({
      'int__slack__send_message': { description: 'x', inputSchema: {} as never, execute: vi.fn() },
    });

    const result = await resolveImagoAgentIntegrationTools({
      agentId: 'imago-1',
      userId: 'user-1',
      grantedDriveId: 'drive-1',
      currentTools: {},
    });

    expect(mockResolveGlobalIntegrations).toHaveBeenCalledWith(expect.anything(), 'user-1', 'drive-1', 'OWNER');
    expect(mockCreateExecutor).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', agentId: 'imago-1', driveId: 'drive-1' }));
    expect(result).toHaveProperty('int__slack__send_message');
  });

  it('given no granted drive, should resolve user-level integrations only', async () => {
    mockResolveGlobalIntegrations.mockResolvedValue([]);

    const result = await resolveImagoAgentIntegrationTools({
      agentId: 'imago-1',
      userId: 'user-1',
      grantedDriveId: null,
      currentTools: {},
    });

    expect(result).toEqual({});
    expect(mockResolveGlobalIntegrations).toHaveBeenCalledWith(expect.anything(), 'user-1', null, null);
    expect(mockGetDriveAccess).not.toHaveBeenCalled();
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
