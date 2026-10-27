import { describe, it, expect, beforeEach, vi } from 'vitest';

// ============================================================================
// Contract tests for POST /api/connections/invite
//
// Mocks the connectionInviteRepository seam, email service, rate limiter,
// and notification helper. No ORM chain mocking — Drizzle is never poked.
// ============================================================================

vi.mock('@/lib/repositories/connection-invite-repository', () => ({
  connectionInviteRepository: {
    findInviterDisplay: vi.fn(),
    findUserIdByEmail: vi.fn(),
    findExistingConnection: vi.fn(),
    findActivePendingInviteByOwnerAndEmail: vi.fn(),
    createPendingInvite: vi.fn(),
    deletePendingInvite: vi.fn(),
    createDirectConnection: vi.fn(),
  },
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: unknown) => result && typeof result === 'object' && 'error' in result),
}));

vi.mock('@pagespace/lib/auth/verification-utils', () => ({
  isEmailVerified: vi.fn().mockResolvedValue(true),
}));

vi.mock('@pagespace/lib/auth/invite-token', () => ({
  createInviteToken: vi.fn(),
}));

vi.mock('@pagespace/lib/services/notification-email-service', () => ({
  sendPendingConnectionInvitationEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  DISTRIBUTED_RATE_LIMITS: {
    CONNECTION_INVITE: { maxAttempts: 3, windowMs: 900000 },
  },
}));

