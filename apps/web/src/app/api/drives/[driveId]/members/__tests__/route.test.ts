import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET, POST } from '../route';
import type { WebAuthResult, AuthError } from '@/lib/auth';

// Mock dependencies
vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      driveMembers: {
        findFirst: vi.fn(),
      },
    },
    select: vi.fn(),
    insert: vi.fn(),
    execute: vi.fn(),
  },
  driveMembers: {},
  drives: {},
  users: {},
  userProfiles: {},
  driveRoles: {},
  eq: vi.fn((field: unknown, value: unknown) => ({ field, value, type: 'eq' })),
  and: vi.fn((...args: unknown[]) => ({ args, type: 'and' })),
  sql: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

// Helper to create mock WebAuthResult
const mockWebAuth = (userId: string, tokenVersion = 0): WebAuthResult => ({
  userId,
  tokenVersion,
  tokenType: 'jwt',
  source: 'cookie',
  role: 'user',
});

// Helper to create mock AuthError
const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

// Helper to create mock drive
const mockDrive = (overrides: {
  id: string;
  name: string;
  ownerId?: string;
}) => ({
  id: overrides.id,
  name: overrides.name,
  slug: overrides.name.toLowerCase().replace(/\s+/g, '-'),
  ownerId: overrides.ownerId ?? 'user_123',
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  isTrashed: false,
  trashedAt: null,
  drivePrompt: null,
});

// Helper to create mock member
const mockMember = (overrides: {
  id: string;
  userId: string;
  driveId: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
}) => ({
  id: overrides.id,
  userId: overrides.userId,
  driveId: overrides.driveId,
  role: overrides.role,
  customRoleId: null,
  invitedBy: null,
  invitedAt: new Date('2024-01-01'),
  acceptedAt: new Date('2024-01-01'),
  lastAccessedAt: null,
  user: {
    id: overrides.userId,
    email: `${overrides.userId}@example.com`,
    name: `User ${overrides.userId}`,
  },
  profile: {
    username: overrides.userId,
    displayName: `User ${overrides.userId}`,
    avatarUrl: null,
  },
  customRole: null,
});

// Create mock context
const createContext = (driveId: string) => ({
  params: Promise.resolve({ driveId }),
});

