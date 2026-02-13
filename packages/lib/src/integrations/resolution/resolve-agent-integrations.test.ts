import { describe, it, expect, vi } from 'vitest';
import {
  resolveAgentIntegrations,
  resolveGlobalAssistantIntegrations,
  type ResolutionDependencies,
  type ConnectionWithProviderForResolution,
} from './resolve-agent-integrations';
import type { GrantWithConnectionAndProvider } from '../converter/ai-sdk';

// ═══════════════════════════════════════════════════════════════════════════════
// TEST HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

const mockProviderConfig = {
  id: 'provider-1',
  name: 'GitHub',
  baseUrl: 'https://api.github.com',
  authMethod: { type: 'bearer_token' as const, config: {} },
  tools: [{ id: 'list_repos', name: 'List Repos', description: 'List repos', category: 'read' as const, inputSchema: {}, execution: { type: 'http' as const, config: { method: 'GET' as const, pathTemplate: '/repos' } } }],
};

const makeGrant = (overrides?: Partial<GrantWithConnectionAndProvider>): GrantWithConnectionAndProvider => ({
  id: 'grant-1',
  agentId: 'agent-1',
  connectionId: 'conn-1',
  allowedTools: null,
  deniedTools: null,
  readOnly: false,
  rateLimitOverride: null,
  connection: {
    id: 'conn-1',
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
  ...overrides,
});

const makeConnection = (overrides?: Partial<ConnectionWithProviderForResolution>): ConnectionWithProviderForResolution => ({
  id: 'conn-1',
  name: 'My GitHub',
  status: 'active',
  providerId: 'provider-1',
  visibility: 'all_drives',
  provider: {
    id: 'provider-1',
    slug: 'github',
    name: 'GitHub',
    config: mockProviderConfig,
  },
  ...overrides,
});

const createDeps = (overrides?: Partial<ResolutionDependencies>): ResolutionDependencies => ({
  listGrantsByAgent: vi.fn().mockResolvedValue([]),
  listUserConnections: vi.fn().mockResolvedValue([]),
  listDriveConnections: vi.fn().mockResolvedValue([]),
  getAssistantConfig: vi.fn().mockResolvedValue(null),
  ...overrides,
});

// ═══════════════════════════════════════════════════════════════════════════════
// AGENT RESOLUTION
// ═══════════════════════════════════════════════════════════════════════════════

describe('resolveAgentIntegrations', () => {
  it('should return active grants for an agent', async () => {
    const deps = createDeps({
      listGrantsByAgent: vi.fn().mockResolvedValue([makeGrant()]),
    });

    const result = await resolveAgentIntegrations(deps, 'agent-1');
    expect(result).toHaveLength(1);
    expect(result[0].connectionId).toBe('conn-1');
  });

  it('should filter out grants with inactive connections', async () => {
    const deps = createDeps({
      listGrantsByAgent: vi.fn().mockResolvedValue([
        makeGrant({ connection: { id: 'conn-1', name: 'Test', status: 'expired', providerId: 'p1', provider: { id: 'p1', slug: 'test', name: 'Test', config: mockProviderConfig } } }),
      ]),
    });

    const result = await resolveAgentIntegrations(deps, 'agent-1');
    expect(result).toHaveLength(0);
  });

  it('should filter out grants with no connection', async () => {
    const deps = createDeps({
      listGrantsByAgent: vi.fn().mockResolvedValue([
        makeGrant({ connection: null }),
      ]),
    });

    const result = await resolveAgentIntegrations(deps, 'agent-1');
    expect(result).toHaveLength(0);
  });

  it('should filter out grants with no provider config', async () => {
    const deps = createDeps({
      listGrantsByAgent: vi.fn().mockResolvedValue([
        makeGrant({ connection: { id: 'conn-1', name: 'Test', status: 'active', providerId: 'p1', provider: null } }),
      ]),
    });

    const result = await resolveAgentIntegrations(deps, 'agent-1');
    expect(result).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GLOBAL ASSISTANT RESOLUTION
// ═══════════════════════════════════════════════════════════════════════════════

describe('resolveGlobalAssistantIntegrations', () => {
  it('should return user connections visible in drive', async () => {
    const deps = createDeps({
      listUserConnections: vi.fn().mockResolvedValue([makeConnection()]),
    });

    const result = await resolveGlobalAssistantIntegrations(deps, 'user-1', 'drive-1', 'MEMBER');
    expect(result).toHaveLength(1);
    expect(result[0].connection?.id).toBe('conn-1');
  });

  it('should filter out user connections not visible in drive', async () => {
    const deps = createDeps({
      listUserConnections: vi.fn().mockResolvedValue([
        makeConnection({ visibility: 'private' }),
      ]),
    });

    const result = await resolveGlobalAssistantIntegrations(deps, 'user-1', 'drive-1', 'MEMBER');
    expect(result).toHaveLength(0);
  });

  it('should include drive connections when inheritDriveIntegrations is true', async () => {
    const deps = createDeps({
      listDriveConnections: vi.fn().mockResolvedValue([makeConnection({ id: 'drive-conn-1' })]),
    });

    const result = await resolveGlobalAssistantIntegrations(deps, 'user-1', 'drive-1', 'MEMBER');
    expect(result).toHaveLength(1);
    expect(result[0].connection?.id).toBe('drive-conn-1');
  });

  it('should not include drive connections when inheritDriveIntegrations is false', async () => {
    const deps = createDeps({
      listDriveConnections: vi.fn().mockResolvedValue([makeConnection({ id: 'drive-conn-1' })]),
      getAssistantConfig: vi.fn().mockResolvedValue({ inheritDriveIntegrations: false }),
    });

    const result = await resolveGlobalAssistantIntegrations(deps, 'user-1', 'drive-1', 'MEMBER');
    expect(result).toHaveLength(0);
  });

  it('should apply enabledUserIntegrations filter', async () => {
    const deps = createDeps({
      listUserConnections: vi.fn().mockResolvedValue([
        makeConnection({ id: 'conn-1' }),
        makeConnection({ id: 'conn-2', name: 'Other', providerId: 'p2' }),
      ]),
      getAssistantConfig: vi.fn().mockResolvedValue({
        enabledUserIntegrations: ['conn-1'],
      }),
    });

    const result = await resolveGlobalAssistantIntegrations(deps, 'user-1', 'drive-1', 'MEMBER');
    expect(result).toHaveLength(1);
    expect(result[0].connection?.id).toBe('conn-1');
  });

  it('should apply drive override to disable drive integrations', async () => {
    const deps = createDeps({
      listDriveConnections: vi.fn().mockResolvedValue([makeConnection()]),
      getAssistantConfig: vi.fn().mockResolvedValue({
        driveOverrides: { 'drive-1': { enabled: false } },
      }),
    });

    const result = await resolveGlobalAssistantIntegrations(deps, 'user-1', 'drive-1', 'MEMBER');
    expect(result).toHaveLength(0);
    expect(deps.listDriveConnections).not.toHaveBeenCalled();
  });

  it('should avoid duplicate providers between user and drive connections', async () => {
    const deps = createDeps({
      listUserConnections: vi.fn().mockResolvedValue([makeConnection({ id: 'user-conn' })]),
      listDriveConnections: vi.fn().mockResolvedValue([makeConnection({ id: 'drive-conn' })]),
    });

    const result = await resolveGlobalAssistantIntegrations(deps, 'user-1', 'drive-1', 'MEMBER');
    // Both have same providerId, so drive connection is deduplicated
    expect(result).toHaveLength(1);
    expect(result[0].connection?.id).toBe('user-conn');
  });

  it('should work without drive context', async () => {
    const deps = createDeps({
      listUserConnections: vi.fn().mockResolvedValue([
        makeConnection({ visibility: 'all_drives' }),
      ]),
    });

    const result = await resolveGlobalAssistantIntegrations(deps, 'user-1', null, null);
    // Without driveId, visibility check is skipped
    expect(result).toHaveLength(1);
  });
});
