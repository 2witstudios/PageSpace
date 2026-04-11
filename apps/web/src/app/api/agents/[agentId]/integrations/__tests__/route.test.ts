/**
 * Security audit tests for /api/agents/[agentId]/integrations
 * Verifies securityAudit.logDataAccess is called for GET (read).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockListGrantsByAgent = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: unknown) => result && typeof result === 'object' && 'error' in result),
}));

vi.mock('@pagespace/db', () => ({ db: {} }));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    security: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
  securityAudit: {
    logDataAccess: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@pagespace/lib/permissions', () => ({
  canUserEditPage: vi.fn().mockResolvedValue(true),
}));

vi.mock('@pagespace/lib/services/drive-service', () => ({
  getDriveAccess: vi.fn(),
}));

vi.mock('@pagespace/lib/integrations', () => ({
  listGrantsByAgent: mockListGrantsByAgent,
  createGrant: vi.fn(),
  getConnectionById: vi.fn(),
  findGrant: vi.fn(),
}));

import { GET } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { securityAudit } from '@pagespace/lib/server';

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

    expect(securityAudit.logDataAccess).toHaveBeenCalledWith(
      mockUserId, 'read', 'agent_integrations', mockAgentId
    );
  });
});
