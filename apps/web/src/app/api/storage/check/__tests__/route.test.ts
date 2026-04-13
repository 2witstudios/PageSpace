/**
 * Contract tests for /api/storage/check — security audit coverage
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

vi.mock('@pagespace/lib/server', () => ({
  audit: vi.fn(),
  auditRequest: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib/services/storage-limits', () => ({
  checkStorageQuota: vi.fn().mockResolvedValue({ allowed: true, quota: {} }),
  getUserStorageQuota: vi.fn().mockResolvedValue({ tier: 'free', usedBytes: 0, quotaBytes: 1e9, availableBytes: 1e9 }),
  STORAGE_TIERS: { free: { maxConcurrentUploads: 3 } },
}));

vi.mock('@pagespace/lib/services/upload-semaphore', () => ({
  uploadSemaphore: {
    canAcquireSlot: vi.fn().mockResolvedValue(true),
    getStatus: vi.fn().mockReturnValue({ userUploads: new Map() }),
  },
}));

vi.mock('@pagespace/lib/services/memory-monitor', () => ({
  checkMemoryMiddleware: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock('@/lib/validation/parse-body', () => ({
  safeParseBody: vi.fn().mockResolvedValue({ success: true, data: { fileSize: 1024 } }),
}));

import { GET } from '../route';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/server';

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'sess-1',
  role: 'user',
  adminRoleVersion: 0,
});

const mockAuthError = (): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
});

describe('GET /api/storage/check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth('user_1'));
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  it('logs audit event on successful storage check', async () => {
    const request = new Request('https://example.com/api/storage/check');
    await GET(request as never);

    expect(auditRequest).toHaveBeenCalledWith(
      request,
      { eventType: 'data.read', userId: 'user_1', resourceType: 'storage', resourceId: 'user_1' }
    );
  });

  it('does not log audit event when auth fails', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError());
    vi.mocked(isAuthError).mockReturnValue(true);

    const request = new Request('https://example.com/api/storage/check');
    await GET(request as never);

    expect(auditRequest).not.toHaveBeenCalled();
  });
});
