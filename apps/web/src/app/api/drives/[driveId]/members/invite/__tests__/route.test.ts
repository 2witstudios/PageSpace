import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for POST /api/drives/[driveId]/members/invite
//
// Mocks the driveInviteRepository seam — no ORM chain mocks.
// ============================================================================

// ---------- vi.mock declarations ----------

vi.mock('@/lib/repositories/drive-invite-repository', () => ({
  driveInviteRepository: {
    findDriveById: vi.fn(),
    findAdminMembership: vi.fn(),
    findExistingMember: vi.fn(),
    createDriveMember: vi.fn(),
    updateDriveMemberRole: vi.fn(),
    getValidPageIds: vi.fn(),
    findPagePermission: vi.fn(),
    createPagePermission: vi.fn(),
    updatePagePermission: vi.fn(),
    findUserEmail: vi.fn(),
    findInviterDisplay: vi.fn(),
    findUserIdByEmail: vi.fn(),
    findActivePendingMemberByEmail: vi.fn(),
  },
}));

vi.mock('@pagespace/lib/auth/magic-link-service', () => ({
  createMagicLinkToken: vi.fn(),
  INVITATION_LINK_EXPIRY_MINUTES: 60 * 24 * 7,
}));

vi.mock('@pagespace/lib/services/notification-email-service', () => ({
  sendPendingDriveInvitationEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: vi.fn().mockResolvedValue({ allowed: true, attemptsRemaining: 2 }),
  DISTRIBUTED_RATE_LIMITS: {
    MAGIC_LINK: { maxAttempts: 3, windowMs: 15 * 60 * 1000, blockDurationMs: 15 * 60 * 1000, progressiveDelay: false },
  },
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib/notifications/notifications', () => ({
    createDriveNotification: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@pagespace/lib/auth/verification-utils', () => ({
    isEmailVerified: vi.fn().mockResolvedValue(true),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
    loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
    audit: vi.fn(),
    auditRequest: vi.fn(),
}));

vi.mock('@/lib/websocket', () => ({
  broadcastDriveMemberEvent: vi.fn().mockResolvedValue(undefined),
  createDriveMemberEventPayload: vi.fn(
    (driveId: string, userId: string, event: string, data: unknown) => ({
      driveId,
      userId,
      event,
      ...(data as Record<string, unknown>),
    })
  ),
}));

vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn().mockResolvedValue({ userId: 'user_123', email: 'user@example.com' }),
  logMemberActivity: vi.fn(),
}));

vi.mock('@pagespace/lib/monitoring/activity-tracker', () => ({
  trackDriveOperation: vi.fn(),
}));

// ---------- imports (after mocks) ----------

import { POST } from '../route';
import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { createDriveNotification } from '@pagespace/lib/notifications/notifications'
import { isEmailVerified } from '@pagespace/lib/auth/verification-utils';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { broadcastDriveMemberEvent, createDriveMemberEventPayload } from '@/lib/websocket';
import { getActorInfo, logMemberActivity } from '@pagespace/lib/monitoring/activity-logger';
import { trackDriveOperation } from '@pagespace/lib/monitoring/activity-tracker';
import { createMagicLinkToken } from '@pagespace/lib/auth/magic-link-service';
import { sendPendingDriveInvitationEmail } from '@pagespace/lib/services/notification-email-service';
import { checkDistributedRateLimit } from '@pagespace/lib/security/distributed-rate-limit';

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

// ---------- fixtures ----------

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

// ============================================================================
// Tests
// ============================================================================

