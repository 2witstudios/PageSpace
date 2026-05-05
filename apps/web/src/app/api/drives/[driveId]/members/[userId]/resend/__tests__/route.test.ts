import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract tests for POST /api/drives/[driveId]/members/[userId]/resend
//
// Mocks the driveInviteRepository seam, magic-link service, email helper,
// and rate limiter. No ORM chain mocking — Drizzle is never poked here.
// ============================================================================

vi.mock('@/lib/repositories/drive-invite-repository', () => ({
  driveInviteRepository: {
    findDriveById: vi.fn(),
    findAdminMembership: vi.fn(),
    findExistingMember: vi.fn(),
    findUserEmail: vi.fn(),
    findInviterDisplay: vi.fn(),
    bumpInvitedAt: vi.fn(),
  },
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
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

vi.mock('@pagespace/lib/auth/magic-link-service', () => ({
  createMagicLinkToken: vi.fn(),
  INVITATION_LINK_EXPIRY_MINUTES: 60 * 24 * 7,
}));

vi.mock('@pagespace/lib/services/notification-email-service', () => ({
  sendPendingDriveInvitationEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  DISTRIBUTED_RATE_LIMITS: {
    DRIVE_INVITE_RESEND: {
      maxAttempts: 3,
      windowMs: 24 * 60 * 60 * 1000,
      blockDurationMs: 24 * 60 * 60 * 1000,
    },
  },
}));

import { POST } from '../route';
import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { isEmailVerified } from '@pagespace/lib/auth/verification-utils';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
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

const mockUserId = 'user_inviter';
const mockDriveId = 'drive_abc';
const mockTargetUserId = 'user_target';
const mockTargetEmail = 'target@example.com';

const mockDrive = {
  id: mockDriveId,
  name: 'Test Drive',
  slug: 'test-drive',
  ownerId: mockUserId,
};

const createContext = (driveId: string, userId: string) => ({
  params: Promise.resolve({ driveId, userId }),
});

const buildPost = (driveId: string, userId: string) =>
  new Request(`https://example.com/api/drives/${driveId}/members/${userId}/resend`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });

const ORIGINAL_ENV = { ...process.env };

describe('POST /api/drives/[driveId]/members/[userId]/resend', () => {
  afterEach(() => {
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
    vi.mocked(driveInviteRepository.findExistingMember).mockResolvedValue({
      id: 'mem_pending',
      userId: mockTargetUserId,
      acceptedAt: null,
    } as never);
    vi.mocked(driveInviteRepository.findUserEmail).mockResolvedValue(mockTargetEmail);
    vi.mocked(driveInviteRepository.findInviterDisplay).mockResolvedValue({
      name: 'Inviter Name',
      email: 'inviter@example.com',
    } as never);
    vi.mocked(driveInviteRepository.bumpInvitedAt).mockResolvedValue(undefined);

    vi.mocked(checkDistributedRateLimit).mockResolvedValue({ allowed: true });
    vi.mocked(createMagicLinkToken).mockResolvedValue({
      ok: true,
      data: { token: 'ps_magic_xyz', userId: mockTargetUserId, isNewUser: false },
    } as never);
  });

  describe('auth + authorization', () => {
    it('given an unauthenticated request, responds 401', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthErrorResponse(401));

      const response = await POST(
        buildPost(mockDriveId, mockTargetUserId),
        createContext(mockDriveId, mockTargetUserId)
      );
      expect(response.status).toBe(401);
    });

    it('given an inviter without verified email, responds 403 with requiresEmailVerification', async () => {
      vi.mocked(isEmailVerified).mockResolvedValue(false);

      const response = await POST(
        buildPost(mockDriveId, mockTargetUserId),
        createContext(mockDriveId, mockTargetUserId)
      );
      const json = await response.json();

      expect(response.status).toBe(403);
      expect(json.requiresEmailVerification).toBe(true);
    });

    it('given an inviter who is not owner/accepted-admin, responds 403 and emits authz.access.denied', async () => {
      vi.mocked(driveInviteRepository.findDriveById).mockResolvedValue({
        ...mockDrive,
        ownerId: 'someone_else',
      } as never);
      vi.mocked(driveInviteRepository.findAdminMembership).mockResolvedValue(null as never);

      const response = await POST(
        buildPost(mockDriveId, mockTargetUserId),
        createContext(mockDriveId, mockTargetUserId)
      );

      expect(response.status).toBe(403);
      expect(auditRequest).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ eventType: 'authz.access.denied' })
      );
    });

    it('given a pending admin (acceptedAt IS NULL), responds 403 — Epic 1 gate', async () => {
      vi.mocked(driveInviteRepository.findDriveById).mockResolvedValue({
        ...mockDrive,
        ownerId: 'someone_else',
      } as never);
      // findAdminMembership filters acceptedAt IS NOT NULL — pending admin returns null.
      vi.mocked(driveInviteRepository.findAdminMembership).mockResolvedValue(null as never);

      const response = await POST(
        buildPost(mockDriveId, mockTargetUserId),
        createContext(mockDriveId, mockTargetUserId)
      );
      expect(response.status).toBe(403);
    });

    it('given a non-existent drive, responds 404', async () => {
      vi.mocked(driveInviteRepository.findDriveById).mockResolvedValue(null as never);

      const response = await POST(
        buildPost(mockDriveId, mockTargetUserId),
        createContext(mockDriveId, mockTargetUserId)
      );
      expect(response.status).toBe(404);
    });
  });

  describe('state', () => {
    it('given a non-existent member, responds 404', async () => {
      vi.mocked(driveInviteRepository.findExistingMember).mockResolvedValue(null as never);

      const response = await POST(
        buildPost(mockDriveId, mockTargetUserId),
        createContext(mockDriveId, mockTargetUserId)
      );
      expect(response.status).toBe(404);
      expect(createMagicLinkToken).not.toHaveBeenCalled();
      expect(sendPendingDriveInvitationEmail).not.toHaveBeenCalled();
    });

    it('given a member who has already joined (acceptedAt set), responds 400', async () => {
      vi.mocked(driveInviteRepository.findExistingMember).mockResolvedValue({
        id: 'mem_already_accepted',
        userId: mockTargetUserId,
        acceptedAt: new Date('2026-01-01'),
      } as never);

      const response = await POST(
        buildPost(mockDriveId, mockTargetUserId),
        createContext(mockDriveId, mockTargetUserId)
      );
      expect(response.status).toBe(400);
      expect(createMagicLinkToken).not.toHaveBeenCalled();
      expect(sendPendingDriveInvitationEmail).not.toHaveBeenCalled();
    });

    it('given a pending member with no email on file, responds 404', async () => {
      vi.mocked(driveInviteRepository.findUserEmail).mockResolvedValue(undefined);

      const response = await POST(
        buildPost(mockDriveId, mockTargetUserId),
        createContext(mockDriveId, mockTargetUserId)
      );
      expect(response.status).toBe(404);
      expect(createMagicLinkToken).not.toHaveBeenCalled();
      expect(sendPendingDriveInvitationEmail).not.toHaveBeenCalled();
    });
  });

  describe('rate limiting', () => {
    it('given the (driveId, userId) limit exceeded, responds 429 with Retry-After and emits security.rate.limited', async () => {
      vi.mocked(checkDistributedRateLimit).mockResolvedValue({ allowed: false, retryAfter: 3600 });

      const response = await POST(
        buildPost(mockDriveId, mockTargetUserId),
        createContext(mockDriveId, mockTargetUserId)
      );

      expect(response.status).toBe(429);
      expect(response.headers.get('Retry-After')).toBe('3600');
      expect(auditRequest).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ eventType: 'security.rate.limited' })
      );
      expect(createMagicLinkToken).not.toHaveBeenCalled();
      expect(sendPendingDriveInvitationEmail).not.toHaveBeenCalled();
    });

    it('uses drive_invite_resend:${driveId}:${userId} as the rate-limit key', async () => {
      await POST(
        buildPost(mockDriveId, mockTargetUserId),
        createContext(mockDriveId, mockTargetUserId)
      );

      expect(checkDistributedRateLimit).toHaveBeenCalledWith(
        `drive_invite_resend:${mockDriveId}:${mockTargetUserId}`,
        expect.objectContaining({
          maxAttempts: 3,
          windowMs: 24 * 60 * 60 * 1000,
          blockDurationMs: 24 * 60 * 60 * 1000,
        })
      );
    });
  });

  describe('happy path', () => {
    it('given a valid pending member, mints a fresh magic-link token and sends the email with it', async () => {
      const response = await POST(
        buildPost(mockDriveId, mockTargetUserId),
        createContext(mockDriveId, mockTargetUserId)
      );
      const json = await response.json();

      expect(response.status).toBe(200);
      expect(json.success).toBe(true);

      expect(createMagicLinkToken).toHaveBeenCalledWith({
        email: mockTargetEmail,
        expiryMinutes: 60 * 24 * 7,
      });
      expect(sendPendingDriveInvitationEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          recipientEmail: mockTargetEmail,
          inviterName: 'Inviter Name',
          driveName: 'Test Drive',
          magicLinkUrl: expect.stringContaining(
            'https://app.example.com/api/auth/magic-link/verify?token=ps_magic_xyz'
          ),
        })
      );
    });

    it('given createMagicLinkToken returns USER_SUSPENDED, responds 403 and does NOT send email', async () => {
      vi.mocked(createMagicLinkToken).mockResolvedValue({
        ok: false,
        error: { code: 'USER_SUSPENDED', userId: mockTargetUserId },
      } as never);

      const response = await POST(
        buildPost(mockDriveId, mockTargetUserId),
        createContext(mockDriveId, mockTargetUserId)
      );

      expect(response.status).toBe(403);
      expect(sendPendingDriveInvitationEmail).not.toHaveBeenCalled();
      expect(driveInviteRepository.bumpInvitedAt).not.toHaveBeenCalled();
    });

    it('given a successful resend, calls bumpInvitedAt with the member id', async () => {
      await POST(
        buildPost(mockDriveId, mockTargetUserId),
        createContext(mockDriveId, mockTargetUserId)
      );

      expect(driveInviteRepository.bumpInvitedAt).toHaveBeenCalledWith('mem_pending');
    });

    it('given a successful resend, fires audit event data.share with operation: resend_invitation', async () => {
      await POST(
        buildPost(mockDriveId, mockTargetUserId),
        createContext(mockDriveId, mockTargetUserId)
      );

      expect(auditRequest).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          eventType: 'data.share',
          userId: mockUserId,
          resourceType: 'drive',
          resourceId: mockDriveId,
          details: expect.objectContaining({
            targetUserId: mockTargetUserId,
            operation: 'resend_invitation',
          }),
        })
      );
    });

    it('given the email send throws, responds 502 and does NOT bumpInvitedAt', async () => {
      vi.mocked(sendPendingDriveInvitationEmail).mockRejectedValueOnce(new Error('SMTP unreachable'));

      const response = await POST(
        buildPost(mockDriveId, mockTargetUserId),
        createContext(mockDriveId, mockTargetUserId)
      );

      expect(response.status).toBe(502);
      expect(driveInviteRepository.bumpInvitedAt).not.toHaveBeenCalled();
    });

    it('given an accepted-admin inviter (not owner), allows resend', async () => {
      vi.mocked(driveInviteRepository.findDriveById).mockResolvedValue({
        ...mockDrive,
        ownerId: 'someone_else',
      } as never);
      vi.mocked(driveInviteRepository.findAdminMembership).mockResolvedValue({
        id: 'mem_admin',
        role: 'ADMIN',
        acceptedAt: new Date('2025-01-01'),
      } as never);

      const response = await POST(
        buildPost(mockDriveId, mockTargetUserId),
        createContext(mockDriveId, mockTargetUserId)
      );

      expect(response.status).toBe(200);
      expect(sendPendingDriveInvitationEmail).toHaveBeenCalled();
    });
  });

  describe('appUrl env validation', () => {
    it('given neither WEB_APP_URL nor NEXT_PUBLIC_APP_URL is set, responds 500 and does NOT send email', async () => {
      delete process.env.WEB_APP_URL;
      delete process.env.NEXT_PUBLIC_APP_URL;

      const response = await POST(
        buildPost(mockDriveId, mockTargetUserId),
        createContext(mockDriveId, mockTargetUserId)
      );

      expect(response.status).toBe(500);
      expect(createMagicLinkToken).not.toHaveBeenCalled();
      expect(sendPendingDriveInvitationEmail).not.toHaveBeenCalled();
    });
  });
});
