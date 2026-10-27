/**
 * GET /api/account/oauth-grants (Phase 8 task k58h61obmc91sn1ndngrsev5):
 * lists the current user's active OAuth grants with human-readable scope
 * descriptions, resolving drive/custom-role names server-side.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@/lib/repositories/oauth-repository', () => ({
  listActiveOAuthGrantsForUser: vi.fn(),
}));

vi.mock('@/lib/repositories/session-repository', () => ({
  sessionRepository: {
    findDrivesByIds: vi.fn(),
  },
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      driveRoles: {
        findFirst: vi.fn(),
      },
    },
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ _eq: [a, b] })),
}));
vi.mock('@pagespace/db/schema/members', () => ({
  driveRoles: { id: 'drive_roles.id' },
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { auth: { error: vi.fn() } },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));

import { GET } from '../route';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { listActiveOAuthGrantsForUser } from '@/lib/repositories/oauth-repository';
import { sessionRepository } from '@/lib/repositories/session-repository';
import { db } from '@pagespace/db/db';

const USER_ID = 'user-a';
const NOW = new Date('2026-01-01T00:00:00Z');

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost/api/account/oauth-grants', {
    headers: { Cookie: 'ps_session=valid-token' },
  });
}

describe('GET /api/account/oauth-grants', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
      userId: USER_ID,
      role: 'user',
      tokenVersion: 0,
      tokenType: 'session',
      sessionId: 'session-1',
    } as never);
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(sessionRepository.findDrivesByIds).mockResolvedValue([]);
    vi.mocked(db.query.driveRoles.findFirst).mockResolvedValue(undefined as never);
  });

  it('returns the auth error response when unauthenticated', async () => {
    const mockErrorResponse = Response.json({ error: 'Unauthorized' }, { status: 401 });
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ error: mockErrorResponse } as never);
    vi.mocked(isAuthError).mockReturnValue(true);

    const response = await GET(makeRequest());

    expect(response.status).toBe(401);
  });

  it('returns an empty list when the user has no active grants', async () => {
    vi.mocked(listActiveOAuthGrantsForUser).mockResolvedValue([]);

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual([]);
  });

  it('maps grants to client name, resolved scope descriptions, and created date', async () => {
    vi.mocked(listActiveOAuthGrantsForUser).mockResolvedValue([
      { id: 'grant-1', clientName: 'pagespace CLI', scopes: ['account', 'offline_access'], createdAt: NOW },
    ]);

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual([
      {
        id: 'grant-1',
        clientName: 'pagespace CLI',
        scopeDescriptions: expect.arrayContaining([expect.stringMatching(/full access/i), expect.stringMatching(/revoke/i)]),
        createdAt: NOW.toISOString(),
      },
    ]);
  });

  it('resolves drive and custom-role names for drive-scoped grants', async () => {
    vi.mocked(listActiveOAuthGrantsForUser).mockResolvedValue([
      { id: 'grant-1', clientName: 'Some App', scopes: ['drive:drv123:role:rol456'], createdAt: NOW },
    ]);
    vi.mocked(sessionRepository.findDrivesByIds).mockResolvedValue([{ id: 'drv123', name: 'Marketing' }]);
    vi.mocked(db.query.driveRoles.findFirst).mockResolvedValue({
      id: 'rol456',
      name: 'Editor',
      description: 'Can edit pages',
    } as never);

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(sessionRepository.findDrivesByIds).toHaveBeenCalledWith(['drv123']);
    expect(body[0].scopeDescriptions[0]).toMatch(/Marketing/);
    expect(body[0].scopeDescriptions[0]).toMatch(/Editor/);
  });

  it('returns 500 when the repository throws', async () => {
    vi.mocked(listActiveOAuthGrantsForUser).mockRejectedValue(new Error('DB error'));

    const response = await GET(makeRequest());
    expect(response.status).toBe(500);
  });
});
