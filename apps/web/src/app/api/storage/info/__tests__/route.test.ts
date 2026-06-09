/**
 * Contract tests for /api/storage/info — security audit coverage
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@pagespace/lib/audit/audit-log', () => ({
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

vi.mock('@pagespace/db/db', () => ({
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
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  desc: vi.fn(),
  inArray: vi.fn(),
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id', driveId: 'driveId', type: 'type', isTrashed: 'isTrashed' },
  drives: { id: 'id', ownerId: 'ownerId' },
}));

import { GET } from '../route';
import { verifyAuth } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { reconcileStorageUsage } from '@pagespace/lib/services/storage-limits';

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

  describe('H4 — ?reconcile=true recomputes the caller\'s own usage (safe after the basis fix)', () => {
    it('reconciles the authenticated user\'s storage when requested', async () => {
      vi.mocked(reconcileStorageUsage).mockResolvedValue({ previousUsage: 0, actualUsage: 0, difference: 0 } as never);

      const request = new Request('https://example.com/api/storage/info?reconcile=true');
      const res = await GET(request as never);

      expect(res.status).toBe(200);
      expect(reconcileStorageUsage).toHaveBeenCalledWith('user_1');
    });

    it('does not reconcile when reconcile is not requested', async () => {
      const request = new Request('https://example.com/api/storage/info');
      await GET(request as never);

      expect(reconcileStorageUsage).not.toHaveBeenCalled();
    });

    it('still returns 200 storage info if reconciliation throws (best-effort)', async () => {
      vi.mocked(reconcileStorageUsage).mockRejectedValue(new Error('boom'));

      const request = new Request('https://example.com/api/storage/info?reconcile=true');
      const res = await GET(request as never);

      expect(res.status).toBe(200);
    });
  });
});
