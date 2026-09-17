import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { auth: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
}));

vi.mock('@pagespace/lib/repositories/account-repository', () => ({
  accountRepository: {
    findById: vi.fn(),
    getOwnedDrives: vi.fn(),
    getDriveMemberCount: vi.fn(),
  },
}));

vi.mock('@pagespace/lib/repositories/data-subject-request-repository', () => ({
  dataSubjectRequestRepository: {
    findActiveErasureForUser: vi.fn(),
  },
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn(), auditRequest: vi.fn() }));

vi.mock('@/lib/erasure/request-erasure', () => ({ lodgeAndEnqueueErasure: vi.fn() }));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn(),
  logUserActivity: vi.fn(),
}));

import { DELETE } from '../route';
import { accountRepository } from '@pagespace/lib/repositories/account-repository';
import { dataSubjectRequestRepository } from '@pagespace/lib/repositories/data-subject-request-repository';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { lodgeAndEnqueueErasure } from '@/lib/erasure/request-erasure';

const mockAccountRepo = vi.mocked(accountRepository);
const mockDsrRepo = vi.mocked(dataSubjectRequestRepository);

const mockWebAuth = (userId: string, tokenVersion = 0): SessionAuthResult => ({
  userId,
  tokenVersion,
  tokenType: 'session',
  sessionId: 'test-session-id',
  role: 'user',
  adminRoleVersion: 0,
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const deleteReq = (emailConfirmation: string) =>
  new Request('https://example.com/api/account', {
    method: 'DELETE',
    body: JSON.stringify({ emailConfirmation }),
  });

describe('DELETE /api/account (async erasure)', () => {
  const mockUserId = 'user_123';
  const mockUserEmail = 'test@example.com';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    mockAccountRepo.findById.mockResolvedValue({
      id: mockUserId,
      email: mockUserEmail,
      image: null,
      stripeCustomerId: null,
    });
    mockAccountRepo.getOwnedDrives.mockResolvedValue([]);
    mockDsrRepo.findActiveErasureForUser.mockResolvedValue(null);
    vi.mocked(lodgeAndEnqueueErasure).mockResolvedValue({
      requestId: 'dsr_1',
      jobId: 'job_1',
      slaDeadline: new Date('2026-03-01T00:00:00.000Z'),
    });
  });

  describe('validation + auth', () => {
    it('should reject when email confirmation does not match', async () => {
      const res = await DELETE(deleteReq('wrong@example.com'));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('Email confirmation does not match your account email');
    });

    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));
      const res = await DELETE(deleteReq(mockUserEmail));
      expect(res.status).toBe(401);
    });

    it('should return 404 when user not found', async () => {
      mockAccountRepo.findById.mockResolvedValue(null);
      const res = await DELETE(deleteReq(mockUserEmail));
      expect(res.status).toBe(404);
    });

    it('should accept case-insensitive / whitespace-padded confirmation', async () => {
      const res = await DELETE(deleteReq('  TEST@EXAMPLE.COM  '));
      expect(res.status).toBe(202);
    });
  });

  describe('async queueing', () => {
    it('given no owned drives, should queue erasure and return 202 with requestId', async () => {
      const res = await DELETE(deleteReq(mockUserEmail));
      const body = await res.json();
      expect(res.status).toBe(202);
      expect(body.requestId).toBe('dsr_1');
      expect(body.status).toBe('queued');
      expect(lodgeAndEnqueueErasure).toHaveBeenCalledWith(
        expect.objectContaining({
          subjectUserId: mockUserId,
          callerUserId: mockUserId,
          requestedByType: 'self',
          forceDelete: false,
        })
      );
    });

    it('given solo drives only, should not block and should queue', async () => {
      mockAccountRepo.getOwnedDrives.mockResolvedValue([{ id: 'd1', name: 'Solo' }]);
      mockAccountRepo.getDriveMemberCount.mockResolvedValue(1);
      const res = await DELETE(deleteReq(mockUserEmail));
      expect(res.status).toBe(202);
      expect(lodgeAndEnqueueErasure).toHaveBeenCalled();
    });

    it('given multi-member drives, should block with 400 and NOT queue', async () => {
      mockAccountRepo.getOwnedDrives.mockResolvedValue([{ id: 'd1', name: 'Team Drive' }]);
      mockAccountRepo.getDriveMemberCount.mockResolvedValue(3);
      const res = await DELETE(deleteReq(mockUserEmail));
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.multiMemberDrives).toContain('Team Drive');
      expect(lodgeAndEnqueueErasure).not.toHaveBeenCalled();
    });

    it('given an in-flight erasure, should be idempotent and return the existing request', async () => {
      mockDsrRepo.findActiveErasureForUser.mockResolvedValue({
        id: 'dsr_existing',
        status: 'in_progress',
        slaDeadline: new Date('2026-03-01T00:00:00.000Z'),
      } as never);
      const res = await DELETE(deleteReq(mockUserEmail));
      const body = await res.json();
      expect(res.status).toBe(202);
      expect(body.requestId).toBe('dsr_existing');
      expect(lodgeAndEnqueueErasure).not.toHaveBeenCalled();
    });

    it('given enqueue failure, should return 500', async () => {
      vi.mocked(lodgeAndEnqueueErasure).mockRejectedValue(new Error('processor down'));
      const res = await DELETE(deleteReq(mockUserEmail));
      expect(res.status).toBe(500);
      expect((await res.json()).error).toBe('Failed to queue account erasure');
    });
  });
});
