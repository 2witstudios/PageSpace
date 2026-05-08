import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for POST /api/pages/[pageId]/share-invite
//
// Mocks the pageInviteRepository seam, the email helper, the rate limiter,
// the permission check, and the auth layer. No ORM chain mocking.
// ============================================================================

vi.mock('@/lib/repositories/page-invite-repository', () => ({
  pageInviteRepository: {
    findPageById: vi.fn(),
    findUserIdByEmail: vi.fn(),
    findActivePendingInviteByPageAndEmail: vi.fn(),
    findInviterDisplay: vi.fn(),
    createPendingInvite: vi.fn(),
    deletePendingInvite: vi.fn(),
    createDirectPagePermission: vi.fn(),
  },
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib/auth/verification-utils', () => ({
  isEmailVerified: vi.fn().mockResolvedValue(true),
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  canUserSharePage: vi.fn().mockResolvedValue(true),
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

vi.mock('@pagespace/lib/monitoring/activity-tracker', () => ({
  trackPageOperation: vi.fn(),
}));

vi.mock('@pagespace/lib/auth/invite-token', () => ({
  createInviteToken: vi.fn(),
}));

vi.mock('@pagespace/lib/services/notification-email-service', () => ({
  sendPendingPageShareInvitationEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  DISTRIBUTED_RATE_LIMITS: { PAGE_SHARE_INVITE: { maxAttempts: 3, windowMs: 900000 } },
}));

import { POST } from '../route';
import { pageInviteRepository } from '@/lib/repositories/page-invite-repository';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { isEmailVerified } from '@pagespace/lib/auth/verification-utils';
import { canUserSharePage } from '@pagespace/lib/permissions/permissions';
import { createInviteToken } from '@pagespace/lib/auth/invite-token';
import { sendPendingPageShareInvitationEmail } from '@pagespace/lib/services/notification-email-service';
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

const createContext = (pageId: string) => ({
  params: Promise.resolve({ pageId }),
});

const buildPost = (pageId: string, body: unknown) =>
  new Request(`https://example.com/api/pages/${pageId}/share-invite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const ORIGINAL_ENV = { ...process.env };

const mockUserId = 'user_123';
const mockPageId = 'page_abc';
const mockPage = {
  id: mockPageId,
  title: 'My Test Page',
  driveId: 'drive_xyz',
  driveName: 'Test Drive',
};

const validBody = {
  email: 'new@example.com',
  permissions: ['VIEW'],
};

describe('POST /api/pages/[pageId]/share-invite', () => {
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
    vi.mocked(canUserSharePage).mockResolvedValue(true);

    vi.mocked(pageInviteRepository.findPageById).mockResolvedValue(mockPage);
    vi.mocked(pageInviteRepository.findUserIdByEmail).mockResolvedValue(null);
    vi.mocked(pageInviteRepository.findActivePendingInviteByPageAndEmail).mockResolvedValue(null);
    vi.mocked(pageInviteRepository.findInviterDisplay).mockResolvedValue({
      name: 'Inviter Name',
      email: 'inviter@example.com',
    });
    vi.mocked(pageInviteRepository.createPendingInvite).mockResolvedValue({ id: 'inv_pending' } as never);
    vi.mocked(pageInviteRepository.deletePendingInvite).mockResolvedValue(undefined);
    vi.mocked(pageInviteRepository.createDirectPagePermission).mockResolvedValue({ id: 'perm_new' });

    vi.mocked(checkDistributedRateLimit).mockResolvedValue({ allowed: true });
    vi.mocked(createInviteToken).mockReturnValue({
      token: 'ps_invite_xyz',
      tokenHash: 'hash_xyz',
      expiresAt: new Date('2026-05-10T12:00:00.000Z'),
    });
    vi.mocked(sendPendingPageShareInvitationEmail).mockResolvedValue(undefined);
  });

  // ==========================================================================
  // Auth + authorization
  // ==========================================================================

  describe('auth + authorization', () => {
    it('returns 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthErrorResponse(401));

      const response = await POST(buildPost(mockPageId, validBody), createContext(mockPageId));
      expect(response.status).toBe(401);
    });

    it('returns 403 when inviter lacks canShare on the page', async () => {
      vi.mocked(canUserSharePage).mockResolvedValue(false);

      const response = await POST(buildPost(mockPageId, validBody), createContext(mockPageId));
      const json = await response.json();

      expect(response.status).toBe(403);
      expect(json.error).toMatch(/permission/i);
    });

    it('does not write any row when canShare check fails (R3)', async () => {
      vi.mocked(canUserSharePage).mockResolvedValue(false);

      await POST(buildPost(mockPageId, validBody), createContext(mockPageId));

      expect(pageInviteRepository.createPendingInvite).not.toHaveBeenCalled();
      expect(pageInviteRepository.createDirectPagePermission).not.toHaveBeenCalled();
    });

    it('returns 403 with requiresEmailVerification when inviter email unverified', async () => {
      vi.mocked(isEmailVerified).mockResolvedValue(false);

      const response = await POST(buildPost(mockPageId, validBody), createContext(mockPageId));
      const json = await response.json();

      expect(response.status).toBe(403);
      expect(json.requiresEmailVerification).toBe(true);
    });
  });

  // ==========================================================================
  // Input validation
  // ==========================================================================

  describe('input validation', () => {
    it('returns 400 for invalid JSON', async () => {
      const response = await POST(buildPost(mockPageId, '{not json'), createContext(mockPageId));
      expect(response.status).toBe(400);
    });

    it('returns 400 when email is missing', async () => {
      const response = await POST(
        buildPost(mockPageId, { permissions: ['VIEW'] }),
        createContext(mockPageId),
      );
      expect(response.status).toBe(400);
    });

    it('returns 400 when email is malformed', async () => {
      const response = await POST(
        buildPost(mockPageId, { email: 'not-an-email', permissions: ['VIEW'] }),
        createContext(mockPageId),
      );
      expect(response.status).toBe(400);
    });

    it('returns 400 when permissions contains DELETE (R5)', async () => {
      const response = await POST(
        buildPost(mockPageId, { email: 'new@example.com', permissions: ['VIEW', 'DELETE'] }),
        createContext(mockPageId),
      );
      expect(response.status).toBe(400);
    });

    it('returns 400 when permissions is empty (min 1)', async () => {
      const response = await POST(
        buildPost(mockPageId, { email: 'new@example.com', permissions: [] }),
        createContext(mockPageId),
      );
      expect(response.status).toBe(400);
    });
  });

  // ==========================================================================
  // Suspended target
  // ==========================================================================

  describe('suspended target account', () => {
    it('returns 403 when target email belongs to suspended user', async () => {
      vi.mocked(pageInviteRepository.findUserIdByEmail).mockResolvedValue({
        id: 'user_suspended',
        emailVerified: new Date('2026-01-01'),
        suspendedAt: new Date('2026-03-01'),
      });

      const response = await POST(buildPost(mockPageId, validBody), createContext(mockPageId));
      const json = await response.json();

      expect(response.status).toBe(403);
      expect(json.error).toMatch(/suspended/i);
    });
  });

  // ==========================================================================
  // Existing-user fast path (R1)
  // ==========================================================================

  describe('existing verified user fast path (R1)', () => {
    it('grants page permission directly without creating a pending invite row', async () => {
      vi.mocked(pageInviteRepository.findUserIdByEmail).mockResolvedValue({
        id: 'user_existing',
        emailVerified: new Date('2026-01-01'),
        suspendedAt: null,
      });

      const response = await POST(
        buildPost(mockPageId, { email: 'existing@example.com', permissions: ['VIEW', 'EDIT'] }),
        createContext(mockPageId),
      );
      const json = await response.json();

      expect(response.status).toBe(200);
      expect(json.kind).toBe('granted');
      expect(pageInviteRepository.createDirectPagePermission).toHaveBeenCalledWith(
        expect.objectContaining({
          pageId: mockPageId,
          userId: 'user_existing',
          canView: true,
          canEdit: true,
          canShare: false,
          grantedBy: mockUserId,
        }),
      );
      expect(pageInviteRepository.createPendingInvite).not.toHaveBeenCalled();
      expect(sendPendingPageShareInvitationEmail).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // New-user happy path (R2)
  // ==========================================================================

  describe('new user invite happy path (R2)', () => {
    it('creates pending invite, sends email, returns kind: invited', async () => {
      const response = await POST(buildPost(mockPageId, validBody), createContext(mockPageId));
      const json = await response.json();

      expect(response.status).toBe(200);
      expect(json.kind).toBe('invited');
      expect(json.email).toBe('new@example.com');
      expect(pageInviteRepository.createPendingInvite).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'new@example.com',
          pageId: mockPageId,
          permissions: ['VIEW'],
          invitedBy: mockUserId,
        }),
      );
      expect(sendPendingPageShareInvitationEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          recipientEmail: 'new@example.com',
          pageTitle: 'My Test Page',
          driveName: 'Test Drive',
        }),
      );
    });

    it('passes correct inviteUrl using WEB_APP_URL', async () => {
      await POST(buildPost(mockPageId, validBody), createContext(mockPageId));

      expect(sendPendingPageShareInvitationEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          inviteUrl: 'https://app.example.com/invite/ps_invite_xyz',
        }),
      );
    });
  });

  // ==========================================================================
  // Already-pending (409)
  // ==========================================================================

  describe('already pending invite (409)', () => {
    it('returns 409 when an active pending invite already exists', async () => {
      vi.mocked(pageInviteRepository.findActivePendingInviteByPageAndEmail).mockResolvedValue({
        id: 'inv_existing',
      });

      const response = await POST(buildPost(mockPageId, validBody), createContext(mockPageId));
      const json = await response.json();

      expect(response.status).toBe(409);
      expect(json.error).toMatch(/already pending/i);
    });
  });

  // ==========================================================================
  // Rate limiting (429)
  // ==========================================================================

  describe('rate limiting (429)', () => {
    it('returns 429 when inviter+email rate limit is exceeded', async () => {
      vi.mocked(checkDistributedRateLimit).mockResolvedValueOnce({
        allowed: false,
        retryAfter: 900,
      });

      const response = await POST(buildPost(mockPageId, validBody), createContext(mockPageId));
      expect(response.status).toBe(429);
    });

    it('returns 429 when global email rate limit is exceeded', async () => {
      vi.mocked(checkDistributedRateLimit)
        .mockResolvedValueOnce({ allowed: true })
        .mockResolvedValueOnce({ allowed: false, retryAfter: 900 });

      const response = await POST(buildPost(mockPageId, validBody), createContext(mockPageId));
      expect(response.status).toBe(429);
    });
  });

  // ==========================================================================
  // SMTP failure → compensating delete (R6)
  // ==========================================================================

  describe('SMTP failure rollback (R6)', () => {
    it('deletes the pending invite row when email send fails', async () => {
      vi.mocked(sendPendingPageShareInvitationEmail).mockRejectedValue(
        new Error('SMTP connection refused'),
      );

      const response = await POST(buildPost(mockPageId, validBody), createContext(mockPageId));
      const json = await response.json();

      expect(response.status).toBe(502);
      expect(json.error).toMatch(/invitation email/i);
      expect(pageInviteRepository.deletePendingInvite).toHaveBeenCalledWith('inv_pending');
    });

    it('still returns 502 even if rollback itself fails (logs the error)', async () => {
      vi.mocked(sendPendingPageShareInvitationEmail).mockRejectedValue(
        new Error('SMTP failure'),
      );
      vi.mocked(pageInviteRepository.deletePendingInvite).mockRejectedValue(
        new Error('DB error'),
      );

      const response = await POST(buildPost(mockPageId, validBody), createContext(mockPageId));
      expect(response.status).toBe(502);
    });
  });
});
