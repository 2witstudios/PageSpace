/**
 * Security audit tests for /api/agents/[agentId]/integrations
 * Verifies auditRequest is called for GET (read).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockListGrantsByAgent = vi.hoisted(() => vi.fn());

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
  getDriveAccess: vi.fn(),
}));

vi.mock('@pagespace/lib/integrations/repositories/grant-repository', () => ({
  listGrantsByAgent: mockListGrantsByAgent,
  createGrant: vi.fn(),
  findGrant: vi.fn(),
}));
vi.mock('@pagespace/lib/integrations/repositories/connection-repository', () => ({
  getConnectionById: vi.fn(),
}));

import { GET } from '../route';
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
