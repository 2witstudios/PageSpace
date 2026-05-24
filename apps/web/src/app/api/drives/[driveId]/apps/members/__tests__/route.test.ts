import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));
vi.mock('@pagespace/lib/services/drive-member-service', () => ({
  checkDriveAccess: vi.fn(),
}));
vi.mock('@pagespace/db/db', () => ({
  db: { select: vi.fn() },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ _type: 'eq', a, b })),
}));
vi.mock('@pagespace/db/schema/members', () => ({
  mcpTokenDrives: {
    id: 'col_mtd_id',
    tokenId: 'col_mtd_tokenId',
    driveId: 'col_mtd_driveId',
    role: 'col_mtd_role',
    createdAt: 'col_mtd_createdAt',
    customRoleId: 'col_mtd_customRoleId',
  },
  driveRoles: {
    id: 'col_dr_id',
    name: 'col_dr_name',
    color: 'col_dr_color',
  },
}));
vi.mock('@pagespace/db/schema/auth', () => ({
  mcpTokens: { id: 'col_mct_id', name: 'col_mct_name' },
}));

import { GET } from '../route';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { checkDriveAccess } from '@pagespace/lib/services/drive-member-service';
import { db } from '@pagespace/db/db';

const MOCK_USER_ID = 'user_abc';
const MOCK_DRIVE_ID = 'drive_xyz';

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

const createContext = (driveId: string) => ({
  params: Promise.resolve({ driveId }),
});

function setupDbChain(rows: unknown[]) {
  const mockWhere = vi.fn().mockResolvedValue(rows);
  const mockLeftJoin2 = vi.fn(() => ({ where: mockWhere }));
  const mockLeftJoin1 = vi.fn(() => ({ leftJoin: mockLeftJoin2 }));
  const mockFrom = vi.fn(() => ({ leftJoin: mockLeftJoin1 }));
  vi.mocked(db.select).mockReturnValue({ from: mockFrom } as never);
  return { mockFrom, mockLeftJoin1, mockLeftJoin2, mockWhere };
}

describe('GET /api/drives/[driveId]/apps/members', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuth(MOCK_USER_ID));
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  it('returns 401 when not authenticated', async () => {
    vi.mocked(isAuthError).mockReturnValue(true);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

    const res = await GET(new Request('https://x.test/api'), createContext(MOCK_DRIVE_ID));
    expect(res.status).toBe(401);
  });

  it('returns 404 when drive not found', async () => {
    vi.mocked(checkDriveAccess).mockResolvedValue({
      isOwner: false, isAdmin: false, isMember: false, drive: null,
    } as never);

    const res = await GET(new Request('https://x.test/api'), createContext(MOCK_DRIVE_ID));
    expect(res.status).toBe(404);
  });

  it('returns 403 when user is not a member', async () => {
    vi.mocked(checkDriveAccess).mockResolvedValue({
      isOwner: false, isAdmin: false, isMember: false,
      drive: { id: MOCK_DRIVE_ID },
    } as never);

    const res = await GET(new Request('https://x.test/api'), createContext(MOCK_DRIVE_ID));
    expect(res.status).toBe(403);
  });

  describe('successful responses', () => {
    beforeEach(() => {
      vi.mocked(checkDriveAccess).mockResolvedValue({
        isOwner: true, isAdmin: true, isMember: true,
        drive: { id: MOCK_DRIVE_ID },
      } as never);
    });

    it('returns empty app members list when no apps exist', async () => {
      setupDbChain([]);

      const res = await GET(new Request('https://x.test/api'), createContext(MOCK_DRIVE_ID));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.appMembers).toEqual([]);
      expect(body.currentUserRole).toBe('OWNER');
    });

    it('returns app members with correct shape', async () => {
      const createdAt = new Date('2026-05-01T00:00:00Z');
      setupDbChain([
        {
          id: 'mtd-1',
          tokenId: 'token-1',
          role: 'MEMBER',
          createdAt,
          customRoleId: null,
          name: 'My MCP Key',
          customRoleName: null,
          customRoleColor: null,
        },
      ]);

      const res = await GET(new Request('https://x.test/api'), createContext(MOCK_DRIVE_ID));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.appMembers).toHaveLength(1);
      expect(body.appMembers[0]).toMatchObject({
        id: 'mtd-1',
        tokenId: 'token-1',
        role: 'MEMBER',
        name: 'My MCP Key',
        customRole: null,
      });
    });

    it('includes custom role when present', async () => {
      setupDbChain([
        {
          id: 'mtd-2',
          tokenId: 'token-2',
          role: 'MEMBER',
          createdAt: new Date(),
          customRoleId: 'role-1',
          name: 'Another Key',
          customRoleName: 'Viewer',
          customRoleColor: 'blue',
        },
      ]);

      const res = await GET(new Request('https://x.test/api'), createContext(MOCK_DRIVE_ID));
      const body = await res.json();

      expect(body.appMembers[0].customRole).toEqual({
        id: 'role-1',
        name: 'Viewer',
        color: 'blue',
      });
    });

    it('falls back to customRoleId as name when customRoleName is null', async () => {
      setupDbChain([
        {
          id: 'mtd-3',
          tokenId: 'token-3',
          role: 'MEMBER',
          createdAt: new Date(),
          customRoleId: 'role-orphan',
          name: 'Key',
          customRoleName: null,
          customRoleColor: null,
        },
      ]);

      const res = await GET(new Request('https://x.test/api'), createContext(MOCK_DRIVE_ID));
      const body = await res.json();

      expect(body.appMembers[0].customRole).toEqual({
        id: 'role-orphan',
        name: 'role-orphan',
        color: null,
      });
    });

    it('returns ADMIN currentUserRole for admin (non-owner) members', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue({
        isOwner: false, isAdmin: true, isMember: true,
        drive: { id: MOCK_DRIVE_ID },
      } as never);
      setupDbChain([]);

      const res = await GET(new Request('https://x.test/api'), createContext(MOCK_DRIVE_ID));
      const body = await res.json();

      expect(body.currentUserRole).toBe('ADMIN');
    });

    it('returns MEMBER currentUserRole for plain members', async () => {
      vi.mocked(checkDriveAccess).mockResolvedValue({
        isOwner: false, isAdmin: false, isMember: true,
        drive: { id: MOCK_DRIVE_ID },
      } as never);
      setupDbChain([]);

      const res = await GET(new Request('https://x.test/api'), createContext(MOCK_DRIVE_ID));
      const body = await res.json();

      expect(body.currentUserRole).toBe('MEMBER');
    });
  });

  it('returns 500 on unexpected error', async () => {
    vi.mocked(checkDriveAccess).mockRejectedValue(new Error('DB down'));

    const res = await GET(new Request('https://x.test/api'), createContext(MOCK_DRIVE_ID));
    expect(res.status).toBe(500);
  });
});
