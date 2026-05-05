import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for POST /api/drives/[driveId]/members/invite
//
// Mocks the driveInviteRepository seam, the magic-link service, the email
// helper, the rate limiter, and the recipient-broadcast helper. No ORM
// chain mocking — Drizzle is never poked here.
// ============================================================================

vi.mock('@/lib/repositories/drive-invite-repository', () => ({
  driveInviteRepository: {
    findDriveById: vi.fn(),
    findAdminMembership: vi.fn(),
    findExistingMember: vi.fn(),
    findUserIdByEmail: vi.fn(),
    findUserVerificationStatusById: vi.fn(),
    findActivePendingMemberByEmail: vi.fn(),
    findInviterDisplay: vi.fn(),
    createDriveMember: vi.fn(),
    createAcceptedMemberWithPermissions: vi.fn(),
    deleteDriveMemberById: vi.fn(),
    updateDriveMemberRole: vi.fn(),
    getValidPageIds: vi.fn(),
    findPagePermission: vi.fn(),
    createPagePermission: vi.fn(),
    updatePagePermission: vi.fn(),
    findUserEmail: vi.fn(),
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
  broadcastDriveMemberEventToRecipients: vi.fn().mockResolvedValue(undefined),
  createDriveMemberEventPayload: vi.fn(
    (driveId: string, userId: string, event: string, data: unknown) => ({
      driveId,
      userId,
      event,
      ...(data as Record<string, unknown>),
    })
  ),
}));

vi.mock('@pagespace/lib/services/drive-member-service', () => ({
  getDriveRecipientUserIds: vi.fn().mockResolvedValue([]),
}));

vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn().mockResolvedValue({ userId: 'user_123', email: 'user@example.com' }),
  logMemberActivity: vi.fn(),
}));

vi.mock('@pagespace/lib/monitoring/activity-tracker', () => ({
  trackDriveOperation: vi.fn(),
}));

vi.mock('@pagespace/lib/auth/magic-link-service', () => ({
  createMagicLinkToken: vi.fn(),
  INVITATION_LINK_EXPIRY_MINUTES: 60 * 24 * 7,
}));

vi.mock('@pagespace/lib/services/notification-email-service', () => ({
  sendPendingDriveInvitationEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  DISTRIBUTED_RATE_LIMITS: { DRIVE_INVITE: { maxAttempts: 3, windowMs: 900000 } },
}));

import { POST } from '../route';
import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { createDriveNotification } from '@pagespace/lib/notifications/notifications';
import { isEmailVerified } from '@pagespace/lib/auth/verification-utils';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import {
  broadcastDriveMemberEvent,
  broadcastDriveMemberEventToRecipients,
  createDriveMemberEventPayload,
} from '@/lib/websocket';
import { getDriveRecipientUserIds } from '@pagespace/lib/services/drive-member-service';
import { logMemberActivity } from '@pagespace/lib/monitoring/activity-logger';
import { trackDriveOperation } from '@pagespace/lib/monitoring/activity-tracker';
import { createMagicLinkToken } from '@pagespace/lib/auth/magic-link-service';
import { sendPendingDriveInvitationEmail } from '@pagespace/lib/services/notification-email-service';
import { checkDistributedRateLimit } from '@pagespace/lib/security/distributed-rate-limit';

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

