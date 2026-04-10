/**
 * Security audit tests for /api/agents/[agentId]/integrations/[grantId]
 * Verifies securityAudit.logDataAccess is called for DELETE.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockGetGrantById = vi.hoisted(() => vi.fn());
const mockDeleteGrant = vi.hoisted(() => vi.fn());

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

vi.mock('@pagespace/lib/integrations', () => ({
  getGrantById: mockGetGrantById,
  updateGrant: vi.fn(),
  deleteGrant: mockDeleteGrant,
}));

import { DELETE } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { securityAudit } from '@pagespace/lib/server';

const mockUserId = 'user_123';
const mockAgentId = 'agent-1';
const mockGrantId = 'grant-1';

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

describe('DELETE /api/agents/[agentId]/integrations/[grantId] audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
    mockGetGrantById.mockResolvedValue({ id: mockGrantId, agentId: mockAgentId });
    mockDeleteGrant.mockResolvedValue(undefined);
  });

  it('logs delete audit event on successful grant deletion', async () => {
    await DELETE(
      new Request('http://localhost/api/agents/agent-1/integrations/grant-1', { method: 'DELETE' }),
      { params: Promise.resolve({ agentId: mockAgentId, grantId: mockGrantId }) }
    );

    expect(securityAudit.logDataAccess).toHaveBeenCalledWith(
      mockUserId, 'delete', 'agent_grant', mockGrantId
    );
  });
});
