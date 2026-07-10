/**
 * Red-team test: a manage-keys-only OAuth credential (Phase 9, mintable today
 * via the manage_keys scope token — see ScopeSet.manageKeys) must not see the
 * activity feed for every drive its owning user belongs to. GET /api/activities
 * in the default 'user' context with no driveId reads allowedDriveIds directly
 * (bypassing checkMCPDriveScope/checkMCPPageScope entirely) — this is exactly
 * the shape of "6th place using the same empty-array-means-full-access
 * convention" the task called out. Uses the REAL getAllowedDriveIds /
 * isManageKeysOnly implementation (not mocked).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { manageKeysScopedAuthResult } from '@/lib/auth/__tests__/manage-keys-fixture';

const { mockActivityLogsFindMany, mockCountWhere, mockInArray } = vi.hoisted(() => ({
  mockActivityLogsFindMany: vi.fn().mockResolvedValue([]),
  mockCountWhere: vi.fn().mockResolvedValue([{ total: 0 }]),
  mockInArray: vi.fn((...args: unknown[]) => ({ __op: 'inArray', args })),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      activityLogs: { findMany: (...args: unknown[]) => mockActivityLogsFindMany(...args) },
    },
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: (...args: unknown[]) => mockCountWhere(...args),
      })),
    })),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((...args: unknown[]) => ({ __op: 'eq', args })),
  and: vi.fn((...args: unknown[]) => ({ __op: 'and', args })),
  desc: vi.fn(),
  count: vi.fn(),
  gte: vi.fn(),
  lt: vi.fn(),
  inArray: mockInArray,
}));
vi.mock('@pagespace/db/schema/monitoring', () => ({
  activityLogs: { userId: 'userId', driveId: 'driveId', isArchived: 'isArchived', timestamp: 'timestamp', operation: 'operation', resourceType: 'resourceType', pageId: 'pageId' },
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));

// Only stub authentication — getAllowedDriveIds and isManageKeysOnly run for real.
vi.mock('@/lib/auth/request-auth', async (importOriginal) => ({
  ...(await importOriginal()),
  authenticateRequestWithOptions: vi.fn(),
}));

import { GET } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';

describe('GET /api/activities — manage-keys-only credential', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActivityLogsFindMany.mockResolvedValue([]);
    mockCountWhere.mockResolvedValue([{ total: 0 }]);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(manageKeysScopedAuthResult());
  });

  it('scopes the query to zero drives instead of skipping the drive filter (full-access default)', async () => {
    const request = new Request('https://example.com/api/activities?context=user');

    const response = await GET(request);

    expect(response.status).toBe(200);
    // The empty-allowedDriveIds-means-full-access bug would skip this call
    // entirely, returning the owning user's activity across every drive.
    expect(mockInArray).toHaveBeenCalled();
  });
});
