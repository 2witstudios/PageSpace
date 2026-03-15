import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for POST /api/drives/[driveId]/members/invite
//
// The route has no service-seam abstraction, so we mock at the DB layer
// and the auth/utility boundaries.
// ============================================================================

// ---------- hoisted mocks ----------

const {
  DRIVES_TABLE,
  DRIVE_MEMBERS_TABLE,
  PAGE_PERMISSIONS_TABLE,
  PAGES_TABLE,
  USERS_TABLE,
  mockDriveResults,
  mockAdminResults,
  mockExistingMemberResults,
  mockInsertReturning,
  mockUpdateReturning,
  mockUpdateSet,
  mockValidPagesResults,
  mockExistingPermResults,
  mockPermInsertReturning,
  mockPermUpdateReturning,
  mockUsersFindFirst,
} = vi.hoisted(() => ({
  DRIVES_TABLE: Symbol('drives'),
  DRIVE_MEMBERS_TABLE: Symbol('driveMembers'),
  PAGE_PERMISSIONS_TABLE: Symbol('pagePermissions'),
  PAGES_TABLE: Symbol('pages'),
  USERS_TABLE: Symbol('users'),
  mockDriveResults: { value: [] as Record<string, unknown>[] },
  mockAdminResults: { value: [] as Record<string, unknown>[] },
  mockExistingMemberResults: { value: [] as Record<string, unknown>[] },
  mockInsertReturning: vi.fn(),
  mockUpdateReturning: vi.fn(),
  mockUpdateSet: vi.fn(),
  mockValidPagesResults: { value: [] as Record<string, unknown>[] },
  mockExistingPermResults: { value: [] as Record<string, unknown>[] },
  mockPermInsertReturning: vi.fn(),
  mockPermUpdateReturning: vi.fn(),
  mockUsersFindFirst: vi.fn(),
}));

// ---------- vi.mock declarations ----------

vi.mock('@pagespace/db', () => {
  const eq = vi.fn((_col: unknown, _val: unknown) => ({ type: 'eq' }));
  const and = vi.fn((..._args: unknown[]) => ({ type: 'and' }));

  const createSelectChain = (resolveRef: { value: Record<string, unknown>[] }) => {
    const chain: Record<string, ReturnType<typeof vi.fn>> = {};
    chain.from = vi.fn().mockReturnValue(chain);
    chain.where = vi.fn().mockReturnValue(chain);
    chain.limit = vi.fn().mockImplementation(() => Promise.resolve(resolveRef.value));
    Object.defineProperty(chain, 'then', {
      value: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(resolveRef.value).then(resolve, reject),
      writable: true,
      configurable: true,
    });
    return chain;
  };

  // Track which table insert is called on
  let currentInsertTable: unknown = null;
  // Track which table update is called on
  let currentUpdateTable: unknown = null;

  return {
    db: {
      select: vi.fn().mockImplementation(() => {
        const outerChain: Record<string, unknown> = {};
        outerChain.from = vi.fn().mockImplementation((table: unknown) => {
          if (table === DRIVES_TABLE) return createSelectChain(mockDriveResults);
          if (table === DRIVE_MEMBERS_TABLE) {
            // This could be admin check or existing member check
            // We'll use call order within each test to distinguish
            return createSelectChain(mockAdminResults);
          }
          if (table === PAGES_TABLE) return createSelectChain(mockValidPagesResults);
          if (table === PAGE_PERMISSIONS_TABLE) return createSelectChain(mockExistingPermResults);
          return createSelectChain({ value: [] });
        });
        return outerChain;
      }),
      insert: vi.fn().mockImplementation((table: unknown) => {
        currentInsertTable = table;
        return {
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockImplementation(() => {
              if (currentInsertTable === DRIVE_MEMBERS_TABLE) {
                return Promise.resolve(mockInsertReturning());
              }
              if (currentInsertTable === PAGE_PERMISSIONS_TABLE) {
                return Promise.resolve(mockPermInsertReturning());
              }
              return Promise.resolve([]);
            }),
          }),
        };
      }),
      update: vi.fn().mockImplementation((table: unknown) => {
        currentUpdateTable = table;
        return {
          set: vi.fn().mockImplementation((..._args: unknown[]) => {
            mockUpdateSet(..._args);
            return {
              where: vi.fn().mockReturnValue({
                returning: vi.fn().mockImplementation(() => {
                  if (currentUpdateTable === PAGE_PERMISSIONS_TABLE) {
                    return Promise.resolve(mockPermUpdateReturning());
                  }
                  return Promise.resolve(mockUpdateReturning());
                }),
                then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
                  Promise.resolve(undefined).then(resolve, reject),
              }),
            };
          }),
        };
      }),
      query: {
        users: { findFirst: mockUsersFindFirst },
      },
    },
    drives: DRIVES_TABLE,
    driveMembers: DRIVE_MEMBERS_TABLE,
    pagePermissions: PAGE_PERMISSIONS_TABLE,
    pages: PAGES_TABLE,
    users: USERS_TABLE,
    eq,
    and,
  };
});

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib', () => ({
  createDriveNotification: vi.fn().mockResolvedValue(undefined),
  isEmailVerified: vi.fn().mockResolvedValue(true),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
  invalidateUserPermissions: vi.fn().mockResolvedValue(undefined),
  invalidateDrivePermissions: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/websocket', () => ({
  broadcastDriveMemberEvent: vi.fn().mockResolvedValue(undefined),
  createDriveMemberEventPayload: vi.fn((_driveId: string, _userId: string, _event: string, _data: unknown) => ({})),
}));

vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn().mockResolvedValue({ userId: 'user_123', email: 'user@example.com' }),
  logMemberActivity: vi.fn(),
}));

vi.mock('@pagespace/lib/activity-tracker', () => ({
  trackDriveOperation: vi.fn(),
}));

// ---------- imports (after mocks) ----------

import { POST } from '../route';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { createDriveNotification, isEmailVerified } from '@pagespace/lib';
import { loggers, invalidateUserPermissions, invalidateDrivePermissions } from '@pagespace/lib/server';
import { broadcastDriveMemberEvent, createDriveMemberEventPayload } from '@/lib/websocket';
import { getActorInfo, logMemberActivity } from '@pagespace/lib/monitoring/activity-logger';
import { trackDriveOperation } from '@pagespace/lib/activity-tracker';

// ---------- helpers ----------

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  role: 'user',
  adminRoleVersion: 0,
});

const mockAuthErrorResponse = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const createContext = (driveId: string) => ({
  params: Promise.resolve({ driveId }),
});

const createInviteRequest = (
  driveId: string,
  body: Record<string, unknown>
) =>
  new Request(`https://example.com/api/drives/${driveId}/members/invite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

// ============================================================================
// Tests
// ============================================================================

/** @scaffold - ORM chain mocks until repository seam exists */
describe('POST /api/drives/[driveId]/members/invite', () => {
  const mockUserId = 'user_123';
  const mockDriveId = 'drive_abc';
  const mockInvitedUserId = 'user_456';
  const mockDrive = {
    id: mockDriveId,
    name: 'Test Drive',
    slug: 'test-drive',
    ownerId: mockUserId,
  };

  const defaultBody = {
    userId: mockInvitedUserId,
    role: 'MEMBER',
    permissions: [
      { pageId: 'page_1', canView: true, canEdit: false, canShare: false },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(isEmailVerified).mockResolvedValue(true);

    // Default: drive found, user is owner
    mockDriveResults.value = [mockDrive];

    // Default: no admin membership
    mockAdminResults.value = [];

    // Default: no existing member
    mockExistingMemberResults.value = [];

    // Default: new member insert returns
    mockInsertReturning.mockReturnValue([{ id: 'mem_new' }]);

    // Default: valid pages
    mockValidPagesResults.value = [{ id: 'page_1' }];

    // Default: no existing permissions
    mockExistingPermResults.value = [];

    // Default: permission insert returns
    mockPermInsertReturning.mockReturnValue([{ id: 'perm_1' }]);

    // Default: permission update returns
    mockPermUpdateReturning.mockReturnValue([{ id: 'perm_1' }]);

    // Default: update returning
    mockUpdateReturning.mockReturnValue([]);

    // Default: user lookup
    mockUsersFindFirst.mockResolvedValue({ email: 'invited@example.com' });
  });

  // ---------- Authentication ----------

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthErrorResponse(401));

      const response = await POST(
        createInviteRequest(mockDriveId, defaultBody),
        createContext(mockDriveId)
      );

      expect(response.status).toBe(401);
    });

    it('should call authenticateRequestWithOptions with correct auth options', async () => {
      const request = createInviteRequest(mockDriveId, defaultBody);
      await POST(request, createContext(mockDriveId));

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(request, {
        allow: ['session'],
        requireCSRF: true,
      });
    });
  });

  // ---------- Email verification ----------

  describe('email verification', () => {
    it('should return 403 when email is not verified', async () => {
      vi.mocked(isEmailVerified).mockResolvedValue(false);

      const response = await POST(
        createInviteRequest(mockDriveId, defaultBody),
        createContext(mockDriveId)
      );
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toContain('Email verification required');
      expect(body.requiresEmailVerification).toBe(true);
    });

    it('should proceed when email is verified', async () => {
      vi.mocked(isEmailVerified).mockResolvedValue(true);

      const response = await POST(
        createInviteRequest(mockDriveId, defaultBody),
        createContext(mockDriveId)
      );

      expect(response.status).toBe(200);
    });
  });

  // ---------- Drive lookup ----------

  describe('drive lookup', () => {
    it('should return 404 when drive not found', async () => {
      mockDriveResults.value = [];

      const response = await POST(
        createInviteRequest(mockDriveId, defaultBody),
        createContext(mockDriveId)
      );
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Drive not found');
    });
  });

  // ---------- Authorization ----------

  describe('authorization', () => {
    it('should return 403 when user is not owner and not admin', async () => {
      mockDriveResults.value = [{ ...mockDrive, ownerId: 'other_user' }];
      mockAdminResults.value = [];

      const response = await POST(
        createInviteRequest(mockDriveId, defaultBody),
        createContext(mockDriveId)
      );
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Only drive owners and admins can add members');
    });

    it('should allow access when user is owner', async () => {
      mockDriveResults.value = [mockDrive];

      const response = await POST(
        createInviteRequest(mockDriveId, defaultBody),
        createContext(mockDriveId)
      );

      expect(response.status).toBe(200);
    });

    it('should allow access when user is admin (not owner)', async () => {
      mockDriveResults.value = [{ ...mockDrive, ownerId: 'other_user' }];
      mockAdminResults.value = [{ id: 'admin_membership' }];

      const response = await POST(
        createInviteRequest(mockDriveId, defaultBody),
        createContext(mockDriveId)
      );

      expect(response.status).toBe(200);
    });
  });

  // ---------- New member creation ----------

  describe('new member creation', () => {
    it('should insert new member when not existing', async () => {
      // The select().from(driveMembers) for existing member check
      // returns empty (no existing member)
      mockAdminResults.value = [];

      mockInsertReturning.mockReturnValue([{ id: 'mem_new' }]);

      const response = await POST(
        createInviteRequest(mockDriveId, defaultBody),
        createContext(mockDriveId)
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.memberId).toBe('mem_new');
    });

    it('should use default MEMBER role when not specified', async () => {
      const bodyWithoutRole = {
        userId: mockInvitedUserId,
        permissions: [],
      };

      const response = await POST(
        createInviteRequest(mockDriveId, bodyWithoutRole),
        createContext(mockDriveId)
      );

      expect(response.status).toBe(200);
    });

    it('should support ADMIN role', async () => {
      const adminBody = {
        userId: mockInvitedUserId,
        role: 'ADMIN',
        permissions: [],
      };

      const response = await POST(
        createInviteRequest(mockDriveId, adminBody),
        createContext(mockDriveId)
      );

      expect(response.status).toBe(200);
    });
  });

  // ---------- Existing member update ----------

  describe('existing member update', () => {
    it('should update role when member already exists', async () => {
      // The driveMembers select is used for both admin check and existing member check.
      // For this test, user IS owner so admin check is skipped.
      // The existing member check happens via the second db.select().from(driveMembers).
      // We need the existing member results to return a record.
      // Both admin check and existing member check use driveMembers table,
      // so they share the same mock. For this test the user is the owner
      // (first check is drives table), and we need the driveMembers results
      // to return an existing member.
      mockAdminResults.value = [{ id: 'existing_mem', userId: mockInvitedUserId }];

      const response = await POST(
        createInviteRequest(mockDriveId, { ...defaultBody, role: 'ADMIN' }),
        createContext(mockDriveId)
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.memberId).toBe('existing_mem');
      expect(mockUpdateSet).toHaveBeenCalledWith(expect.objectContaining({ role: 'ADMIN' }));
    });
  });

  // ---------- Page permissions ----------

  describe('page permissions', () => {
    it('should create new permissions for valid pages', async () => {
      mockValidPagesResults.value = [{ id: 'page_1' }];
      mockExistingPermResults.value = [];
      mockPermInsertReturning.mockReturnValue([{ id: 'perm_new' }]);

      const response = await POST(
        createInviteRequest(mockDriveId, defaultBody),
        createContext(mockDriveId)
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.permissionsGranted).toBe(1);
      expect(body.message).toBe('User added with 1 page permissions');
    });

    it('should update existing permissions', async () => {
      mockValidPagesResults.value = [{ id: 'page_1' }];
      mockExistingPermResults.value = [{ id: 'perm_existing', pageId: 'page_1', userId: mockInvitedUserId }];
      mockPermUpdateReturning.mockReturnValue([{ id: 'perm_existing' }]);

      const response = await POST(
        createInviteRequest(mockDriveId, defaultBody),
        createContext(mockDriveId)
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.permissionsGranted).toBe(1);
    });

    it('should skip invalid page IDs and log warning', async () => {
      mockValidPagesResults.value = [{ id: 'page_1' }]; // only page_1 is valid

      const bodyWithInvalidPage = {
        userId: mockInvitedUserId,
        permissions: [
          { pageId: 'page_1', canView: true, canEdit: false, canShare: false },
          { pageId: 'invalid_page', canView: true, canEdit: true, canShare: false },
        ],
      };

      const response = await POST(
        createInviteRequest(mockDriveId, bodyWithInvalidPage),
        createContext(mockDriveId)
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.permissionsGranted).toBe(1); // Only page_1 was valid
      expect(loggers.api.warn).toHaveBeenCalledWith(
        `Invalid page ID invalid_page for drive ${mockDriveId}`
      );
    });

    it('should handle empty permissions array', async () => {
      const bodyWithNoPerms = {
        userId: mockInvitedUserId,
        permissions: [],
      };

      const response = await POST(
        createInviteRequest(mockDriveId, bodyWithNoPerms),
        createContext(mockDriveId)
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.permissionsGranted).toBe(0);
      expect(body.message).toBe('User added with 0 page permissions');
    });
  });

  // ---------- Boundary obligations ----------

  describe('boundary obligations', () => {
    it('should broadcast drive member event', async () => {
      await POST(
        createInviteRequest(mockDriveId, defaultBody),
        createContext(mockDriveId)
      );

      expect(createDriveMemberEventPayload).toHaveBeenCalledWith(
        mockDriveId,
        mockInvitedUserId,
        'member_added',
        { role: 'MEMBER', driveName: 'Test Drive' }
      );
      expect(broadcastDriveMemberEvent).toHaveBeenCalledWith(expect.any(Object));
    });

    it('should invalidate permission caches', async () => {
      await POST(
        createInviteRequest(mockDriveId, defaultBody),
        createContext(mockDriveId)
      );

      expect(invalidateUserPermissions).toHaveBeenCalledWith(mockInvitedUserId);
      expect(invalidateDrivePermissions).toHaveBeenCalledWith(mockDriveId);
    });

    it('should send notification to invited user', async () => {
      await POST(
        createInviteRequest(mockDriveId, defaultBody),
        createContext(mockDriveId)
      );

      expect(createDriveNotification).toHaveBeenCalledWith(
        mockInvitedUserId,
        mockDriveId,
        'invited',
        'MEMBER',
        mockUserId
      );
    });

    it('should track drive operation for analytics', async () => {
      await POST(
        createInviteRequest(mockDriveId, defaultBody),
        createContext(mockDriveId)
      );

      expect(trackDriveOperation).toHaveBeenCalledWith(
        mockUserId,
        'invite_member',
        mockDriveId,
        expect.objectContaining({
          invitedUserId: mockInvitedUserId,
          role: 'MEMBER',
          permissionsGranted: 1,
        })
      );
    });

    it('should log member activity for audit trail', async () => {
      mockUsersFindFirst.mockResolvedValue({ email: 'invited@example.com' });

      await POST(
        createInviteRequest(mockDriveId, defaultBody),
        createContext(mockDriveId)
      );

      expect(getActorInfo).toHaveBeenCalledWith(mockUserId);
      expect(logMemberActivity).toHaveBeenCalledWith(
        mockUserId,
        'member_add',
        {
          driveId: mockDriveId,
          driveName: 'Test Drive',
          targetUserId: mockInvitedUserId,
          targetUserEmail: 'invited@example.com',
          role: 'MEMBER',
        },
        expect.anything()
      );
    });

    it('should handle undefined invited user email', async () => {
      mockUsersFindFirst.mockResolvedValue(undefined);

      await POST(
        createInviteRequest(mockDriveId, defaultBody),
        createContext(mockDriveId)
      );

      expect(logMemberActivity).toHaveBeenCalledWith(
        mockUserId,
        'member_add',
        expect.objectContaining({
          targetUserEmail: undefined,
        }),
        expect.anything()
      );
    });
  });

  // ---------- Response contract ----------

  describe('response contract', () => {
    it('should return memberId, permissionsGranted, and message', async () => {
      mockInsertReturning.mockReturnValue([{ id: 'mem_999' }]);

      const response = await POST(
        createInviteRequest(mockDriveId, defaultBody),
        createContext(mockDriveId)
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.memberId).toBe('mem_999');
      expect(body.permissionsGranted).toBe(1);
      expect(body.message).toBe('User added with 1 page permissions');
    });

    it('should support customRoleId', async () => {
      const bodyWithCustomRole = {
        userId: mockInvitedUserId,
        role: 'MEMBER',
        customRoleId: 'custom_role_123',
        permissions: [],
      };

      const response = await POST(
        createInviteRequest(mockDriveId, bodyWithCustomRole),
        createContext(mockDriveId)
      );

      expect(response.status).toBe(200);
    });
  });

  // ---------- Error handling ----------

  describe('error handling', () => {
    it('should return 500 when an error is thrown', async () => {
      vi.mocked(isEmailVerified).mockRejectedValueOnce(new Error('Service failure'));

      const response = await POST(
        createInviteRequest(mockDriveId, defaultBody),
        createContext(mockDriveId)
      );
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to add member');
    });

    it('should log error when an error is thrown', async () => {
      const error = new Error('Service failure');
      vi.mocked(isEmailVerified).mockRejectedValueOnce(error);

      await POST(
        createInviteRequest(mockDriveId, defaultBody),
        createContext(mockDriveId)
      );

      expect(loggers.api.error).toHaveBeenCalledWith('Error adding member:', error);
    });
  });
});
