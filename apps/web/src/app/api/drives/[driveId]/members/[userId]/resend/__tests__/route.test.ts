import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

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

vi.mock('@pagespace/lib/auth/magic-link-service', () => ({
  createMagicLinkToken: vi.fn(),
  INVITATION_LINK_EXPIRY_MINUTES: 60 * 24 * 7,
}));

vi.mock('@pagespace/lib/services/notification-email-service', () => ({
  sendPendingDriveInvitationEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: vi.fn(),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));

import { POST } from '../route';
import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { isEmailVerified } from '@pagespace/lib/auth/verification-utils';
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

const createContext = (driveId: string, userId: string) => ({
  params: Promise.resolve({ driveId, userId }),
});

const createResendRequest = (driveId: string, userId: string) =>
  new Request(`https://example.com/api/drives/${driveId}/members/${userId}/resend`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });

const inviterId = 'user_inviter';
const driveId = 'drive_xyz';
const targetUserId = 'user_pending';
const drive = { id: driveId, name: 'Test Drive', ownerId: inviterId };

describe('POST /api/drives/[driveId]/members/[userId]/resend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(inviterId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(driveInviteRepository.findDriveById).mockResolvedValue(drive as never);
    vi.mocked(driveInviteRepository.findAdminMembership).mockResolvedValue(null as never);
    vi.mocked(driveInviteRepository.findExistingMember).mockResolvedValue({
      id: 'mem_pending',
      userId: targetUserId,
      acceptedAt: null,
    } as never);
    vi.mocked(driveInviteRepository.findUserEmail).mockResolvedValue('pending@example.com');
    vi.mocked(driveInviteRepository.findInviterDisplay).mockResolvedValue({
      name: 'Inviter Name',
      email: 'inviter@example.com',
    });
    vi.mocked(driveInviteRepository.bumpInvitedAt).mockResolvedValue(undefined);
    vi.mocked(createMagicLinkToken).mockResolvedValue({
      ok: true,
      data: { token: 'ps_magic_resend_token', userId: targetUserId, isNewUser: false },
    });
    vi.mocked(checkDistributedRateLimit).mockResolvedValue({ allowed: true, attemptsRemaining: 2 });
  });

  it('given a pending row, issues a fresh magic-link token and sends a new invitation email', async () => {
    const response = await POST(
      createResendRequest(driveId, targetUserId),
      createContext(driveId, targetUserId)
    );

    expect(response.status).toBe(200);
    expect(createMagicLinkToken).toHaveBeenCalledWith(expect.objectContaining({ email: 'pending@example.com' }));
    expect(sendPendingDriveInvitationEmail).toHaveBeenCalledTimes(1);
    const call = vi.mocked(sendPendingDriveInvitationEmail).mock.calls[0][0];
    expect(call.recipientEmail).toBe('pending@example.com');
    expect(call.driveName).toBe('Test Drive');
    expect(call.magicLinkUrl).toContain('token=ps_magic_resend_token');
    expect(call.magicLinkUrl).toContain(`inviteDriveId=${driveId}`);
  });

  it('given resend success, bumps invitedAt so the members UI can show "last sent N minutes ago"', async () => {
    await POST(
      createResendRequest(driveId, targetUserId),
      createContext(driveId, targetUserId)
    );

    expect(driveInviteRepository.bumpInvitedAt).toHaveBeenCalledWith('mem_pending');
  });

  it('given a row whose acceptedAt is set, responds 400 — already accepted, nothing to resend', async () => {
    vi.mocked(driveInviteRepository.findExistingMember).mockResolvedValue({
      id: 'mem_accepted',
      userId: targetUserId,
      acceptedAt: new Date(),
    } as never);

    const response = await POST(
      createResendRequest(driveId, targetUserId),
      createContext(driveId, targetUserId)
    );

    expect(response.status).toBe(400);
    expect(createMagicLinkToken).not.toHaveBeenCalled();
    expect(sendPendingDriveInvitationEmail).not.toHaveBeenCalled();
  });

  it('given more than 3 resend attempts on the same row within 24 hours, responds 429', async () => {
    vi.mocked(checkDistributedRateLimit).mockResolvedValue({
      allowed: false,
      retryAfter: 3600,
      attemptsRemaining: 0,
    });

    const response = await POST(
      createResendRequest(driveId, targetUserId),
      createContext(driveId, targetUserId)
    );

    expect(response.status).toBe(429);
    expect(createMagicLinkToken).not.toHaveBeenCalled();
    expect(sendPendingDriveInvitationEmail).not.toHaveBeenCalled();
  });

  it('given the rate limit key, scopes per-row (drive + userId combination)', async () => {
    await POST(
      createResendRequest(driveId, targetUserId),
      createContext(driveId, targetUserId)
    );

    const key = vi.mocked(checkDistributedRateLimit).mock.calls[0][0];
    expect(key).toContain(driveId);
    expect(key).toContain(targetUserId);
  });

  it('given the user is not authenticated, returns 401 without attempting any side effects', async () => {
    vi.mocked(isAuthError).mockReturnValue(true);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthErrorResponse(401));

    const response = await POST(
      createResendRequest(driveId, targetUserId),
      createContext(driveId, targetUserId)
    );

    expect(response.status).toBe(401);
    expect(createMagicLinkToken).not.toHaveBeenCalled();
    expect(driveInviteRepository.bumpInvitedAt).not.toHaveBeenCalled();
  });

  it('given the caller has not verified their email, responds 403 with requiresEmailVerification', async () => {
    vi.mocked(isEmailVerified).mockResolvedValueOnce(false);

    const response = await POST(
      createResendRequest(driveId, targetUserId),
      createContext(driveId, targetUserId)
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.requiresEmailVerification).toBe(true);
    expect(createMagicLinkToken).not.toHaveBeenCalled();
    expect(driveInviteRepository.bumpInvitedAt).not.toHaveBeenCalled();
  });

  it('given the caller is neither owner nor admin of the drive, responds 403', async () => {
    vi.mocked(driveInviteRepository.findDriveById).mockResolvedValue({
      ...drive,
      ownerId: 'someone_else',
    } as never);
    vi.mocked(driveInviteRepository.findAdminMembership).mockResolvedValue(null as never);

    const response = await POST(
      createResendRequest(driveId, targetUserId),
      createContext(driveId, targetUserId)
    );

    expect(response.status).toBe(403);
  });

  it('given the target user has no email on file, responds 404', async () => {
    vi.mocked(driveInviteRepository.findUserEmail).mockResolvedValue(undefined);

    const response = await POST(
      createResendRequest(driveId, targetUserId),
      createContext(driveId, targetUserId)
    );

    expect(response.status).toBe(404);
  });
});
