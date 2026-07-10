import { describe, it, expect, beforeEach, vi } from 'vitest';
// ============================================================================
// Contract tests for /api/drives/[driveId]/agents/[agentPageId] (PATCH/DELETE)
// ============================================================================

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));
vi.mock('@pagespace/lib/services/drive-member-service', () => ({
  checkDriveAccess: vi.fn(),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
}));
vi.mock('@pagespace/db/db', () => ({
  db: { select: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ _type: 'eq', a, b })),
  and: vi.fn((...args: unknown[]) => ({ _type: 'and', args })),
}));
vi.mock('@pagespace/db/schema/members', () => ({
  driveAgentMembers: {
    id: 'col_id', driveId: 'col_driveId', agentPageId: 'col_agentPageId',
    role: 'col_role', customRoleId: 'col_customRoleId', includeContext: 'col_includeContext',
  },
  driveRoles: { id: 'col_roles_id', driveId: 'col_roles_driveId' },
}));
vi.mock('@/lib/auth/request-auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
}));
vi.mock('@/lib/auth/auth-core', () => ({
  isAuthError: vi.fn(),
}));

import { PATCH } from '../route';
import { db } from '@pagespace/db/db';
import { checkDriveAccess } from '@pagespace/lib/services/drive-member-service';
import type { SessionAuthResult } from '@/lib/auth/auth-types';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';
import { isAuthError } from '@/lib/auth/auth-core';

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  role: 'user',
  adminRoleVersion: 0,
});

const MOCK_USER_ID = 'user_123';
const MOCK_DRIVE_ID = 'drive_abc';
const MOCK_AGENT_ID = 'agent_xyz';

const createContext = () => ({
  params: Promise.resolve({ driveId: MOCK_DRIVE_ID, agentPageId: MOCK_AGENT_ID }),
});

const patchRequest = (body: unknown) =>
  new Request('https://example.com/api/drives/d/agents/a', { method: 'PATCH', body: JSON.stringify(body) });

function stubExistingMembership() {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([{ id: 'member_1' }]) })) })),
  } as never);
}

function stubUpdate(returning: unknown[]) {
  const set = vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue(returning) })) }));
  vi.mocked(db.update).mockReturnValue({ set } as never);
  return set;
}

describe('PATCH /api/drives/[driveId]/agents/[agentPageId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(MOCK_USER_ID));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(checkDriveAccess).mockResolvedValue({
      drive: { id: MOCK_DRIVE_ID },
      isOwner: true,
      isAdmin: false,
    } as never);
  });

  it('updates includeContext and returns the updated member', async () => {
    stubExistingMembership();
    const set = stubUpdate([{ id: 'member_1', includeContext: true }]);

    const response = await PATCH(patchRequest({ includeContext: true }), createContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.member).toMatchObject({ includeContext: true });
    expect(set).toHaveBeenCalledWith({ includeContext: true });
  });

  it('403s when the caller is not a drive owner/admin', async () => {
    vi.mocked(checkDriveAccess).mockResolvedValue({
      drive: { id: MOCK_DRIVE_ID },
      isOwner: false,
      isAdmin: false,
    } as never);

    const response = await PATCH(patchRequest({ includeContext: true }), createContext());
    expect(response.status).toBe(403);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('400s when no updatable field is provided', async () => {
    // Returns before any DB call — no membership stub needed.
    const response = await PATCH(patchRequest({}), createContext());
    expect(response.status).toBe(400);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('404s when the membership does not exist', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([]) })) })),
    } as never);

    const response = await PATCH(patchRequest({ includeContext: true }), createContext());
    expect(response.status).toBe(404);
  });
});
