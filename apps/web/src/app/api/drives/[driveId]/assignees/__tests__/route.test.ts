import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/drives/[driveId]/assignees
// ============================================================================

vi.mock('@pagespace/lib/server', () => ({
  getUserDriveAccess: vi.fn(),
  canUserViewPage: vi.fn(),
}));

vi.mock('@pagespace/db', () => {
  return {
    db: {
      select: vi.fn(),
      query: {
        drives: {
          findFirst: vi.fn(),
        },
      },
    },
    pages: {
      id: 'col_pages_id',
      title: 'col_pages_title',
      driveId: 'col_pages_driveId',
      type: 'col_pages_type',
      isTrashed: 'col_pages_isTrashed',
      position: 'col_pages_position',
    },
    drives: { id: 'col_drives_id' },
    driveMembers: {
      userId: 'col_dm_userId',
      role: 'col_dm_role',
      driveId: 'col_dm_driveId',
    },
    userProfiles: {
      displayName: 'col_up_displayName',
      avatarUrl: 'col_up_avatarUrl',
      userId: 'col_up_userId',
    },
    users: {
      id: 'col_users_id',
      email: 'col_users_email',
      name: 'col_users_name',
      image: 'col_users_image',
    },
    eq: vi.fn((a: unknown, b: unknown) => ({ _type: 'eq', a, b })),
    and: vi.fn((...args: unknown[]) => ({ _type: 'and', args })),
  };
});

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

import { GET } from '../route';
import { getUserDriveAccess, canUserViewPage } from '@pagespace/lib/server';
import { db } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

// ============================================================================
// Test Helpers
// ============================================================================

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  role: 'user',
  adminRoleVersion: 0,
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const createContext = (driveId: string) => ({
  params: Promise.resolve({ driveId }),
});

const MOCK_USER_ID = 'user_123';
const MOCK_DRIVE_ID = 'drive_abc';
const MOCK_OWNER_ID = 'owner_456';

// ============================================================================
// GET /api/drives/[driveId]/assignees
// ============================================================================

