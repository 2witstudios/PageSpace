/**
 * Security audit tests for /api/activities/actors
 * Verifies auditRequest is called for GET (read).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: unknown) => result && typeof result === 'object' && 'error' in result),
  checkMCPDriveScope: vi.fn().mockReturnValue(null),
  getAllowedDriveIds: vi.fn().mockReturnValue(null),
}));

const mockSelectDistinct = vi.hoisted(() => vi.fn());
vi.mock('@pagespace/db/db', () => ({
  db: {
    selectDistinct: mockSelectDistinct,
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          groupBy: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
    query: {
      users: { findMany: vi.fn().mockResolvedValue([]) },
    },
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  sql: vi.fn(() => ({ as: vi.fn(() => 'aliased') })),
  inArray: vi.fn(),
}));
vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'id', accountType: 'users.accountType', image: 'users.image' },
}));
vi.mock('@pagespace/db/schema/monitoring', () => ({
  activityLogs: { userId: 'userId' },
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
  explainSignInRefusal: vi.fn().mockResolvedValue(null),
    isUserDriveMember: vi.fn().mockResolvedValue(true),
}));

const actorRows = (rows: unknown[]) => {
  const chain = {
    from: vi.fn(() => chain),
    leftJoin: vi.fn(() => chain),
    where: vi.fn(() => chain),
    orderBy: vi.fn().mockResolvedValue(rows),
  };
  mockSelectDistinct.mockReturnValue(chain);
};

import { GET } from '../route';
import { authenticateRequestWithOptions, getAllowedDriveIds } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

const mockUserId = 'user_123';

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

describe('GET /api/activities/actors audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
  });

  it('logs read audit event on successful actors retrieval', async () => {
    await GET(new Request('http://localhost/api/activities/actors?context=user'));

    expect(auditRequest).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ eventType: 'data.read', userId: mockUserId, resourceType: 'activity_actors', resourceId: 'self' })
    );
  });
});

describe('GET /api/activities/actors agent marker (Agent Signup Phase 2c)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
    vi.mocked(getAllowedDriveIds).mockReturnValue([]);
  });

  it('selects users.accountType so the actor filter can mark agents', async () => {
    actorRows([]);
    await GET(new Request('http://localhost/api/activities/actors?context=user'));
    const selection = mockSelectDistinct.mock.calls[0][0] as Record<string, unknown>;
    expect(selection.accountType).toBe('users.accountType');
  });

  it('returns accountType per actor; an erased actor (no user row) has none', async () => {
    actorRows([
      { id: 'agent-1', name: 'Helper', email: 'a@agents.invalid', image: null, sortKey: 'Helper', accountType: 'agent' },
      { id: null, name: 'Gone', email: 'gone@example.com', image: null, sortKey: 'Gone', accountType: null },
    ]);
    const res = await GET(new Request('http://localhost/api/activities/actors?context=user'));
    const body = await res.json();
    expect(body.actors[0]).toMatchObject({ name: 'Helper', accountType: 'agent' });
    expect(body.actors[1]).toMatchObject({ name: 'Gone', accountType: null });
  });
});
