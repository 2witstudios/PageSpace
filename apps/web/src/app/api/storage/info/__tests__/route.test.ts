/**
 * Contract tests for /api/storage/info — security audit coverage
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@pagespace/lib/server', () => ({
  audit: vi.fn(),
  auditRequest: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  verifyAuth: vi.fn(),
}));

vi.mock('@pagespace/lib/services/storage-limits', () => ({
  getUserStorageQuota: vi.fn().mockResolvedValue({ tier: 'free', usedBytes: 0, quotaBytes: 1e9, availableBytes: 1e9 }),
  getUserFileCount: vi.fn().mockResolvedValue(0),
  reconcileStorageUsage: vi.fn(),
  STORAGE_TIERS: { free: {} },
  formatBytes: vi.fn((n: number) => `${n}B`),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      drives: { findMany: vi.fn().mockResolvedValue([]) },
    },
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
  },
  pages: { id: 'id', driveId: 'driveId', type: 'type', isTrashed: 'isTrashed' },
  drives: { id: 'id', ownerId: 'ownerId' },
  eq: vi.fn(),
  and: vi.fn(),
  desc: vi.fn(),
  inArray: vi.fn(),
}));

import { GET } from '../route';
import { verifyAuth } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

describe('GET /api/storage/info', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyAuth).mockResolvedValue({ id: 'user_1' } as never);
  });

  it('logs audit event on successful storage info fetch', async () => {
    const request = new Request('https://example.com/api/storage/info');
    await GET(request as never);

    expect(auditRequest).toHaveBeenCalledWith(
      request,
      { eventType: 'data.read', userId: 'user_1', resourceType: 'storage', resourceId: 'user_1' }
    );
  });

  it('does not log audit event when auth fails', async () => {
    vi.mocked(verifyAuth).mockResolvedValue(null);

    const request = new Request('https://example.com/api/storage/info');
    await GET(request as never);

    expect(auditRequest).not.toHaveBeenCalled();
  });
});