describe('POST /api/drives/[driveId]/members/invite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(isEmailVerified).mockResolvedValue(true);

    // Repository defaults
    vi.mocked(driveInviteRepository.findDriveById).mockResolvedValue(mockDrive as never);
    vi.mocked(driveInviteRepository.findAdminMembership).mockResolvedValue(null as never);
    vi.mocked(driveInviteRepository.findExistingMember).mockResolvedValue(null as never);
    vi.mocked(driveInviteRepository.createDriveMember).mockResolvedValue({ id: 'mem_new' } as never);
    vi.mocked(driveInviteRepository.updateDriveMemberRole).mockResolvedValue(undefined);
    vi.mocked(driveInviteRepository.getValidPageIds).mockResolvedValue(['page_1']);
    vi.mocked(driveInviteRepository.findPagePermission).mockResolvedValue(null as never);
    vi.mocked(driveInviteRepository.createPagePermission).mockResolvedValue({ id: 'perm_1' } as never);
    vi.mocked(driveInviteRepository.updatePagePermission).mockResolvedValue({ id: 'perm_1' } as never);
    vi.mocked(driveInviteRepository.findUserEmail).mockResolvedValue('invited@example.com');
    vi.mocked(driveInviteRepository.findInviterDisplay).mockResolvedValue({
      name: 'Inviter Name',
      email: 'inviter@example.com',
    });
    vi.mocked(driveInviteRepository.findUserIdByEmail).mockResolvedValue(null as never);
    vi.mocked(driveInviteRepository.findActivePendingMemberByEmail).mockResolvedValue(null as never);
    vi.mocked(createMagicLinkToken).mockResolvedValue({
      ok: true,
      data: { token: 'ps_magic_test_token', userId: 'user_temp_999', isNewUser: true },
    });
    vi.mocked(sendPendingDriveInvitationEmail).mockResolvedValue(undefined);
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
      vi.mocked(driveInviteRepository.findDriveById).mockResolvedValue(null as never);

      const response = await POST(
        createInviteRequest(mockDriveId, defaultBody),
        createContext(mockDriveId)
      );
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Drive not found');
    });

    it('should query drive by driveId from params', async () => {
      await POST(
        createInviteRequest(mockDriveId, defaultBody),
        createContext(mockDriveId)
      );

      expect(driveInviteRepository.findDriveById).toHaveBeenCalledWith(mockDriveId);
    });
  });

  // ---------- Authorization ----------

  describe('authorization', () => {
    it('should return 403 when user is not owner and not admin', async () => {
      vi.mocked(driveInviteRepository.findDriveById).mockResolvedValue({
        ...mockDrive,
        ownerId: 'other_user',
      } as never);
      vi.mocked(driveInviteRepository.findAdminMembership).mockResolvedValue(null as never);

      const response = await POST(
        createInviteRequest(mockDriveId, defaultBody),
        createContext(mockDriveId)
      );
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Only drive owners and admins can add members');
    });

    it('should allow access when user is owner', async () => {
      const response = await POST(
        createInviteRequest(mockDriveId, defaultBody),
        createContext(mockDriveId)
      );

      expect(response.status).toBe(200);
    });

    it('should allow access when user is admin (not owner)', async () => {
      vi.mocked(driveInviteRepository.findDriveById).mockResolvedValue({
        ...mockDrive,
        ownerId: 'other_user',
      } as never);
      vi.mocked(driveInviteRepository.findAdminMembership).mockResolvedValue({
        id: 'admin_membership',
      } as never);

      const response = await POST(
        createInviteRequest(mockDriveId, defaultBody),
        createContext(mockDriveId)
      );

      expect(response.status).toBe(200);
    });

    it('should skip admin check when user is owner', async () => {
      await POST(
        createInviteRequest(mockDriveId, defaultBody),
        createContext(mockDriveId)
      );

      expect(driveInviteRepository.findAdminMembership).not.toHaveBeenCalled();
    });

    it('should check admin membership when user is not owner', async () => {
      vi.mocked(driveInviteRepository.findDriveById).mockResolvedValue({
        ...mockDrive,
        ownerId: 'other_user',
      } as never);
      vi.mocked(driveInviteRepository.findAdminMembership).mockResolvedValue({
        id: 'admin_mem',
      } as never);

      await POST(
        createInviteRequest(mockDriveId, defaultBody),
        createContext(mockDriveId)
      );

      expect(driveInviteRepository.findAdminMembership).toHaveBeenCalledWith(
        mockDriveId,
        mockUserId
      );
    });
  });

  // ---------- New member creation ----------

  describe('new member creation', () => {
    it('should insert new member when not existing', async () => {
      vi.mocked(driveInviteRepository.findExistingMember).mockResolvedValue(null as never);
      vi.mocked(driveInviteRepository.createDriveMember).mockResolvedValue({
        id: 'mem_new',
      } as never);

      const response = await POST(
        createInviteRequest(mockDriveId, defaultBody),
        createContext(mockDriveId)
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.memberId).toBe('mem_new');
      const createCall = vi.mocked(driveInviteRepository.createDriveMember).mock.calls[0][0];
      expect(createCall).toEqual(expect.objectContaining({
        driveId: mockDriveId,
        userId: mockInvitedUserId,
        role: 'MEMBER',
        customRoleId: null,
        invitedBy: mockUserId,
      }));
      expect(createCall.acceptedAt).toBeInstanceOf(Date);
    });

    it('should use default MEMBER role when not specified', async () => {
      const bodyWithoutRole = {
        userId: mockInvitedUserId,
        permissions: [],
      };

      await POST(
        createInviteRequest(mockDriveId, bodyWithoutRole),
        createContext(mockDriveId)
      );

      expect(driveInviteRepository.createDriveMember).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'MEMBER' })
      );
    });

    it('should support ADMIN role', async () => {
      const adminBody = {
        userId: mockInvitedUserId,
        role: 'ADMIN',
        permissions: [],
      };

      await POST(
        createInviteRequest(mockDriveId, adminBody),
        createContext(mockDriveId)
      );

      expect(driveInviteRepository.createDriveMember).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'ADMIN' })
      );
    });

    it('should pass customRoleId when provided', async () => {
      const bodyWithCustomRole = {
        userId: mockInvitedUserId,
        role: 'MEMBER',
        customRoleId: 'custom_role_123',
        permissions: [],
      };

      await POST(
        createInviteRequest(mockDriveId, bodyWithCustomRole),
        createContext(mockDriveId)
      );

      expect(driveInviteRepository.createDriveMember).toHaveBeenCalledWith(
        expect.objectContaining({ customRoleId: 'custom_role_123' })
      );
    });
  });

  // ---------- Existing member update ----------

  describe('existing member update', () => {
    it('should update role when member already exists', async () => {
      vi.mocked(driveInviteRepository.findExistingMember).mockResolvedValue({
        id: 'existing_mem',
        userId: mockInvitedUserId,
      } as never);

      const response = await POST(
        createInviteRequest(mockDriveId, { ...defaultBody, role: 'ADMIN' }),
        createContext(mockDriveId)
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.memberId).toBe('existing_mem');
      expect(driveInviteRepository.updateDriveMemberRole).toHaveBeenCalledWith(
        'existing_mem',
        'ADMIN',
        null
      );
    });

    it('should not create new member when one already exists', async () => {
      vi.mocked(driveInviteRepository.findExistingMember).mockResolvedValue({
        id: 'existing_mem',
      } as never);

      await POST(
        createInviteRequest(mockDriveId, defaultBody),
        createContext(mockDriveId)
      );

      expect(driveInviteRepository.createDriveMember).not.toHaveBeenCalled();
    });
  });

  // ---------- Page permissions ----------

  describe('page permissions', () => {
    it('should create new permissions for valid pages', async () => {
      vi.mocked(driveInviteRepository.getValidPageIds).mockResolvedValue(['page_1']);
      vi.mocked(driveInviteRepository.findPagePermission).mockResolvedValue(null as never);
      vi.mocked(driveInviteRepository.createPagePermission).mockResolvedValue({
        id: 'perm_new',
      } as never);

      const response = await POST(
        createInviteRequest(mockDriveId, defaultBody),
        createContext(mockDriveId)
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.permissionsGranted).toBe(1);
      expect(driveInviteRepository.createPagePermission).toHaveBeenCalledWith({
        pageId: 'page_1',
        userId: mockInvitedUserId,
        canView: true,
        canEdit: false,
        canShare: false,
        canDelete: false,
        grantedBy: mockUserId,
      });
    });

    it('should update existing permissions', async () => {
      vi.mocked(driveInviteRepository.getValidPageIds).mockResolvedValue(['page_1']);
      vi.mocked(driveInviteRepository.findPagePermission).mockResolvedValue({
        id: 'perm_existing',
        pageId: 'page_1',
        userId: mockInvitedUserId,
      } as never);
      vi.mocked(driveInviteRepository.updatePagePermission).mockResolvedValue({
        id: 'perm_existing',
      } as never);

      const response = await POST(
        createInviteRequest(mockDriveId, defaultBody),
        createContext(mockDriveId)
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.permissionsGranted).toBe(1);
      const updateCall = vi.mocked(driveInviteRepository.updatePagePermission).mock.calls[0];
      expect(updateCall[0]).toBe('perm_existing');
      expect(updateCall[1]).toEqual(expect.objectContaining({
        canView: true,
        canEdit: false,
        canShare: false,
        grantedBy: mockUserId,
      }));
      expect((updateCall[1] as Record<string, unknown>).grantedAt).toBeInstanceOf(Date);
    });

    it('should skip invalid page IDs and log warning', async () => {
      vi.mocked(driveInviteRepository.getValidPageIds).mockResolvedValue(['page_1']);

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
      expect(body.permissionsGranted).toBe(1);
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

    it('should never grant canDelete via invite', async () => {
      vi.mocked(driveInviteRepository.getValidPageIds).mockResolvedValue(['page_1']);
      vi.mocked(driveInviteRepository.findPagePermission).mockResolvedValue(null as never);

      await POST(
        createInviteRequest(mockDriveId, defaultBody),
        createContext(mockDriveId)
      );

      expect(driveInviteRepository.createPagePermission).toHaveBeenCalledWith(
        expect.objectContaining({ canDelete: false })
      );
    });
  });

  // ---------- Boundary obligations ----------

  describe('boundary obligations', () => {
    it('should broadcast drive member event with correct payload', async () => {
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
      expect(broadcastDriveMemberEvent).toHaveBeenCalledTimes(1);
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
      vi.mocked(driveInviteRepository.findUserEmail).mockResolvedValue('invited@example.com');

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
        { userId: 'user_123', email: 'user@example.com' }
      );
    });

    it('should handle undefined invited user email', async () => {
      vi.mocked(driveInviteRepository.findUserEmail).mockResolvedValue(undefined);

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
        { userId: 'user_123', email: 'user@example.com' }
      );
    });
  });

  // ---------- Response contract ----------

  describe('response contract', () => {
    it('should return memberId, permissionsGranted, and message', async () => {
      vi.mocked(driveInviteRepository.createDriveMember).mockResolvedValue({
        id: 'mem_999',
      } as never);

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

    it('should not create member or permissions on auth failure', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthErrorResponse(401));

      await POST(
        createInviteRequest(mockDriveId, defaultBody),
        createContext(mockDriveId)
      );

      expect(driveInviteRepository.createDriveMember).not.toHaveBeenCalled();
      expect(driveInviteRepository.createPagePermission).not.toHaveBeenCalled();
      expect(broadcastDriveMemberEvent).not.toHaveBeenCalled();
    });
  });

  // ---------- Email payload branch ----------

  describe('email payload branch', () => {
    const emailBody = {
      email: 'newcomer@example.com',
      role: 'MEMBER',
      permissions: [
        { pageId: 'page_1', canView: true, canEdit: false, canShare: false },
      ],
    };

    it('given an email that maps to an existing user, falls through to add path with kind: added', async () => {
      vi.mocked(driveInviteRepository.findUserIdByEmail).mockResolvedValue({
        id: 'user_existing_42',
      } as never);

      const response = await POST(
        createInviteRequest(mockDriveId, emailBody),
        createContext(mockDriveId)
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.kind).toBe('added');
      expect(body.memberId).toBe('mem_new');
      expect(driveInviteRepository.createDriveMember).toHaveBeenCalledWith(
        expect.objectContaining({
          driveId: mockDriveId,
          userId: 'user_existing_42',
          role: 'MEMBER',
        })
      );
      const createCall = vi.mocked(driveInviteRepository.createDriveMember).mock.calls[0][0];
      expect(createCall.acceptedAt).toBeInstanceOf(Date);
      expect(createMagicLinkToken).not.toHaveBeenCalled();
      expect(sendPendingDriveInvitationEmail).not.toHaveBeenCalled();
    });

    it('given an email that maps to no user, creates a pending member and sends an invitation email with kind: invited', async () => {
      vi.mocked(driveInviteRepository.findUserIdByEmail).mockResolvedValue(null as never);

      const response = await POST(
        createInviteRequest(mockDriveId, emailBody),
        createContext(mockDriveId)
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.kind).toBe('invited');
      expect(body.email).toBe('newcomer@example.com');

      expect(createMagicLinkToken).toHaveBeenCalledWith(expect.objectContaining({ email: 'newcomer@example.com' }));

      const createCall = vi.mocked(driveInviteRepository.createDriveMember).mock.calls[0][0];
      expect(createCall).toEqual(
        expect.objectContaining({
          driveId: mockDriveId,
          userId: 'user_temp_999',
          role: 'MEMBER',
          invitedBy: mockUserId,
          acceptedAt: null,
        })
      );

      expect(sendPendingDriveInvitationEmail).toHaveBeenCalledTimes(1);
      const emailCall = vi.mocked(sendPendingDriveInvitationEmail).mock.calls[0][0];
      expect(emailCall.recipientEmail).toBe('newcomer@example.com');
      expect(emailCall.driveName).toBe('Test Drive');
      expect(emailCall.magicLinkUrl).toContain('token=ps_magic_test_token');
      expect(emailCall.magicLinkUrl).toContain(`inviteDriveId=${mockDriveId}`);
    });

    it('given an active pending row already exists for the email, responds 409 with the existing member id', async () => {
      vi.mocked(driveInviteRepository.findUserIdByEmail).mockResolvedValue(null as never);
      vi.mocked(driveInviteRepository.findActivePendingMemberByEmail).mockResolvedValue({
        id: 'mem_pending_existing',
      } as never);

      const response = await POST(
        createInviteRequest(mockDriveId, emailBody),
        createContext(mockDriveId)
      );
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.existingMemberId).toBe('mem_pending_existing');
      expect(driveInviteRepository.createDriveMember).not.toHaveBeenCalled();
      expect(createMagicLinkToken).not.toHaveBeenCalled();
      expect(sendPendingDriveInvitationEmail).not.toHaveBeenCalled();
    });

    it('given the per-email rate limit denies the invite, responds 429 without creating a magic-link token or sending an email', async () => {
      vi.mocked(driveInviteRepository.findUserIdByEmail).mockResolvedValue(null as never);
      vi.mocked(checkDistributedRateLimit).mockResolvedValueOnce({
        allowed: false,
        retryAfter: 900,
        attemptsRemaining: 0,
      });

      const response = await POST(
        createInviteRequest(mockDriveId, emailBody),
        createContext(mockDriveId)
      );

      expect(response.status).toBe(429);
      expect(createMagicLinkToken).not.toHaveBeenCalled();
      expect(sendPendingDriveInvitationEmail).not.toHaveBeenCalled();
    });

    it('given an email with mixed case and surrounding whitespace, normalizes to lowercase trimmed before lookup and storage', async () => {
      vi.mocked(driveInviteRepository.findUserIdByEmail).mockResolvedValue(null as never);

      const response = await POST(
        createInviteRequest(mockDriveId, { ...emailBody, email: '  Newcomer@Example.COM  ' }),
        createContext(mockDriveId)
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.email).toBe('newcomer@example.com');
      expect(driveInviteRepository.findUserIdByEmail).toHaveBeenCalledWith('newcomer@example.com');
      expect(driveInviteRepository.findActivePendingMemberByEmail).toHaveBeenCalledWith(
        mockDriveId,
        'newcomer@example.com'
      );
      expect(createMagicLinkToken).toHaveBeenCalledWith(expect.objectContaining({ email: 'newcomer@example.com' }));
    });
  });
});
