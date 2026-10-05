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
    findExistingPagePermission: vi.fn(),
  },
}));

// POL-2: the route asks the org's guests policy before granting or inviting. Default: a drive with no org, allowed.
const decideOrgDriveAdmission = vi.hoisted(() => vi.fn());
const requestGuestApproval = vi.hoisted(() => vi.fn());
const recordOrgAuditEvent = vi.hoisted(() => vi.fn());
vi.mock('@pagespace/lib/permissions/guest-admission', () => ({ decideOrgDriveAdmission }));
vi.mock('@pagespace/lib/permissions/guest-holds', () => ({ requestGuestApproval }));
vi.mock('@pagespace/lib/audit/org-audit', () => ({ recordOrgAuditEvent }));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib/services/drive-service', () => ({
  getDriveById: vi.fn(),
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

vi.mock('@/lib/websocket', () => ({
  broadcastPageEvent: vi.fn().mockResolvedValue(undefined),
  createPageEventPayload: vi.fn((driveId, pageId, operation) => ({ driveId, pageId, operation })),
}));

import { POST } from '../route';
import { pageInviteRepository } from '@/lib/repositories/page-invite-repository';
import { getDriveById } from '@pagespace/lib/services/drive-service';
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
    vi.mocked(pageInviteRepository.findExistingPagePermission).mockResolvedValue(null);
    decideOrgDriveAdmission.mockResolvedValue({ decision: 'allow', orgId: null });
    requestGuestApproval.mockImplementation(async (input: { origin: string }) => ({ holdId: 'hold_1', origin: input.origin }));
    recordOrgAuditEvent.mockResolvedValue(undefined);

    vi.mocked(checkDistributedRateLimit).mockResolvedValue({ allowed: true });
    vi.mocked(createInviteToken).mockReturnValue({
      token: 'ps_invite_xyz',
      tokenHash: 'hash_xyz',
      expiresAt: new Date('2026-05-10T12:00:00.000Z'),
    });
    vi.mocked(sendPendingPageShareInvitationEmail).mockResolvedValue(undefined);
    // Default: page's drive is standard (not Home)
    vi.mocked(getDriveById).mockResolvedValue({
      id: 'drive_xyz',
      name: 'Test Drive',
      slug: 'test-drive',
      ownerId: mockUserId,
      kind: 'STANDARD' as const,
      isTrashed: false,
      trashedAt: null,
      drivePrompt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      publishSubdomain: null,
    } as never);
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

    it('returns 400 when EDIT is requested without VIEW', async () => {
      const response = await POST(
        buildPost(mockPageId, { email: 'new@example.com', permissions: ['EDIT'] }),
        createContext(mockPageId),
      );
      expect(response.status).toBe(400);
    });

    it('returns 400 when SHARE is requested without VIEW', async () => {
      const response = await POST(
        buildPost(mockPageId, { email: 'new@example.com', permissions: ['SHARE'] }),
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

  // ==========================================================================
  // Home drive guard
  // ==========================================================================

  describe('Home drive page guard', () => {
    it('returns 403 when the page belongs to a Home drive', async () => {
      vi.mocked(getDriveById).mockResolvedValue({
        id: 'drive_xyz',
        name: 'Home',
        slug: 'home',
        ownerId: mockUserId,
        kind: 'HOME' as const,
        isTrashed: false,
        trashedAt: null,
        drivePrompt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        publishSubdomain: null,
      } as never);

      const response = await POST(buildPost(mockPageId, validBody), createContext(mockPageId));
      const json = await response.json();

      expect(response.status).toBe(403);
      expect(json.error).toMatch(/home/i);
    });

    it('does not create any invite row when the page is in a Home drive', async () => {
      vi.mocked(getDriveById).mockResolvedValue({
        id: 'drive_xyz',
        name: 'Home',
        slug: 'home',
        ownerId: mockUserId,
        kind: 'HOME' as const,
        isTrashed: false,
        trashedAt: null,
        drivePrompt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        publishSubdomain: null,
      } as never);

      await POST(buildPost(mockPageId, validBody), createContext(mockPageId));

      expect(pageInviteRepository.createPendingInvite).not.toHaveBeenCalled();
      expect(pageInviteRepository.createDirectPagePermission).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // The org's guests policy (POL-2)
  // ==========================================================================

  describe('the org guests policy', () => {
    const verified = () => vi.mocked(pageInviteRepository.findUserIdByEmail).mockResolvedValue({
      id: 'user_outside',
      emailVerified: new Date('2026-01-01'),
      suspendedAt: null,
    });

    it('POL-2 (partial) X-6 (partial) guests OFF: sharing with a verified outsider is refused naming the policy and NO grant is written', async () => {
      verified();
      decideOrgDriveAdmission.mockResolvedValue({ decision: 'refuse', orgId: 'org_1' });

      const response = await POST(buildPost(mockPageId, { email: 'out@example.com', permissions: ['VIEW'] }), createContext(mockPageId));

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'org_policy', policy: 'guests' });
      expect(decideOrgDriveAdmission).toHaveBeenCalledWith({ driveId: 'drive_xyz', userId: 'user_outside' });
      expect(pageInviteRepository.createDirectPagePermission).not.toHaveBeenCalled();
    });

    it('POL-2 (partial) X-6 (partial) guests OFF: an address with no account is refused BEFORE any invitation is stored or emailed', async () => {
      decideOrgDriveAdmission.mockResolvedValue({ decision: 'refuse', orgId: 'org_1' });

      const response = await POST(buildPost(mockPageId, validBody), createContext(mockPageId));

      expect(response.status).toBe(403);
      expect(decideOrgDriveAdmission).toHaveBeenCalledWith({ driveId: 'drive_xyz', userId: null });
      expect(pageInviteRepository.createPendingInvite).not.toHaveBeenCalled();
      expect(sendPendingPageShareInvitationEmail).not.toHaveBeenCalled();
    });

    it('POL-2 (partial) guests APPROVE: a verified outsider is queued as a page grant (202) with exactly what was asked; nothing granted', async () => {
      verified();
      decideOrgDriveAdmission.mockResolvedValue({ decision: 'hold', orgId: 'org_1' });

      const response = await POST(buildPost(mockPageId, { email: 'out@example.com', permissions: ['VIEW', 'EDIT'] }), createContext(mockPageId));

      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({ kind: 'pending_approval', holdId: 'hold_1' });
      expect(requestGuestApproval).toHaveBeenCalledWith({
        orgId: 'org_1',
        driveId: 'drive_xyz',
        userId: 'user_outside',
        origin: 'page_grant',
        request: { permissions: [{ pageId: mockPageId, canView: true, canEdit: true, canShare: false }], invitedBy: mockUserId },
        requestedBy: mockUserId,
      });
      expect(recordOrgAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org_1', eventType: 'org.guest.requested' }));
      expect(pageInviteRepository.createDirectPagePermission).not.toHaveBeenCalled();
    });

    it('POL-2 (partial) guests APPROVE: an address with no account is queued by email (202); no invitation row and no email until approved', async () => {
      decideOrgDriveAdmission.mockResolvedValue({ decision: 'hold', orgId: 'org_1' });

      const response = await POST(buildPost(mockPageId, { ...validBody, expiryDays: 7 }), createContext(mockPageId));

      expect(response.status).toBe(202);
      expect(requestGuestApproval).toHaveBeenCalledWith(expect.objectContaining({
        email: 'new@example.com',
        origin: 'page_invite',
        request: { pageId: mockPageId, permissions: [{ pageId: mockPageId, canView: true, canEdit: false, canShare: false }], expiryDays: 7, invitedBy: mockUserId },
      }));
      expect(pageInviteRepository.createPendingInvite).not.toHaveBeenCalled();
      expect(sendPendingPageShareInvitationEmail).not.toHaveBeenCalled();
    });

    it('POL-2 (partial) a verified account that already holds a grant on the page gains nothing, so the policy is not asked', async () => {
      verified();
      vi.mocked(pageInviteRepository.findExistingPagePermission).mockResolvedValue({ id: 'perm_old' });

      const response = await POST(buildPost(mockPageId, { email: 'out@example.com', permissions: ['VIEW'] }), createContext(mockPageId));

      expect(response.status).toBe(200);
      expect(decideOrgDriveAdmission).not.toHaveBeenCalled();
    });

    it('POL-2 (partial) guests turned OFF between the check and the write: the write refuses (null) and the route answers 403', async () => {
      verified();
      vi.mocked(pageInviteRepository.createDirectPagePermission).mockResolvedValue(null);

      const response = await POST(buildPost(mockPageId, { email: 'out@example.com', permissions: ['VIEW'] }), createContext(mockPageId));

      expect(response.status).toBe(403);
      expect(pageInviteRepository.createDirectPagePermission).toHaveBeenCalledWith(expect.objectContaining({ driveId: 'drive_xyz', userId: 'user_outside' }));
    });
  });
});
