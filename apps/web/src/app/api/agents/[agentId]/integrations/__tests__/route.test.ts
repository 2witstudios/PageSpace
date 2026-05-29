/**
 * Security audit tests for /api/agents/[agentId]/integrations
 * Verifies auditRequest is called for GET (read).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockListGrantsByAgent = vi.hoisted(() => vi.fn());
const mockCreateGrant = vi.hoisted(() => vi.fn());
const mockFindGrant = vi.hoisted(() => vi.fn());
const mockGetConnectionWithProvider = vi.hoisted(() => vi.fn());
const mockGetDriveAccess = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: unknown) => result && typeof result === 'object' && 'error' in result),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {},
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
    loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    security: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
    auditRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
    canUserEditPage: vi.fn().mockResolvedValue(true),
}));

vi.mock('@pagespace/lib/services/drive-service', () => ({
  getDriveAccess: mockGetDriveAccess,
}));

vi.mock('@pagespace/lib/integrations/repositories/grant-repository', () => ({
  listGrantsByAgent: mockListGrantsByAgent,
  createGrant: mockCreateGrant,
  findGrant: mockFindGrant,
}));
vi.mock('@pagespace/lib/integrations/repositories/connection-repository', () => ({
  getConnectionWithProvider: mockGetConnectionWithProvider,
}));
vi.mock('@/lib/websocket/socket-utils', () => ({
  broadcastAgentGrantChanged: vi.fn(),
}));

import { GET, POST } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

const mockUserId = 'user_123';
const mockAgentId = 'agent-1';

const mockAuth = () => {
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
    userId: mockUserId,
    tokenVersion: 0,
    tokenType: 'session' as const,
    sessionId: 'test-session',
    role: 'user' as const,
    adminRoleVersion: 0,
  });
};

describe('GET /api/agents/[agentId]/integrations audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
    mockListGrantsByAgent.mockResolvedValue([]);
  });

  it('logs read audit event on successful agent integrations retrieval', async () => {
    await GET(
      new Request('http://localhost/api/agents/agent-1/integrations'),
      { params: Promise.resolve({ agentId: mockAgentId }) }
    );

    expect(auditRequest).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ eventType: 'data.read', userId: mockUserId, resourceType: 'agent_integrations', resourceId: mockAgentId })
    );
  });
});

describe('GET /api/agents/[agentId]/integrations response shape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
  });

  it('exposes sanitized provider tools and strips execution config', async () => {
    mockListGrantsByAgent.mockResolvedValue([
      {
        id: 'grant-1',
        agentId: mockAgentId,
        connectionId: 'conn-1',
        allowedTools: ['list_repos'],
        deniedTools: null,
        readOnly: false,
        rateLimitOverride: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        connection: {
          id: 'conn-1',
          name: 'GitHub Integration',
          status: 'active',
          provider: {
            slug: 'github',
            name: 'GitHub',
            config: {
              tools: [
                {
                  id: 'list_repos',
                  name: 'list_repos',
                  description: 'List repositories',
                  category: 'read',
                  inputSchema: { type: 'object' },
                  execution: { type: 'http', config: { method: 'GET', pathTemplate: '/user/repos' } },
                  rateLimit: { requestsPerMinute: 60 },
                },
                {
                  id: 'create_issue',
                  name: 'create_issue',
                  description: 'Create an issue',
                  category: 'write',
                  inputSchema: { type: 'object' },
                  execution: { type: 'http', config: { method: 'POST', pathTemplate: '/repos/{owner}/{repo}/issues' } },
                },
              ],
            },
          },
        },
      },
    ]);

    const response = await GET(
      new Request('http://localhost/api/agents/agent-1/integrations'),
      { params: Promise.resolve({ agentId: mockAgentId }) }
    );

    const body = await response.json();
    expect(body.grants).toHaveLength(1);
    const provider = body.grants[0].connection.provider;
    expect(provider.tools).toEqual([
      { id: 'list_repos', name: 'list_repos', description: 'List repositories', category: 'read' },
      { id: 'create_issue', name: 'create_issue', description: 'Create an issue', category: 'write' },
    ]);
    expect(provider.tools[0]).not.toHaveProperty('execution');
    expect(provider.tools[0]).not.toHaveProperty('inputSchema');
    expect(provider.tools[0]).not.toHaveProperty('rateLimit');
  });

  it('drops malformed tool entries while keeping well-formed ones', async () => {
    mockListGrantsByAgent.mockResolvedValue([
      {
        id: 'grant-1',
        agentId: mockAgentId,
        connectionId: 'conn-1',
        allowedTools: null,
        deniedTools: null,
        readOnly: false,
        rateLimitOverride: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        connection: {
          id: 'conn-1',
          name: 'Mixed Integration',
          status: 'active',
          provider: {
            slug: 'mixed',
            name: 'Mixed',
            config: {
              tools: [
                null,
                { id: 'good_tool', name: 'good_tool', description: 'works', category: 'read' },
                { id: 42, name: 'bad_tool', description: 'bad id type', category: 'read' },
                { id: 'no_category', name: 'no_category', description: 'missing category' },
                { id: 'bad_cat', name: 'bad_cat', description: 'bogus category', category: 'super_user' },
                'just-a-string',
              ],
            },
          },
        },
      },
    ]);

    const response = await GET(
      new Request('http://localhost/api/agents/agent-1/integrations'),
      { params: Promise.resolve({ agentId: mockAgentId }) }
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.grants[0].connection.provider.tools).toEqual([
      { id: 'good_tool', name: 'good_tool', description: 'works', category: 'read' },
    ]);
  });

  it.each([
    ['null config', { config: null }],
    ['missing tools key', { config: {} }],
    ['non-array tools', { config: { tools: 'oops' } }],
    ['object tools', { config: { tools: { id: 'x' } } }],
  ])('returns an empty tools array when provider has %s', async (_label, providerExtras) => {
    mockListGrantsByAgent.mockResolvedValue([
      {
        id: 'grant-1',
        agentId: mockAgentId,
        connectionId: 'conn-1',
        allowedTools: null,
        deniedTools: null,
        readOnly: false,
        rateLimitOverride: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        connection: {
          id: 'conn-1',
          name: 'Custom Integration',
          status: 'active',
          provider: {
            slug: 'custom',
            name: 'Custom',
            ...providerExtras,
          },
        },
      },
    ]);

    const response = await GET(
      new Request('http://localhost/api/agents/agent-1/integrations'),
      { params: Promise.resolve({ agentId: mockAgentId }) }
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.grants[0].connection.provider.tools).toEqual([]);
  });
});

describe('POST /api/agents/[agentId]/integrations default bundle', () => {
  const githubConnection = {
    id: 'conn-1',
    userId: mockUserId,
    driveId: null,
    status: 'active',
    provider: {
      slug: 'github',
      name: 'GitHub',
      config: {
        toolBundles: [
          { id: 'read_only', name: 'Read-only', description: 'reads', toolIds: ['list_repos', 'get_repo'], recommended: true },
          { id: 'full', name: 'Full access', description: 'all', toolIds: ['list_repos', 'get_repo', 'create_issue'] },
        ],
      },
    },
  };

  const postRequest = (body: Record<string, unknown>) =>
    new Request('http://localhost/api/agents/agent-1/integrations', {
      method: 'POST',
      body: JSON.stringify(body),
    });

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
    mockGetConnectionWithProvider.mockResolvedValue(githubConnection);
    mockFindGrant.mockResolvedValue(null);
    mockCreateGrant.mockImplementation(async (_db: unknown, input: Record<string, unknown>) => ({ id: 'grant-1', ...input }));
  });

  it('defaults allowedTools to the recommended bundle when none is provided', async () => {
    const response = await POST(postRequest({ connectionId: 'conn-1' }), {
      params: Promise.resolve({ agentId: mockAgentId }),
    });

    expect(response.status).toBe(201);
    expect(mockCreateGrant).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ allowedTools: ['list_repos', 'get_repo'] })
    );
  });

  it('respects an explicit allowedTools array over the default bundle', async () => {
    await POST(postRequest({ connectionId: 'conn-1', allowedTools: ['create_issue'] }), {
      params: Promise.resolve({ agentId: mockAgentId }),
    });

    expect(mockCreateGrant).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ allowedTools: ['create_issue'] })
    );
  });

  it('respects an explicit null (all tools) instead of applying the default bundle', async () => {
    await POST(postRequest({ connectionId: 'conn-1', allowedTools: null }), {
      params: Promise.resolve({ agentId: mockAgentId }),
    });

    expect(mockCreateGrant).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ allowedTools: null })
    );
  });
});