describe('GET /api/drives/[driveId]/assignees', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(MOCK_USER_ID));
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  describe('authentication', () => {
    it('should return auth error when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/drives/d/assignees');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));

      expect(response.status).toBe(401);
    });
  });

  describe('drive lookup', () => {
    it('should return 404 when drive not found', async () => {
      vi.mocked(db.query.drives.findFirst).mockResolvedValue(undefined);

      const request = new Request('https://example.com/api/drives/d/assignees');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Drive not found');
    });
  });

  describe('authorization', () => {
    it('should return 403 when user has no drive access', async () => {
      vi.mocked(db.query.drives.findFirst).mockResolvedValue({ ownerId: MOCK_OWNER_ID } as never);
      vi.mocked(getUserDriveAccess).mockResolvedValue(false);

      const request = new Request('https://example.com/api/drives/d/assignees');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toContain("don't have access");
    });
  });

  describe('response contract', () => {
    beforeEach(() => {
      vi.mocked(db.query.drives.findFirst).mockResolvedValue({ ownerId: MOCK_OWNER_ID } as never);
      vi.mocked(getUserDriveAccess).mockResolvedValue(true);
    });

    it('should return members and agents as assignees', async () => {
      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          // Members query
          const mockLeftJoin2 = vi.fn(() => ({
            where: vi.fn().mockResolvedValue([
              {
                userId: 'member-1',
                role: 'ADMIN',
                user: { id: 'member-1', email: 'admin@test.com', name: 'Admin User', image: '/admin.png' },
                profile: { displayName: 'Admin', avatarUrl: '/avatar-admin.png' },
              },
            ]),
          }));
          const mockLeftJoin1 = vi.fn(() => ({ leftJoin: mockLeftJoin2 }));
          return {
            from: vi.fn(() => ({ leftJoin: mockLeftJoin1 })),
          } as never;
        }
        if (selectCallCount === 2) {
          // Agents query
          return {
            from: vi.fn(() => ({
              where: vi.fn(() => ({
                orderBy: vi.fn().mockResolvedValue([
                  { id: 'agent-1', title: 'Research Agent' },
                ]),
              })),
            })),
          } as never;
        }
        // Owner query (owner not in members)
        const mockOwnerLeftJoin = vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([
              {
                user: { id: MOCK_OWNER_ID, email: 'owner@test.com', name: 'Owner', image: '/owner.png' },
                profile: { displayName: 'Drive Owner', avatarUrl: '/avatar-owner.png' },
              },
            ]),
          })),
        }));
        return {
          from: vi.fn(() => ({ leftJoin: mockOwnerLeftJoin })),
        } as never;
      });

      vi.mocked(canUserViewPage).mockResolvedValue(true);

      const request = new Request('https://example.com/api/drives/d/assignees');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.assignees).toHaveLength(3); // owner + member + agent
      expect(body.counts.members).toBe(2); // owner + member
      expect(body.counts.agents).toBe(1);
      expect(body.counts.total).toBe(3);

      // Owner should be first (unshift)
      expect(body.assignees[0]).toMatchObject({
        id: MOCK_OWNER_ID,
        type: 'user',
        name: 'Drive Owner',
        image: '/avatar-owner.png',
      });

      // Member
      expect(body.assignees[1]).toMatchObject({
        id: 'member-1',
        type: 'user',
        name: 'Admin',
        image: '/avatar-admin.png',
      });

      // Agent
      expect(body.assignees[2]).toMatchObject({
        id: 'agent-1',
        type: 'agent',
        name: 'Research Agent',
        image: null,
        agentTitle: 'Research Agent',
      });
    });

    it('should not add owner twice when owner is in members list', async () => {
      let selectCallCount = 0;
      vi.mocked(db.query.drives.findFirst).mockResolvedValue({ ownerId: 'member-owner' } as never);
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          // Members query - includes the owner
          const mockLeftJoin2 = vi.fn(() => ({
            where: vi.fn().mockResolvedValue([
              {
                userId: 'member-owner',
                role: 'OWNER',
                user: { id: 'member-owner', email: 'owner@test.com', name: 'Owner', image: null },
                profile: null,
              },
            ]),
          }));
          const mockLeftJoin1 = vi.fn(() => ({ leftJoin: mockLeftJoin2 }));
          return {
            from: vi.fn(() => ({ leftJoin: mockLeftJoin1 })),
          } as never;
        }
        // Agents query
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn().mockResolvedValue([]),
            })),
          })),
        } as never;
      });

      const request = new Request('https://example.com/api/drives/d/assignees');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      // Owner is already in members, should NOT be added again
      expect(body.assignees).toHaveLength(1);
      expect(body.assignees[0].id).toBe('member-owner');
    });

    it('should handle members with null user (filter them out)', async () => {
      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          const mockLeftJoin2 = vi.fn(() => ({
            where: vi.fn().mockResolvedValue([
              {
                userId: 'ghost-user',
                role: 'MEMBER',
                user: null, // user was deleted
                profile: null,
              },
              {
                userId: 'valid-user',
                role: 'MEMBER',
                user: { id: 'valid-user', email: 'valid@test.com', name: 'Valid', image: null },
                profile: null,
              },
            ]),
          }));
          const mockLeftJoin1 = vi.fn(() => ({ leftJoin: mockLeftJoin2 }));
          return {
            from: vi.fn(() => ({ leftJoin: mockLeftJoin1 })),
          } as never;
        }
        if (selectCallCount === 2) {
          return {
            from: vi.fn(() => ({
              where: vi.fn(() => ({
                orderBy: vi.fn().mockResolvedValue([]),
              })),
            })),
          } as never;
        }
        // Owner query
        const mockOwnerLeftJoin = vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([
              {
                user: { id: MOCK_OWNER_ID, email: 'owner@test.com', name: 'Owner', image: null },
                profile: null,
              },
            ]),
          })),
        }));
        return {
          from: vi.fn(() => ({ leftJoin: mockOwnerLeftJoin })),
        } as never;
      });

      const request = new Request('https://example.com/api/drives/d/assignees');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      // Only valid-user should appear as member + owner added separately
      const userAssignees = body.assignees.filter((a: { type: string }) => a.type === 'user');
      expect(userAssignees).toHaveLength(2); // owner + valid-user
    });

    it('should use displayName > name > email for member name', async () => {
      let selectCallCount = 0;
      vi.mocked(db.query.drives.findFirst).mockResolvedValue({ ownerId: 'member-1' } as never);
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          const mockLeftJoin2 = vi.fn(() => ({
            where: vi.fn().mockResolvedValue([
              {
                userId: 'member-1',
                role: 'MEMBER',
                user: { id: 'member-1', email: 'user@test.com', name: 'User Name', image: null },
                profile: null,  // No profile - should fall back to user.name
              },
            ]),
          }));
          const mockLeftJoin1 = vi.fn(() => ({ leftJoin: mockLeftJoin2 }));
          return { from: vi.fn(() => ({ leftJoin: mockLeftJoin1 })) } as never;
        }
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn().mockResolvedValue([]),
            })),
          })),
        } as never;
      });

      const request = new Request('https://example.com/api/drives/d/assignees');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      expect(body.assignees[0].name).toBe('User Name');
    });

    it('should fall back to email when name is null', async () => {
      let selectCallCount = 0;
      vi.mocked(db.query.drives.findFirst).mockResolvedValue({ ownerId: 'member-1' } as never);
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          const mockLeftJoin2 = vi.fn(() => ({
            where: vi.fn().mockResolvedValue([
              {
                userId: 'member-1',
                role: 'MEMBER',
                user: { id: 'member-1', email: 'noname@test.com', name: null, image: null },
                profile: null,
              },
            ]),
          }));
          const mockLeftJoin1 = vi.fn(() => ({ leftJoin: mockLeftJoin2 }));
          return { from: vi.fn(() => ({ leftJoin: mockLeftJoin1 })) } as never;
        }
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn().mockResolvedValue([]),
            })),
          })),
        } as never;
      });

      const request = new Request('https://example.com/api/drives/d/assignees');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      expect(body.assignees[0].name).toBe('noname@test.com');
    });

    it('should filter agents by view permission', async () => {
      let selectCallCount = 0;
      vi.mocked(db.query.drives.findFirst).mockResolvedValue({ ownerId: 'member-1' } as never);
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          const mockLeftJoin2 = vi.fn(() => ({
            where: vi.fn().mockResolvedValue([
              {
                userId: 'member-1',
                role: 'OWNER',
                user: { id: 'member-1', email: 'x@test.com', name: 'X', image: null },
                profile: null,
              },
            ]),
          }));
          const mockLeftJoin1 = vi.fn(() => ({ leftJoin: mockLeftJoin2 }));
          return { from: vi.fn(() => ({ leftJoin: mockLeftJoin1 })) } as never;
        }
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn().mockResolvedValue([
                { id: 'agent-a', title: 'Agent A' },
                { id: 'agent-b', title: 'Agent B' },
              ]),
            })),
          })),
        } as never;
      });

      vi.mocked(canUserViewPage).mockImplementation(async (_userId: string, pageId: string) => {
        return pageId === 'agent-a';
      });

      const request = new Request('https://example.com/api/drives/d/assignees');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      const agents = body.assignees.filter((a: { type: string }) => a.type === 'agent');
      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe('Agent A');
    });

    it('should use "Unnamed Agent" for agents with null title', async () => {
      let selectCallCount = 0;
      vi.mocked(db.query.drives.findFirst).mockResolvedValue({ ownerId: 'member-1' } as never);
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          const mockLeftJoin2 = vi.fn(() => ({
            where: vi.fn().mockResolvedValue([
              {
                userId: 'member-1',
                role: 'OWNER',
                user: { id: 'member-1', email: 'x@test.com', name: 'X', image: null },
                profile: null,
              },
            ]),
          }));
          const mockLeftJoin1 = vi.fn(() => ({ leftJoin: mockLeftJoin2 }));
          return { from: vi.fn(() => ({ leftJoin: mockLeftJoin1 })) } as never;
        }
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn().mockResolvedValue([
                { id: 'agent-no-title', title: null },
              ]),
            })),
          })),
        } as never;
      });
      vi.mocked(canUserViewPage).mockResolvedValue(true);

      const request = new Request('https://example.com/api/drives/d/assignees');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      const agents = body.assignees.filter((a: { type: string }) => a.type === 'agent');
      expect(agents[0].name).toBe('Unnamed Agent');
      expect(agents[0].agentTitle).toBeUndefined();
    });

    it('should handle owner not found in database', async () => {
      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          // Members - empty
          const mockLeftJoin2 = vi.fn(() => ({
            where: vi.fn().mockResolvedValue([]),
          }));
          const mockLeftJoin1 = vi.fn(() => ({ leftJoin: mockLeftJoin2 }));
          return { from: vi.fn(() => ({ leftJoin: mockLeftJoin1 })) } as never;
        }
        if (selectCallCount === 2) {
          // Agents
          return {
            from: vi.fn(() => ({
              where: vi.fn(() => ({
                orderBy: vi.fn().mockResolvedValue([]),
              })),
            })),
          } as never;
        }
        // Owner lookup returns empty
        const mockOwnerLeftJoin = vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([]),
          })),
        }));
        return { from: vi.fn(() => ({ leftJoin: mockOwnerLeftJoin })) } as never;
      });

      const request = new Request('https://example.com/api/drives/d/assignees');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.assignees).toHaveLength(0);
    });

    it('should handle owner with null user data', async () => {
      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          const mockLeftJoin2 = vi.fn(() => ({
            where: vi.fn().mockResolvedValue([]),
          }));
          const mockLeftJoin1 = vi.fn(() => ({ leftJoin: mockLeftJoin2 }));
          return { from: vi.fn(() => ({ leftJoin: mockLeftJoin1 })) } as never;
        }
        if (selectCallCount === 2) {
          return {
            from: vi.fn(() => ({
              where: vi.fn(() => ({
                orderBy: vi.fn().mockResolvedValue([]),
              })),
            })),
          } as never;
        }
        // Owner query returns row with null user
        const mockOwnerLeftJoin = vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([
              { user: null, profile: null },
            ]),
          })),
        }));
        return { from: vi.fn(() => ({ leftJoin: mockOwnerLeftJoin })) } as never;
      });

      const request = new Request('https://example.com/api/drives/d/assignees');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      // Owner with null user should not be added
      expect(body.assignees).toHaveLength(0);
    });

    it('should use owner profile for name/image when available', async () => {
      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          const mockLeftJoin2 = vi.fn(() => ({
            where: vi.fn().mockResolvedValue([]),
          }));
          const mockLeftJoin1 = vi.fn(() => ({ leftJoin: mockLeftJoin2 }));
          return { from: vi.fn(() => ({ leftJoin: mockLeftJoin1 })) } as never;
        }
        if (selectCallCount === 2) {
          return {
            from: vi.fn(() => ({
              where: vi.fn(() => ({
                orderBy: vi.fn().mockResolvedValue([]),
              })),
            })),
          } as never;
        }
        const mockOwnerLeftJoin = vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([
              {
                user: { id: MOCK_OWNER_ID, email: 'owner@test.com', name: 'Fallback', image: '/fallback.png' },
                profile: { displayName: 'Profile Name', avatarUrl: '/profile.png' },
              },
            ]),
          })),
        }));
        return { from: vi.fn(() => ({ leftJoin: mockOwnerLeftJoin })) } as never;
      });

      const request = new Request('https://example.com/api/drives/d/assignees');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      expect(body.assignees[0].name).toBe('Profile Name');
      expect(body.assignees[0].image).toBe('/profile.png');
    });

    it('should fall back to user.name/image when owner has no profile', async () => {
      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          const mockLeftJoin2 = vi.fn(() => ({
            where: vi.fn().mockResolvedValue([]),
          }));
          const mockLeftJoin1 = vi.fn(() => ({ leftJoin: mockLeftJoin2 }));
          return { from: vi.fn(() => ({ leftJoin: mockLeftJoin1 })) } as never;
        }
        if (selectCallCount === 2) {
          return {
            from: vi.fn(() => ({
              where: vi.fn(() => ({
                orderBy: vi.fn().mockResolvedValue([]),
              })),
            })),
          } as never;
        }
        const mockOwnerLeftJoin = vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([
              {
                user: { id: MOCK_OWNER_ID, email: 'owner@test.com', name: 'Owner Name', image: '/user.png' },
                profile: null,
              },
            ]),
          })),
        }));
        return { from: vi.fn(() => ({ leftJoin: mockOwnerLeftJoin })) } as never;
      });

      const request = new Request('https://example.com/api/drives/d/assignees');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      expect(body.assignees[0].name).toBe('Owner Name');
      expect(body.assignees[0].image).toBe('/user.png');
    });
  });

  describe('error handling', () => {
    it('should return 500 with error message when service throws Error', async () => {
      const error = new Error('DB connection lost');
      vi.mocked(db.query.drives.findFirst).mockRejectedValue(error);

      const request = new Request('https://example.com/api/drives/d/assignees');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toContain('Failed to fetch assignees');
      expect(body.error).toContain('DB connection lost');
    });

    it('should handle non-Error thrown values', async () => {
      vi.mocked(db.query.drives.findFirst).mockRejectedValue('string error');

      const request = new Request('https://example.com/api/drives/d/assignees');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toContain('string error');
    });
  });
});