const buildPost = (driveId: string, body: unknown) =>
  new Request(`https://example.com/api/drives/${driveId}/members/invite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const ORIGINAL_ENV = { ...process.env };

const mockUserId = 'user_123';
const mockDriveId = 'drive_abc';
const mockInvitedUserId = 'user_456';
const mockDrive = {
  id: mockDriveId,
  name: 'Test Drive',
  slug: 'test-drive',
  ownerId: mockUserId,
};

const userIdBody = {
  userId: mockInvitedUserId,
  role: 'MEMBER',
  permissions: [{ pageId: 'page_1', canView: true, canEdit: false, canShare: false }],
};

describe('POST /api/drives/[driveId]/members/invite', () => {
  afterEach(() => {
    // Restore env per-test so a test that deletes WEB_APP_URL/NEXT_PUBLIC_APP_URL
    // doesn't poison subsequent tests in this file.
    process.env = { ...ORIGINAL_ENV };
  });

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.WEB_APP_URL = 'https://app.example.com';
    delete process.env.NEXT_PUBLIC_APP_URL;

    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(isEmailVerified).mockResolvedValue(true);

    vi.mocked(driveInviteRepository.findDriveById).mockResolvedValue(mockDrive as never);
    vi.mocked(driveInviteRepository.findAdminMembership).mockResolvedValue(null as never);
    vi.mocked(driveInviteRepository.findExistingMember).mockResolvedValue(null as never);
    vi.mocked(driveInviteRepository.findUserIdByEmail).mockResolvedValue(null as never);
    vi.mocked(driveInviteRepository.findActivePendingMemberByEmail).mockResolvedValue(null as never);
    vi.mocked(driveInviteRepository.findInviterDisplay).mockResolvedValue({
      name: 'Inviter Name',
      email: 'inviter@example.com',
    } as never);
    vi.mocked(driveInviteRepository.createDriveMember).mockResolvedValue({ id: 'mem_pending' } as never);
    vi.mocked(driveInviteRepository.createAcceptedMemberWithPermissions).mockResolvedValue({
      memberId: 'mem_new',
      permissionsGranted: 1,
    } as never);
    vi.mocked(driveInviteRepository.deleteDriveMemberById).mockResolvedValue(undefined);
    vi.mocked(driveInviteRepository.updateDriveMemberRole).mockResolvedValue(undefined);
    vi.mocked(driveInviteRepository.getValidPageIds).mockResolvedValue(['page_1']);
    vi.mocked(driveInviteRepository.findPagePermission).mockResolvedValue(null as never);
    vi.mocked(driveInviteRepository.createPagePermission).mockResolvedValue({ id: 'perm_1' } as never);
    vi.mocked(driveInviteRepository.updatePagePermission).mockResolvedValue({ id: 'perm_1' } as never);
    vi.mocked(driveInviteRepository.findUserEmail).mockResolvedValue('invited@example.com');
    vi.mocked(driveInviteRepository.findUserVerificationStatusById).mockResolvedValue({
      email: 'invited@example.com',
      emailVerified: new Date('2026-01-01'),
      suspendedAt: null,
    } as never);

    vi.mocked(checkDistributedRateLimit).mockResolvedValue({ allowed: true });
    vi.mocked(getDriveRecipientUserIds).mockResolvedValue([]);
    vi.mocked(createMagicLinkToken).mockResolvedValue({
      ok: true,
      data: { token: 'ps_magic_xyz', userId: 'user_pending', isNewUser: true },
    } as never);
  });

  // ==========================================================================
  // Boundary validation (the gap PR #1229 missed)
  // ==========================================================================

  describe('boundary validation', () => {
    it('rejects role: OWNER with 400', async () => {
      const response = await POST(
        buildPost(mockDriveId, { userId: mockInvitedUserId, role: 'OWNER', permissions: [] }),
        createContext(mockDriveId)
      );
      expect(response.status).toBe(400);
    });

    it('rejects role: SUPERADMIN (any value not in MEMBER/ADMIN) with 400', async () => {
      const response = await POST(
        buildPost(mockDriveId, { userId: mockInvitedUserId, role: 'SUPERADMIN', permissions: [] }),
        createContext(mockDriveId)
      );
      expect(response.status).toBe(400);
    });

    it('rejects non-string email with 400', async () => {
      const response = await POST(
        buildPost(mockDriveId, { email: 12345, role: 'MEMBER', permissions: [] }),
        createContext(mockDriveId)
      );
      expect(response.status).toBe(400);
    });

    it('rejects malformed email shape with 400', async () => {
      const response = await POST(
        buildPost(mockDriveId, { email: 'not-an-email', role: 'MEMBER', permissions: [] }),
        createContext(mockDriveId)
      );
      expect(response.status).toBe(400);
    });

    it('rejects empty body with 400', async () => {
      const response = await POST(buildPost(mockDriveId, {}), createContext(mockDriveId));
      expect(response.status).toBe(400);
    });

    it('rejects array body with 400', async () => {
      const response = await POST(buildPost(mockDriveId, []), createContext(mockDriveId));
      expect(response.status).toBe(400);
    });

    it('rejects malformed JSON body with 400', async () => {
      const response = await POST(buildPost(mockDriveId, '{not json'), createContext(mockDriveId));
      expect(response.status).toBe(400);
    });
  });

  // ==========================================================================
  // Auth + authorization
  // ==========================================================================

  describe('auth + authorization', () => {
    it('returns 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthErrorResponse(401));

      const response = await POST(buildPost(mockDriveId, userIdBody), createContext(mockDriveId));
      expect(response.status).toBe(401);
    });

    it('returns 403 with requiresEmailVerification when inviter unverified', async () => {
      vi.mocked(isEmailVerified).mockResolvedValue(false);
      const response = await POST(buildPost(mockDriveId, userIdBody), createContext(mockDriveId));
      const json = await response.json();
      expect(response.status).toBe(403);
      expect(json.requiresEmailVerification).toBe(true);
    });

    it('returns 403 when inviter is neither owner nor accepted-admin', async () => {
      vi.mocked(driveInviteRepository.findDriveById).mockResolvedValue({
        ...mockDrive,
        ownerId: 'someone_else',
      } as never);
      vi.mocked(driveInviteRepository.findAdminMembership).mockResolvedValue(null as never);

      const response = await POST(buildPost(mockDriveId, userIdBody), createContext(mockDriveId));
      expect(response.status).toBe(403);
    });

    it('returns 403 when inviter is a pending admin (acceptedAt IS NULL)', async () => {
      // Epic 1 already filters acceptedAt IS NOT NULL inside findAdminMembership,
      // so the seam returns null for a pending admin. Exercising that contract.
      vi.mocked(driveInviteRepository.findDriveById).mockResolvedValue({
        ...mockDrive,
        ownerId: 'someone_else',
      } as never);
      vi.mocked(driveInviteRepository.findAdminMembership).mockResolvedValue(null as never);

      const response = await POST(buildPost(mockDriveId, userIdBody), createContext(mockDriveId));
      expect(response.status).toBe(403);
    });

    it('returns 404 when drive not found', async () => {
      vi.mocked(driveInviteRepository.findDriveById).mockResolvedValue(null as never);
      const response = await POST(buildPost(mockDriveId, userIdBody), createContext(mockDriveId));
      expect(response.status).toBe(404);
    });
  });

  // ==========================================================================
  // userId payload — preserves Epic 2 behavior
  // ==========================================================================

  describe('userId payload', () => {
    it('returns kind: "added" with memberId for new join', async () => {
      const response = await POST(buildPost(mockDriveId, userIdBody), createContext(mockDriveId));
      const json = await response.json();

      expect(response.status).toBe(200);
      expect(json.kind).toBe('added');
      expect(json.memberId).toBe('mem_new');
      expect(json.permissionsGranted).toBe(1);
    });

    it('uses transactional createAcceptedMemberWithPermissions for new join', async () => {
      await POST(buildPost(mockDriveId, userIdBody), createContext(mockDriveId));

      expect(driveInviteRepository.createAcceptedMemberWithPermissions).toHaveBeenCalledWith(
        expect.objectContaining({
          driveId: mockDriveId,
          userId: mockInvitedUserId,
          role: 'MEMBER',
          invitedBy: mockUserId,
        })
      );
      // The non-transactional createDriveMember path is NOT used for the join.
      expect(driveInviteRepository.createDriveMember).not.toHaveBeenCalled();
    });

    it('updates existing member role via updateDriveMemberRole', async () => {
      vi.mocked(driveInviteRepository.findExistingMember).mockResolvedValue({
        id: 'mem_existing',
        userId: mockInvitedUserId,
        acceptedAt: new Date(),
      } as never);

      const response = await POST(
        buildPost(mockDriveId, { ...userIdBody, role: 'ADMIN' }),
        createContext(mockDriveId)
      );
      const json = await response.json();

      expect(response.status).toBe(200);
      expect(json.kind).toBe('added');
      expect(json.memberId).toBe('mem_existing');
      expect(driveInviteRepository.updateDriveMemberRole).toHaveBeenCalledWith(
        'mem_existing',
        'ADMIN',
        null
      );
    });

    it('does not call findUserIdByEmail on the userId path (paths are disjoint)', async () => {
      await POST(buildPost(mockDriveId, userIdBody), createContext(mockDriveId));
      expect(driveInviteRepository.findUserIdByEmail).not.toHaveBeenCalled();
      expect(driveInviteRepository.findActivePendingMemberByEmail).not.toHaveBeenCalled();
    });

    // Review C1 — closes the path "create temp user via email invite to drive A
    // → revoke that invite → admin uses /users/search to re-invite by userId on
    // drive B". Before this gate, the userId path called
    // createAcceptedMemberWithPermissions on a never-authenticated account.
    describe('emailVerified gate on userId path (Review C1: temp-user-via-userId-path adversarial path)', () => {
      it('routes unverified target through invitation flow — must NOT call createAcceptedMemberWithPermissions', async () => {
        vi.mocked(driveInviteRepository.findUserVerificationStatusById).mockResolvedValue({
          email: 'unverified@example.com',
          emailVerified: null,
          suspendedAt: null,
        } as never);

        const response = await POST(
          buildPost(mockDriveId, {
            userId: 'temp_user_id',
            role: 'MEMBER',
            permissions: [],
          }),
          createContext(mockDriveId)
        );
        const json = await response.json();

        expect(response.status).toBe(200);
        expect(json.kind).toBe('invited');
        expect(driveInviteRepository.createAcceptedMemberWithPermissions).not.toHaveBeenCalled();
        expect(driveInviteRepository.createDriveMember).toHaveBeenCalledWith(
          expect.objectContaining({ acceptedAt: null, role: 'MEMBER', driveId: mockDriveId })
        );
        expect(createMagicLinkToken).toHaveBeenCalledWith({
          email: 'unverified@example.com',
          expiryMinutes: 60 * 24 * 7,
        });
        expect(sendPendingDriveInvitationEmail).toHaveBeenCalledWith(
          expect.objectContaining({ recipientEmail: 'unverified@example.com' })
        );
      });

      it('rejects suspended target user with 403 even on userId path', async () => {
        vi.mocked(driveInviteRepository.findUserVerificationStatusById).mockResolvedValue({
          email: 'banned@example.com',
          emailVerified: new Date('2026-01-01'),
          suspendedAt: new Date('2026-02-01'),
        } as never);

        const response = await POST(
          buildPost(mockDriveId, { userId: 'suspended_user', role: 'MEMBER', permissions: [] }),
          createContext(mockDriveId)
        );

        expect(response.status).toBe(403);
        expect(driveInviteRepository.createAcceptedMemberWithPermissions).not.toHaveBeenCalled();
        expect(driveInviteRepository.createDriveMember).not.toHaveBeenCalled();
      });

      it('returns 404 when invited userId resolves to no user record', async () => {
        vi.mocked(driveInviteRepository.findUserVerificationStatusById).mockResolvedValue(null as never);

        const response = await POST(
          buildPost(mockDriveId, { userId: 'ghost_user', role: 'MEMBER', permissions: [] }),
          createContext(mockDriveId)
        );

        expect(response.status).toBe(404);
        expect(driveInviteRepository.createAcceptedMemberWithPermissions).not.toHaveBeenCalled();
      });

      // Codex P2: unverified-userId-path reroutes to handleEmailPath but used
      // to hardcode permissions: [], silently dropping caller-supplied page
      // permissions while returning kind: invited. The fix forwards the
      // original permissions so the email path's existing 422 fires.
      it('rejects 422 when permissions[] non-empty on unverified-userId path — adversarial silently-dropped-permissions path', async () => {
        vi.mocked(driveInviteRepository.findUserVerificationStatusById).mockResolvedValue({
          email: 'unverified@example.com',
          emailVerified: null,
          suspendedAt: null,
        } as never);

        const response = await POST(
          buildPost(mockDriveId, {
            userId: 'temp_user_id',
            role: 'MEMBER',
            permissions: [{ pageId: 'page_1', canView: true, canEdit: false, canShare: false }],
          }),
          createContext(mockDriveId)
        );

        expect(response.status).toBe(422);
        // Critically: nothing should have been written — no token, no member.
        expect(createMagicLinkToken).not.toHaveBeenCalled();
        expect(driveInviteRepository.createDriveMember).not.toHaveBeenCalled();
        expect(sendPendingDriveInvitationEmail).not.toHaveBeenCalled();
      });

      it('verified target preserves Epic 2 behavior (auto-accept add path)', async () => {
        // findUserVerificationStatusById defaults to a verified user in beforeEach.
        const response = await POST(buildPost(mockDriveId, userIdBody), createContext(mockDriveId));
        const json = await response.json();

        expect(response.status).toBe(200);
        expect(json.kind).toBe('added');
        expect(driveInviteRepository.createAcceptedMemberWithPermissions).toHaveBeenCalledTimes(1);
      });
    });
  });

  // ==========================================================================
  // Email payload — new feature
  // ==========================================================================

  describe('email payload', () => {
    it('falls through to add path when email maps to verified user with no pending row', async () => {
      vi.mocked(driveInviteRepository.findUserIdByEmail).mockResolvedValue({
        id: 'user_existing_verified',
        emailVerified: new Date(),
        suspendedAt: null,
      } as never);
      vi.mocked(driveInviteRepository.findExistingMember).mockResolvedValue(null as never);

      const response = await POST(
        buildPost(mockDriveId, { email: 'verified@example.com', role: 'MEMBER', permissions: [] }),
        createContext(mockDriveId)
      );
      const json = await response.json();

      expect(response.status).toBe(200);
      expect(json.kind).toBe('added');
      expect(createMagicLinkToken).not.toHaveBeenCalled();
      expect(sendPendingDriveInvitationEmail).not.toHaveBeenCalled();
    });

    it('creates pending member + magic link + email when email maps to no user', async () => {
      vi.mocked(driveInviteRepository.findUserIdByEmail).mockResolvedValue(null as never);

      const response = await POST(
        buildPost(mockDriveId, { email: 'newbie@example.com', role: 'MEMBER', permissions: [] }),
        createContext(mockDriveId)
      );
      const json = await response.json();

      expect(response.status).toBe(200);
      expect(json.kind).toBe('invited');
      expect(json.email).toBe('newbie@example.com');

      expect(createMagicLinkToken).toHaveBeenCalledWith({
        email: 'newbie@example.com',
        expiryMinutes: 60 * 24 * 7,
      });
      expect(driveInviteRepository.createDriveMember).toHaveBeenCalledWith(
        expect.objectContaining({
          driveId: mockDriveId,
          role: 'MEMBER',
          acceptedAt: null,
        })
      );
      expect(sendPendingDriveInvitationEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          recipientEmail: 'newbie@example.com',
          driveName: 'Test Drive',
          magicLinkUrl: expect.stringContaining('https://app.example.com/api/auth/magic-link/verify?token='),
        })
      );
    });

    it('routes unverified existing user (emailVerified: null) through invitation flow, not auto-accept', async () => {
      vi.mocked(driveInviteRepository.findUserIdByEmail).mockResolvedValue({
        id: 'orphan_user',
        emailVerified: null,
        suspendedAt: null,
      } as never);

      const response = await POST(
        buildPost(mockDriveId, { email: 'orphan@example.com', role: 'MEMBER', permissions: [] }),
        createContext(mockDriveId)
      );
      const json = await response.json();

      expect(response.status).toBe(200);
      expect(json.kind).toBe('invited');
      expect(createMagicLinkToken).toHaveBeenCalledWith({
        email: 'orphan@example.com',
        expiryMinutes: 60 * 24 * 7,
      });
      expect(sendPendingDriveInvitationEmail).toHaveBeenCalledWith(
        expect.objectContaining({ recipientEmail: 'orphan@example.com' })
      );
    });

    it('returns 409 when email maps to a verified user already accepted in the drive', async () => {
      vi.mocked(driveInviteRepository.findUserIdByEmail).mockResolvedValue({
        id: 'already_member',
        emailVerified: new Date(),
        suspendedAt: null,
      } as never);
      vi.mocked(driveInviteRepository.findExistingMember).mockResolvedValue({
        id: 'mem_already_accepted',
        userId: 'already_member',
        acceptedAt: new Date('2026-01-01'),
      } as never);

      const response = await POST(
        buildPost(mockDriveId, { email: 'existing@example.com', role: 'MEMBER', permissions: [] }),
        createContext(mockDriveId)
      );
      const json = await response.json();

      expect(response.status).toBe(409);
      expect(json.existingMemberId).toBe('mem_already_accepted');
      expect(driveInviteRepository.createAcceptedMemberWithPermissions).not.toHaveBeenCalled();
      expect(driveInviteRepository.updateDriveMemberRole).not.toHaveBeenCalled();
    });

    it('returns 409 with existingMemberId when active pending row exists', async () => {
      vi.mocked(driveInviteRepository.findActivePendingMemberByEmail).mockResolvedValue({
        id: 'mem_pending_existing',
      } as never);

      const response = await POST(
        buildPost(mockDriveId, { email: 'pending@example.com', role: 'MEMBER', permissions: [] }),
        createContext(mockDriveId)
      );
      const json = await response.json();

      expect(response.status).toBe(409);
      expect(json.existingMemberId).toBe('mem_pending_existing');
      expect(createMagicLinkToken).not.toHaveBeenCalled();
      expect(sendPendingDriveInvitationEmail).not.toHaveBeenCalled();
    });

    it('returns 403 when email maps to a suspended verified user (does NOT bypass via fall-through)', async () => {
      vi.mocked(driveInviteRepository.findUserIdByEmail).mockResolvedValue({
        id: 'suspended_verified_user',
        emailVerified: new Date(),
        suspendedAt: new Date('2026-01-01'),
      } as never);

      const response = await POST(
        buildPost(mockDriveId, { email: 'banned@example.com', role: 'MEMBER', permissions: [] }),
        createContext(mockDriveId)
      );

      expect(response.status).toBe(403);
      // Critical: must NOT have inserted a member row for the suspended user.
      expect(driveInviteRepository.createAcceptedMemberWithPermissions).not.toHaveBeenCalled();
      expect(driveInviteRepository.createDriveMember).not.toHaveBeenCalled();
    });

    it('returns 403 when email maps to a suspended unverified user', async () => {
      vi.mocked(driveInviteRepository.findUserIdByEmail).mockResolvedValue({
        id: 'suspended_unverified_user',
        emailVerified: null,
        suspendedAt: new Date('2026-01-01'),
      } as never);

      const response = await POST(
        buildPost(mockDriveId, { email: 'orphan-suspended@example.com', role: 'MEMBER', permissions: [] }),
        createContext(mockDriveId)
      );

      expect(response.status).toBe(403);
      expect(createMagicLinkToken).not.toHaveBeenCalled();
    });

    it('rejects 422 when permissions array is non-empty on the email-pending path', async () => {
      vi.mocked(driveInviteRepository.findUserIdByEmail).mockResolvedValue(null as never);

      const response = await POST(
        buildPost(mockDriveId, {
          email: 'newbie@example.com',
          role: 'MEMBER',
          permissions: [{ pageId: 'page_1', canView: true, canEdit: false, canShare: false }],
        }),
        createContext(mockDriveId)
      );

      expect(response.status).toBe(422);
      // Must not have created a token or member when we reject the request.
      expect(createMagicLinkToken).not.toHaveBeenCalled();
      expect(driveInviteRepository.createDriveMember).not.toHaveBeenCalled();
      expect(sendPendingDriveInvitationEmail).not.toHaveBeenCalled();
    });

    it('rolls back the pending member row when sendPendingDriveInvitationEmail throws', async () => {
      vi.mocked(driveInviteRepository.findUserIdByEmail).mockResolvedValue(null as never);
      vi.mocked(driveInviteRepository.createDriveMember).mockResolvedValue({
        id: 'mem_pending_rollback',
      } as never);
      vi.mocked(sendPendingDriveInvitationEmail).mockRejectedValueOnce(new Error('SMTP unreachable'));

      const response = await POST(
        buildPost(mockDriveId, { email: 'smtp-fail@example.com', role: 'MEMBER', permissions: [] }),
        createContext(mockDriveId)
      );

      expect(response.status).toBe(502);
      expect(driveInviteRepository.deleteDriveMemberById).toHaveBeenCalledWith('mem_pending_rollback');
    });

    it('preserves sourceEmail in the audit record when fall-through occurs', async () => {
      vi.mocked(driveInviteRepository.findUserIdByEmail).mockResolvedValue({
        id: 'user_existing_verified',
        emailVerified: new Date(),
        suspendedAt: null,
      } as never);
      vi.mocked(driveInviteRepository.findExistingMember).mockResolvedValue(null as never);

      await POST(
        buildPost(mockDriveId, { email: 'fall-through@example.com', role: 'MEMBER', permissions: [] }),
        createContext(mockDriveId)
      );

      expect(auditRequest).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          eventType: 'authz.permission.granted',
          details: expect.objectContaining({
            targetUserId: 'user_existing_verified',
            sourceEmail: 'fall-through@example.com',
          }),
        })
      );
    });

    it('normalizes email to lowercase + trim before lookup AND storage', async () => {
      vi.mocked(driveInviteRepository.findUserIdByEmail).mockResolvedValue(null as never);

      await POST(
        buildPost(mockDriveId, { email: '  Foo@Example.COM  ', role: 'MEMBER', permissions: [] }),
        createContext(mockDriveId)
      );

      expect(driveInviteRepository.findActivePendingMemberByEmail).toHaveBeenCalledWith(
        mockDriveId,
        'foo@example.com'
      );
      expect(driveInviteRepository.findUserIdByEmail).toHaveBeenCalledWith('foo@example.com');
      expect(createMagicLinkToken).toHaveBeenCalledWith({
        email: 'foo@example.com',
        expiryMinutes: 60 * 24 * 7,
      });
      expect(sendPendingDriveInvitationEmail).toHaveBeenCalledWith(
        expect.objectContaining({ recipientEmail: 'foo@example.com' })
      );
    });
  });

  // ==========================================================================
  // Rate limiting
  // ==========================================================================

  describe('rate limiting', () => {
    it('returns 429 with Retry-After: 900 when global per-email limit exceeded', async () => {
      vi.mocked(driveInviteRepository.findUserIdByEmail).mockResolvedValue(null as never);
      // Dispatch by key prefix instead of call order so the test doesn't break
      // if the route reorders its rate-limit calls.
      vi.mocked(checkDistributedRateLimit).mockImplementation(async (key) => {
        if (key.startsWith('drive_invite:email:')) {
          return { allowed: false, retryAfter: 900 };
        }
        return { allowed: true };
      });

      const response = await POST(
        buildPost(mockDriveId, { email: 'spam@example.com', role: 'MEMBER', permissions: [] }),
        createContext(mockDriveId)
      );
      expect(response.status).toBe(429);
      expect(response.headers.get('Retry-After')).toBe('900');
    });

    it('returns 429 with Retry-After: 900 when (driveId, email) pair limit exceeded', async () => {
      vi.mocked(checkDistributedRateLimit).mockImplementation(async (key) => {
        if (key.startsWith('drive_invite:drive:')) {
          return { allowed: false, retryAfter: 900 };
        }
        return { allowed: true };
      });

      const response = await POST(
        buildPost(mockDriveId, { email: 'spam@example.com', role: 'MEMBER', permissions: [] }),
        createContext(mockDriveId)
      );
      expect(response.status).toBe(429);
      expect(response.headers.get('Retry-After')).toBe('900');
    });

    it('uses drive_invite:drive: and drive_invite:email: key prefixes', async () => {
      vi.mocked(driveInviteRepository.findUserIdByEmail).mockResolvedValue(null as never);

      await POST(
        buildPost(mockDriveId, { email: 'foo@example.com', role: 'MEMBER', permissions: [] }),
        createContext(mockDriveId)
      );

      const calls = vi.mocked(checkDistributedRateLimit).mock.calls.map((c) => c[0]);
      expect(calls).toEqual(
        expect.arrayContaining([
          `drive_invite:drive:${mockDriveId}:foo@example.com`,
          'drive_invite:email:foo@example.com',
        ])
      );
    });

    it('returns 403 (not 500) when createMagicLinkToken returns USER_SUSPENDED', async () => {
      vi.mocked(driveInviteRepository.findUserIdByEmail).mockResolvedValue(null as never);
      vi.mocked(createMagicLinkToken).mockResolvedValue({
        ok: false,
        error: { code: 'USER_SUSPENDED', userId: 'suspended_user' },
      } as never);

      const response = await POST(
        buildPost(mockDriveId, { email: 'suspended@example.com', role: 'MEMBER', permissions: [] }),
        createContext(mockDriveId)
      );
      expect(response.status).toBe(403);
    });
  });

  // ==========================================================================
  // Boundary obligations
  // ==========================================================================

  describe('boundary obligations', () => {
    it('broadcasts member_added on fresh accepted join (userId path)', async () => {
      await POST(buildPost(mockDriveId, userIdBody), createContext(mockDriveId));

      expect(createDriveMemberEventPayload).toHaveBeenCalledWith(
        mockDriveId,
        mockInvitedUserId,
        'member_added',
        { role: 'MEMBER', driveName: 'Test Drive' }
      );
      expect(broadcastDriveMemberEvent).toHaveBeenCalledTimes(1);
    });

    it('broadcasts to drive recipients when others are present', async () => {
      vi.mocked(getDriveRecipientUserIds).mockResolvedValue(['admin_a', 'admin_b', mockInvitedUserId]);

      await POST(buildPost(mockDriveId, userIdBody), createContext(mockDriveId));

      // Excludes the just-joined invitee — they get the direct broadcast above.
      expect(broadcastDriveMemberEventToRecipients).toHaveBeenCalledWith(
        expect.any(Object),
        ['admin_a', 'admin_b']
      );
    });

    it('does NOT broadcast member_added on pending email path (no user joined yet)', async () => {
      vi.mocked(driveInviteRepository.findUserIdByEmail).mockResolvedValue(null as never);

      await POST(
        buildPost(mockDriveId, { email: 'pending@example.com', role: 'MEMBER', permissions: [] }),
        createContext(mockDriveId)
      );

      expect(broadcastDriveMemberEvent).not.toHaveBeenCalled();
      expect(broadcastDriveMemberEventToRecipients).not.toHaveBeenCalled();
    });

    it('does NOT broadcast member_added on pure role update for accepted member', async () => {
      vi.mocked(driveInviteRepository.findExistingMember).mockResolvedValue({
        id: 'mem_existing',
        userId: mockInvitedUserId,
        acceptedAt: new Date(),
      } as never);

      const response = await POST(buildPost(mockDriveId, userIdBody), createContext(mockDriveId));

      expect(response.status).toBe(200);
      expect(broadcastDriveMemberEvent).not.toHaveBeenCalled();
      expect(broadcastDriveMemberEventToRecipients).not.toHaveBeenCalled();
    });

    it('sends in-app drive notification on fresh accepted join', async () => {
      await POST(buildPost(mockDriveId, userIdBody), createContext(mockDriveId));

      expect(createDriveNotification).toHaveBeenCalledWith(
        mockInvitedUserId,
        mockDriveId,
        'invited',
        'MEMBER',
        mockUserId
      );
    });

    it('does NOT send in-app drive notification on pending email path', async () => {
      vi.mocked(driveInviteRepository.findUserIdByEmail).mockResolvedValue(null as never);

      await POST(
        buildPost(mockDriveId, { email: 'pending@example.com', role: 'MEMBER', permissions: [] }),
        createContext(mockDriveId)
      );

      expect(createDriveNotification).not.toHaveBeenCalled();
    });

    it('emits authz.permission.granted on userId-path success', async () => {
      await POST(buildPost(mockDriveId, userIdBody), createContext(mockDriveId));

      expect(auditRequest).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          eventType: 'authz.permission.granted',
          userId: mockUserId,
          resourceType: 'drive',
          resourceId: mockDriveId,
        })
      );
    });

    it('emits authz.permission.granted on email-path success', async () => {
      vi.mocked(driveInviteRepository.findUserIdByEmail).mockResolvedValue(null as never);

      await POST(
        buildPost(mockDriveId, { email: 'newbie@example.com', role: 'MEMBER', permissions: [] }),
        createContext(mockDriveId)
      );

      expect(auditRequest).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          eventType: 'authz.permission.granted',
          userId: mockUserId,
          resourceType: 'drive',
          resourceId: mockDriveId,
          details: expect.objectContaining({ targetEmail: 'newbie@example.com', pending: true }),
        })
      );
    });

    it('logs member activity with target email + magic-link-userId on email path', async () => {
      vi.mocked(driveInviteRepository.findUserIdByEmail).mockResolvedValue(null as never);

      await POST(
        buildPost(mockDriveId, { email: 'newbie@example.com', role: 'MEMBER', permissions: [] }),
        createContext(mockDriveId)
      );

      expect(logMemberActivity).toHaveBeenCalledWith(
        mockUserId,
        'member_add',
        expect.objectContaining({
          driveId: mockDriveId,
          driveName: 'Test Drive',
          targetUserId: 'user_pending',
          targetUserEmail: 'newbie@example.com',
          role: 'MEMBER',
        }),
        expect.any(Object)
      );
    });

    it('tracks invite_member operation', async () => {
      await POST(buildPost(mockDriveId, userIdBody), createContext(mockDriveId));
      expect(trackDriveOperation).toHaveBeenCalledWith(
        mockUserId,
        'invite_member',
        mockDriveId,
        expect.objectContaining({ invitedUserId: mockInvitedUserId, role: 'MEMBER' })
      );
    });
  });

  // ==========================================================================
  // Transactional integrity (the gap PR #1229 missed)
  // ==========================================================================

  describe('transactional integrity', () => {
    it('does not return a memberId when the transactional insert throws', async () => {
      vi.mocked(driveInviteRepository.createAcceptedMemberWithPermissions).mockRejectedValueOnce(
        new Error('pagePermissions insert failed inside tx')
      );

      const response = await POST(buildPost(mockDriveId, userIdBody), createContext(mockDriveId));
      const json = await response.json();

      expect(response.status).toBe(500);
      expect(json.memberId).toBeUndefined();
    });

    it('uses the transactional repository helper, not the bare insert sequence', async () => {
      await POST(buildPost(mockDriveId, userIdBody), createContext(mockDriveId));

      expect(driveInviteRepository.createAcceptedMemberWithPermissions).toHaveBeenCalledTimes(1);
      expect(driveInviteRepository.createPagePermission).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // appUrl env validation
  // ==========================================================================

  describe('appUrl env validation', () => {
    it('returns 500 (does not send email) when both WEB_APP_URL and NEXT_PUBLIC_APP_URL unset', async () => {
      delete process.env.WEB_APP_URL;
      delete process.env.NEXT_PUBLIC_APP_URL;
      vi.mocked(driveInviteRepository.findUserIdByEmail).mockResolvedValue(null as never);

      const response = await POST(
        buildPost(mockDriveId, { email: 'foo@example.com', role: 'MEMBER', permissions: [] }),
        createContext(mockDriveId)
      );

      expect(response.status).toBe(500);
      expect(sendPendingDriveInvitationEmail).not.toHaveBeenCalled();
      expect(createMagicLinkToken).not.toHaveBeenCalled();
    });

    it('falls back to NEXT_PUBLIC_APP_URL when only that is set', async () => {
      delete process.env.WEB_APP_URL;
      process.env.NEXT_PUBLIC_APP_URL = 'https://fallback.example.com';
      vi.mocked(driveInviteRepository.findUserIdByEmail).mockResolvedValue(null as never);

      await POST(
        buildPost(mockDriveId, { email: 'foo@example.com', role: 'MEMBER', permissions: [] }),
        createContext(mockDriveId)
      );

      expect(sendPendingDriveInvitationEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          magicLinkUrl: expect.stringContaining('https://fallback.example.com/'),
        })
      );
    });
  });

});
