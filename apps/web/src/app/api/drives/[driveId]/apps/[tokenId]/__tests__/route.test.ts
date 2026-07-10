import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
vi.mock('@/lib/auth/request-auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
}));
vi.mock('@/lib/auth/auth-core', () => ({
  isAuthError: vi.fn(),
}));
vi.mock('@pagespace/lib/services/drive-member-service', () => ({
  checkDriveAccess: vi.fn(),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));
vi.mock('@pagespace/db/db', () => ({
  db: { select: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ _type: 'eq', a, b })),
  and: vi.fn((...args: unknown[]) => ({ _type: 'and', args })),
}));
vi.mock('@pagespace/db/schema/members', () => ({
  mcpTokenDrives: {
    id: 'col_mtd_id',
    tokenId: 'col_mtd_tokenId',
    driveId: 'col_mtd_driveId',
    role: 'col_mtd_role',
    customRoleId: 'col_mtd_customRoleId',
    $inferInsert: {},
  },
  driveRoles: {
    id: 'col_dr_id',
    driveId: 'col_dr_driveId',
  },
}));
vi.mock('@pagespace/db/schema/auth', () => ({
  mcpTokens: {
    id: 'col_mt_id',
    userId: 'col_mt_userId',
  },
}));
vi.mock('@pagespace/lib/permissions/permissions', () => ({
  isUserDriveMember: vi.fn().mockResolvedValue(true),
}));

import { PATCH, DELETE } from '../route';
import { checkDriveAccess } from '@pagespace/lib/services/drive-member-service';
import { isUserDriveMember } from '@pagespace/lib/permissions/permissions';
import { db } from '@pagespace/db/db';
import type { SessionAuthResult, AuthError } from '@/lib/auth/auth-types';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';
import { isAuthError } from '@/lib/auth/auth-core';

const MOCK_USER_ID = 'user_abc';
const MOCK_DRIVE_ID = 'drive_xyz';
const MOCK_TOKEN_ID = 'token_123';

const mockAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'sess-1',
  role: 'user',
  adminRoleVersion: 0,
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const createContext = (driveId: string, tokenId: string) => ({
  params: Promise.resolve({ driveId, tokenId }),
});

const createRequest = (method: string, body?: unknown) =>
  new Request('https://x.test/api', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });

// The existing-row lookup now JOINs mcpTokens (select().from().innerJoin().where().limit())
// to surface the token's ownerUserId; plain selects still go from().where().limit().
function setupSelectChain(rows: unknown[]) {
  const mockLimit = vi.fn().mockResolvedValue(rows);
  const mockWhere = vi.fn(() => ({ limit: mockLimit }));
  const mockInnerJoin = vi.fn(() => ({ where: mockWhere }));
  const mockFrom = vi.fn(() => ({ where: mockWhere, innerJoin: mockInnerJoin }));
  vi.mocked(db.select).mockReturnValue({ from: mockFrom } as never);
  return { mockFrom, mockInnerJoin, mockWhere, mockLimit };
}

// Per-call select chain: first call is the joined existing-row lookup, later
// calls (e.g. driveRoles validation) get `laterRows`.
function setupSequencedSelect(firstRows: unknown[], laterRows: unknown[] = []) {
  let selectCallCount = 0;
  vi.mocked(db.select).mockImplementation(() => {
    selectCallCount++;
    const rows = selectCallCount === 1 ? firstRows : laterRows;
    const mockLimit = vi.fn().mockResolvedValue(rows);
    const mockWhere = vi.fn(() => ({ limit: mockLimit }));
    const mockInnerJoin = vi.fn(() => ({ where: mockWhere }));
    const mockFrom = vi.fn(() => ({ where: mockWhere, innerJoin: mockInnerJoin }));
    return { from: mockFrom } as never;
  });
}

function setupUpdateChain(updated: unknown) {
  const mockReturning = vi.fn().mockResolvedValue([updated]);
  const mockWhere = vi.fn(() => ({ returning: mockReturning }));
  const mockSet = vi.fn(() => ({ where: mockWhere }));
  vi.mocked(db.update).mockReturnValue({ set: mockSet } as never);
  return { mockSet, mockWhere, mockReturning };
}

function setupDeleteChain() {
  const mockWhere = vi.fn().mockResolvedValue([]);
  vi.mocked(db.delete).mockReturnValue({ where: mockWhere } as never);
  return { mockWhere };
}

// ============================================================================
// PATCH
// ============================================================================