describe('GET /api/drives/[driveId]/members', () => {
  const mockUserId = 'user_123';
  const mockDriveId = 'drive_abc';

  const setupSelectMock = (driveResults: unknown[], memberResults: unknown[] = []) => {
    let callIndex = 0;
    vi.mocked(db.select).mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation(() => ({
          limit: vi.fn().mockImplementation(async () => {
            callIndex++;
            if (callIndex === 1) {
              return driveResults;
            }
            return memberResults;
          }),
        })),
        leftJoin: vi.fn().mockReturnThis(),
      })),
    } as unknown as ReturnType<typeof db.select>));
  };

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Default: drive exists and user is owner
    setupSelectMock([mockDrive({ id: mockDriveId, name: 'Test Drive', ownerId: mockUserId })]);

    // Default execute mock for permission counts
    vi.mocked(db.execute).mockResolvedValue({
      rows: [{ view_count: 0, edit_count: 0, share_count: 0 }],
    } as never);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`);
      const response = await GET(request, createContext(mockDriveId));

      expect(response.status).toBe(401);
    });
  });

  describe('authorization', () => {
    it('should return 404 when drive not found', async () => {
      setupSelectMock([]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Drive not found');
    });

    it('should return 403 when user is not a member', async () => {
      // Drive exists but owned by different user
      setupSelectMock([mockDrive({ id: mockDriveId, name: 'Other Drive', ownerId: 'other_user' })], []);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('You must be a drive member to view members');
    });
  });

  describe('happy path', () => {
    it('should return members list with currentUserRole=OWNER for drive owner', async () => {
      const members = [
        mockMember({ id: 'mem_1', userId: 'user_456', driveId: mockDriveId, role: 'ADMIN' }),
      ];

      // Track call count to return different results for different calls
      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          // First call: get drive
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([mockDrive({ id: mockDriveId, name: 'Test', ownerId: mockUserId })]),
              }),
            }),
          } as unknown as ReturnType<typeof db.select>;
        }
        // Second call: get members with leftJoins
        return {
          from: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              leftJoin: vi.fn().mockReturnValue({
                leftJoin: vi.fn().mockReturnValue({
                  where: vi.fn().mockResolvedValue(members),
                }),
              }),
            }),
          }),
        } as unknown as ReturnType<typeof db.select>;
      });

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.currentUserRole).toBe('OWNER');
    });

    it('should return members with permission counts', async () => {
      vi.mocked(db.execute).mockResolvedValue({
        rows: [{ view_count: 5, edit_count: 3, share_count: 1 }],
      } as never);

      // Setup simple select mock
      vi.mocked(db.select).mockImplementation(() => ({
        from: vi.fn().mockImplementation(() => ({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([mockDrive({ id: mockDriveId, name: 'Test', ownerId: mockUserId })]),
          }),
          leftJoin: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              leftJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue([
                  mockMember({ id: 'mem_1', userId: 'user_456', driveId: mockDriveId, role: 'MEMBER' }),
                ]),
              }),
            }),
          }),
        })),
      } as unknown as ReturnType<typeof db.select>));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.members[0].permissionCounts).toEqual({
        view: 5,
        edit: 3,
        share: 1,
      });
    });
  });

  describe('error handling', () => {
    it('should return 500 when database query fails', async () => {
      vi.mocked(db.select).mockImplementation(() => {
        throw new Error('Database connection lost');
      });

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch members');
      expect(loggers.api.error).toHaveBeenCalled();
    });
  });
});

describe('POST /api/drives/[driveId]/members', () => {
  const mockUserId = 'user_123';
  const mockDriveId = 'drive_abc';
  const mockInvitedUserId = 'user_456';

  const setupSelectMock = (driveResults: unknown[], existingMemberResults: unknown[] = []) => {
    let callIndex = 0;
    vi.mocked(db.select).mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation(() => ({
          limit: vi.fn().mockImplementation(async () => {
            callIndex++;
            if (callIndex === 1) {
              return driveResults;
            }
            return existingMemberResults;
          }),
        })),
      })),
    } as unknown as ReturnType<typeof db.select>));
  };

  const setupInsertMock = (returnedMember: unknown) => {
    const returningMock = vi.fn().mockResolvedValue([returnedMember]);
    const valuesMock = vi.fn().mockReturnValue({ returning: returningMock });
    vi.mocked(db.insert).mockReturnValue({ values: valuesMock } as unknown as ReturnType<typeof db.insert>);
    return { valuesMock, returningMock };
  };

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    setupSelectMock([mockDrive({ id: mockDriveId, name: 'Test Drive', ownerId: mockUserId })], []);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId: mockInvitedUserId }),
      });
      const response = await POST(request, createContext(mockDriveId));

      expect(response.status).toBe(401);
    });
  });

  describe('authorization', () => {
    it('should return 404 when drive not found', async () => {
      setupSelectMock([]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId: mockInvitedUserId }),
      });
      const response = await POST(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Drive not found');
    });

    it('should return 403 when user is not drive owner', async () => {
      setupSelectMock([mockDrive({ id: mockDriveId, name: 'Other Drive', ownerId: 'other_user' })]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId: mockInvitedUserId }),
      });
      const response = await POST(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Only drive owner can add members');
    });
  });

  describe('validation', () => {
    it('should reject when user is already a member', async () => {
      setupSelectMock(
        [mockDrive({ id: mockDriveId, name: 'Test', ownerId: mockUserId })],
        [mockMember({ id: 'mem_1', userId: mockInvitedUserId, driveId: mockDriveId, role: 'MEMBER' })]
      );

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId: mockInvitedUserId }),
      });
      const response = await POST(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('User is already a member');
    });
  });

  describe('happy path', () => {
    it('should add member with default MEMBER role', async () => {
      const newMember = {
        id: 'mem_new',
        userId: mockInvitedUserId,
        driveId: mockDriveId,
        role: 'MEMBER',
        invitedBy: mockUserId,
        acceptedAt: new Date(),
      };
      setupInsertMock(newMember);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId: mockInvitedUserId }),
      });
      const response = await POST(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.member).toMatchObject({
        userId: mockInvitedUserId,
        role: 'MEMBER',
      });
    });

    it('should add member with specified ADMIN role', async () => {
      const newMember = {
        id: 'mem_new',
        userId: mockInvitedUserId,
        driveId: mockDriveId,
        role: 'ADMIN',
        invitedBy: mockUserId,
        acceptedAt: new Date(),
      };
      setupInsertMock(newMember);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId: mockInvitedUserId, role: 'ADMIN' }),
      });
      const response = await POST(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.member.role).toBe('ADMIN');
    });

    it('should record who invited the member', async () => {
      const { valuesMock } = setupInsertMock({
        id: 'mem_new',
        userId: mockInvitedUserId,
        driveId: mockDriveId,
        role: 'MEMBER',
        invitedBy: mockUserId,
      });

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId: mockInvitedUserId }),
      });
      await POST(request, createContext(mockDriveId));

      expect(valuesMock).toHaveBeenCalledWith(
        expect.objectContaining({
          invitedBy: mockUserId,
        })
      );
    });
  });

  describe('error handling', () => {
    it('should return 500 when insert fails', async () => {
      const valuesMock = vi.fn().mockReturnValue({
        returning: vi.fn().mockRejectedValue(new Error('Insert failed')),
      });
      vi.mocked(db.insert).mockReturnValue({ values: valuesMock } as unknown as ReturnType<typeof db.insert>);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId: mockInvitedUserId }),
      });
      const response = await POST(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to add member');
      expect(loggers.api.error).toHaveBeenCalled();
    });
  });
});