vi.mock('@pagespace/lib/notifications/notifications', () => ({
  createNotification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

import { POST } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { isEmailVerified } from '@pagespace/lib/auth/verification-utils';
import { connectionInviteRepository } from '@/lib/repositories/connection-invite-repository';
import { createInviteToken } from '@pagespace/lib/auth/invite-token';
import { sendPendingConnectionInvitationEmail } from '@pagespace/lib/services/notification-email-service';
import { checkDistributedRateLimit } from '@pagespace/lib/security/distributed-rate-limit';
import { createNotification } from '@pagespace/lib/notifications/notifications';

const INVITER_USER_ID = 'user_inviter';
const TARGET_USER_ID = 'user_target';
const INVITER_EMAIL = 'inviter@example.com';
const TARGET_EMAIL = 'target@example.com';

const mockAuthSuccess = () => {
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
    userId: INVITER_USER_ID,
    tokenVersion: 0,
    tokenType: 'session' as const,
    sessionId: 'test-session',
    role: 'user' as const,
    adminRoleVersion: 0,
  });
};

const makeRequest = (body: unknown) =>
  new Request('http://localhost/api/connections/invite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /api/connections/invite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthSuccess();

    vi.mocked(isEmailVerified).mockResolvedValue(true);
    vi.mocked(connectionInviteRepository.findInviterDisplay).mockResolvedValue({
      name: 'Inviter User',
      email: INVITER_EMAIL,
    });
    vi.mocked(checkDistributedRateLimit).mockResolvedValue({ allowed: true });
    vi.mocked(connectionInviteRepository.findUserIdByEmail).mockResolvedValue(null);
    vi.mocked(connectionInviteRepository.findActivePendingInviteByOwnerAndEmail).mockResolvedValue(null);
    vi.mocked(createInviteToken).mockReturnValue({
      token: 'ps_invite_abc123',
      tokenHash: 'hash_abc123',
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
    });
    vi.mocked(connectionInviteRepository.createPendingInvite).mockResolvedValue({
      id: 'invite_123',
      tokenHash: 'hash_abc123',
      email: TARGET_EMAIL,
      invitedBy: INVITER_USER_ID,
      requestMessage: null,
      expiresAt: new Date(),
      consumedAt: null,
      createdAt: new Date(),
    });

    process.env.NEXT_PUBLIC_APP_URL = 'https://app.pagespace.ai';
  });

  describe('happy path — new user', () => {
    it('creates a pending invite row and sends an email', async () => {
      const res = await POST(makeRequest({ email: TARGET_EMAIL }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.kind).toBe('invited');
      expect(body.inviteId).toBe('invite_123');
      expect(connectionInviteRepository.createPendingInvite).toHaveBeenCalledWith(
        expect.objectContaining({
          email: TARGET_EMAIL,
          invitedBy: INVITER_USER_ID,
          requestMessage: null,
        })
      );
      expect(sendPendingConnectionInvitationEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          recipientEmail: TARGET_EMAIL,
          inviterName: 'Inviter User',
        })
      );
    });

    it('passes optional message through to both pending row and email', async () => {
      await POST(makeRequest({ email: TARGET_EMAIL, message: 'Hello!' }));

      expect(connectionInviteRepository.createPendingInvite).toHaveBeenCalledWith(
        expect.objectContaining({ requestMessage: 'Hello!' })
      );
      expect(sendPendingConnectionInvitationEmail).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Hello!' })
      );
    });
  });

  describe('existing verified user — fast path (R1)', () => {
    beforeEach(() => {
      vi.mocked(connectionInviteRepository.findUserIdByEmail).mockResolvedValue({
        id: TARGET_USER_ID,
        emailVerified: new Date('2024-01-01'),
        suspendedAt: null,
      });
      vi.mocked(connectionInviteRepository.findExistingConnection).mockResolvedValue(null);
      vi.mocked(connectionInviteRepository.createDirectConnection).mockResolvedValue({
        id: 'conn_abc',
      });
    });

    it('creates a PENDING connection directly, skips pending invite table', async () => {
      const res = await POST(makeRequest({ email: TARGET_EMAIL }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.kind).toBe('requested');
      expect(body.connectionId).toBe('conn_abc');
      expect(connectionInviteRepository.createPendingInvite).not.toHaveBeenCalled();
      expect(createNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: TARGET_USER_ID,
          type: 'CONNECTION_REQUEST',
        })
      );
    });
  });

  describe('inviter email not verified (R3)', () => {
    it('returns 403 with requiresEmailVerification flag', async () => {
      vi.mocked(isEmailVerified).mockResolvedValue(false);

      const res = await POST(makeRequest({ email: TARGET_EMAIL }));
      const body = await res.json();

      expect(res.status).toBe(403);
      expect(body.requiresEmailVerification).toBe(true);
    });
  });

  describe('self-invite (R5)', () => {
    it('returns 400 when inviting own email', async () => {
      const res = await POST(makeRequest({ email: INVITER_EMAIL }));
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toBe('Cannot connect with yourself');
    });
  });

  describe('suspended target account', () => {
    it('returns 403 when target account is suspended', async () => {
      vi.mocked(connectionInviteRepository.findUserIdByEmail).mockResolvedValue({
        id: TARGET_USER_ID,
        emailVerified: new Date('2024-01-01'),
        suspendedAt: new Date('2025-01-01'),
      });

      const res = await POST(makeRequest({ email: TARGET_EMAIL }));
      const body = await res.json();

      expect(res.status).toBe(403);
      expect(body.error).toMatch(/suspended/i);
    });
  });

  describe('already-pending invite', () => {
    it('returns 409 when an active pending invite already exists', async () => {
      vi.mocked(connectionInviteRepository.findActivePendingInviteByOwnerAndEmail).mockResolvedValue(
        { id: 'existing_invite_123' }
      );

      const res = await POST(makeRequest({ email: TARGET_EMAIL }));
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body.error).toMatch(/already pending/i);
    });
  });

  describe('already-connected fast-path', () => {
    it('returns 400 when a PENDING connection row exists', async () => {
      vi.mocked(connectionInviteRepository.findUserIdByEmail).mockResolvedValue({
        id: TARGET_USER_ID,
        emailVerified: new Date('2024-01-01'),
        suspendedAt: null,
      });
      vi.mocked(connectionInviteRepository.findExistingConnection).mockResolvedValue({
        id: 'conn_123',
        status: 'PENDING',
      });

      const res = await POST(makeRequest({ email: TARGET_EMAIL }));

      expect(res.status).toBe(400);
    });

    it('returns 400 when an ACCEPTED connection row exists', async () => {
      vi.mocked(connectionInviteRepository.findUserIdByEmail).mockResolvedValue({
        id: TARGET_USER_ID,
        emailVerified: new Date('2024-01-01'),
        suspendedAt: null,
      });
      vi.mocked(connectionInviteRepository.findExistingConnection).mockResolvedValue({
        id: 'conn_123',
        status: 'ACCEPTED',
      });

      const res = await POST(makeRequest({ email: TARGET_EMAIL }));
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toMatch(/already connected/i);
    });
  });

  describe('rate limit exceeded', () => {
    it('returns 429 when pair-scoped rate limit is exceeded', async () => {
      vi.mocked(checkDistributedRateLimit).mockResolvedValueOnce({
        allowed: false,
        retryAfter: 900,
      });

      const res = await POST(makeRequest({ email: TARGET_EMAIL }));

      expect(res.status).toBe(429);
      expect(res.headers.get('Retry-After')).toBe('900');
    });

    it('returns 429 when global email rate limit is exceeded', async () => {
      vi.mocked(checkDistributedRateLimit)
        .mockResolvedValueOnce({ allowed: true }) // pair limit passes
        .mockResolvedValueOnce({ allowed: false, retryAfter: 900 }); // email limit fails

      const res = await POST(makeRequest({ email: TARGET_EMAIL }));

      expect(res.status).toBe(429);
    });
  });

  describe('SMTP rollback (R6)', () => {
    it('deletes pending invite row when email send fails', async () => {
      vi.mocked(sendPendingConnectionInvitationEmail).mockRejectedValue(
        new Error('SMTP connection refused')
      );

      const res = await POST(makeRequest({ email: TARGET_EMAIL }));

      expect(res.status).toBe(502);
      expect(connectionInviteRepository.deletePendingInvite).toHaveBeenCalledWith('invite_123');
    });
  });
});