describe('PATCH /api/drives/[driveId]/apps/[tokenId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuth(MOCK_USER_ID));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(checkDriveAccess).mockResolvedValue({
      isOwner: true, isAdmin: true, isMember: true,
      drive: { id: MOCK_DRIVE_ID },
    } as never);
  });

  it('returns 401 when not authenticated', async () => {
    vi.mocked(isAuthError).mockReturnValue(true);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

    const res = await PATCH(createRequest('PATCH', { role: 'ADMIN' }), createContext(MOCK_DRIVE_ID, MOCK_TOKEN_ID));
    expect(res.status).toBe(401);
  });

  it('returns 404 when drive not found', async () => {
    vi.mocked(checkDriveAccess).mockResolvedValue({
      isOwner: false, isAdmin: false, isMember: false, drive: null,
    } as never);

    const res = await PATCH(createRequest('PATCH', { role: 'ADMIN' }), createContext(MOCK_DRIVE_ID, MOCK_TOKEN_ID));
    expect(res.status).toBe(404);
  });

  it('returns 403 when user is not owner or admin', async () => {
    vi.mocked(checkDriveAccess).mockResolvedValue({
      isOwner: false, isAdmin: false, isMember: true,
      drive: { id: MOCK_DRIVE_ID },
    } as never);

    const res = await PATCH(createRequest('PATCH', { role: 'ADMIN' }), createContext(MOCK_DRIVE_ID, MOCK_TOKEN_ID));
    expect(res.status).toBe(403);
  });

  it('returns 400 for invalid body', async () => {
    const res = await PATCH(createRequest('PATCH', { role: 'SUPERUSER' }), createContext(MOCK_DRIVE_ID, MOCK_TOKEN_ID));
    expect(res.status).toBe(400);
  });

  it('returns 400 when neither role nor customRoleId provided', async () => {
    const res = await PATCH(createRequest('PATCH', {}), createContext(MOCK_DRIVE_ID, MOCK_TOKEN_ID));
    expect(res.status).toBe(400);
  });

  it('returns 404 when app member not found', async () => {
    setupSelectChain([]);

    const res = await PATCH(createRequest('PATCH', { role: 'ADMIN' }), createContext(MOCK_DRIVE_ID, MOCK_TOKEN_ID));
    expect(res.status).toBe(404);
  });

  it('returns 404 when customRoleId does not belong to drive', async () => {
    setupSequencedSelect([{ id: 'mtd-1', ownerUserId: 'owner-1' }], []);

    const res = await PATCH(createRequest('PATCH', { customRoleId: 'role-other-drive' }), createContext(MOCK_DRIVE_ID, MOCK_TOKEN_ID));
    expect(res.status).toBe(404);
  });

  it('updates role successfully', async () => {
    setupSequencedSelect([{ id: 'mtd-1', ownerUserId: 'owner-1' }], []);
    setupUpdateChain({ id: 'mtd-1', tokenId: MOCK_TOKEN_ID, role: 'ADMIN' });

    const res = await PATCH(createRequest('PATCH', { role: 'ADMIN' }), createContext(MOCK_DRIVE_ID, MOCK_TOKEN_ID));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
  });

  it('clears role to inherit (null) when the token owner is a drive member', async () => {
    setupSequencedSelect([{ id: 'mtd-1', ownerUserId: 'owner-1' }], []);
    vi.mocked(isUserDriveMember).mockResolvedValue(true);
    const { mockSet } = setupUpdateChain({ id: 'mtd-1', tokenId: MOCK_TOKEN_ID, role: null });

    const res = await PATCH(createRequest('PATCH', { role: null }), createContext(MOCK_DRIVE_ID, MOCK_TOKEN_ID));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(isUserDriveMember).toHaveBeenCalledWith('owner-1', MOCK_DRIVE_ID);
    expect(mockSet).toHaveBeenCalledWith({ role: null });
  });

  it('returns 400 when clearing to inherit but the token owner is not a drive member', async () => {
    setupSequencedSelect([{ id: 'mtd-1', ownerUserId: 'foreign-owner' }], []);
    vi.mocked(isUserDriveMember).mockResolvedValue(false);

    const res = await PATCH(createRequest('PATCH', { role: null }), createContext(MOCK_DRIVE_ID, MOCK_TOKEN_ID));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain('inherit');
    expect(db.update).not.toHaveBeenCalled();
  });

  it('returns 500 on unexpected error', async () => {
    vi.mocked(checkDriveAccess).mockRejectedValue(new Error('DB exploded'));

    const res = await PATCH(createRequest('PATCH', { role: 'MEMBER' }), createContext(MOCK_DRIVE_ID, MOCK_TOKEN_ID));
    expect(res.status).toBe(500);
  });
});

// ============================================================================
// DELETE
// ============================================================================

describe('DELETE /api/drives/[driveId]/apps/[tokenId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuth(MOCK_USER_ID));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(checkDriveAccess).mockResolvedValue({
      isOwner: true, isAdmin: true, isMember: true,
      drive: { id: MOCK_DRIVE_ID },
    } as never);
  });

  it('returns 401 when not authenticated', async () => {
    vi.mocked(isAuthError).mockReturnValue(true);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

    const res = await DELETE(createRequest('DELETE'), createContext(MOCK_DRIVE_ID, MOCK_TOKEN_ID));
    expect(res.status).toBe(401);
  });

  it('returns 404 when drive not found', async () => {
    vi.mocked(checkDriveAccess).mockResolvedValue({
      isOwner: false, isAdmin: false, isMember: false, drive: null,
    } as never);

    const res = await DELETE(createRequest('DELETE'), createContext(MOCK_DRIVE_ID, MOCK_TOKEN_ID));
    expect(res.status).toBe(404);
  });

  it('returns 403 when user is not owner or admin', async () => {
    vi.mocked(checkDriveAccess).mockResolvedValue({
      isOwner: false, isAdmin: false, isMember: true,
      drive: { id: MOCK_DRIVE_ID },
    } as never);

    const res = await DELETE(createRequest('DELETE'), createContext(MOCK_DRIVE_ID, MOCK_TOKEN_ID));
    expect(res.status).toBe(403);
  });

  it('returns 404 when app member not found', async () => {
    setupSelectChain([]);

    const res = await DELETE(createRequest('DELETE'), createContext(MOCK_DRIVE_ID, MOCK_TOKEN_ID));
    expect(res.status).toBe(404);
  });

  it('removes app member successfully', async () => {
    setupSelectChain([{ id: 'mtd-1' }]);
    setupDeleteChain();

    const res = await DELETE(createRequest('DELETE'), createContext(MOCK_DRIVE_ID, MOCK_TOKEN_ID));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
  });

  it('returns 500 on unexpected error', async () => {
    vi.mocked(checkDriveAccess).mockRejectedValue(new Error('DB exploded'));

    const res = await DELETE(createRequest('DELETE'), createContext(MOCK_DRIVE_ID, MOCK_TOKEN_ID));
    expect(res.status).toBe(500);
  });
});
