/**
 * Security audit tests for /api/activities/export
 * Verifies auditRequest is called for GET (export).
 * Also verifies all activities are exported without truncation.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// vi.hoisted ensures mockFindMany is defined before vi.mock factories run
const mockFindMany = vi.hoisted(() => vi.fn().mockResolvedValue([]));

vi.mock('next/server', () => ({
  NextResponse: {
    json: vi.fn((data: unknown, init?: ResponseInit) => new Response(JSON.stringify(data), {
      status: init?.status ?? 200,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    })),
  },
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: unknown) => result && typeof result === 'object' && 'error' in result),
  checkMCPDriveScope: vi.fn().mockReturnValue(null),
  checkMCPPageScope: vi.fn().mockResolvedValue(null),
  getAllowedDriveIds: vi.fn().mockReturnValue([]),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      activityLogs: {
        findMany: mockFindMany,
      },
    },
  },
  activityLogs: {
    id: 'activityLogs.id',
    timestamp: 'activityLogs.timestamp',
    userId: 'activityLogs.userId',
    isArchived: 'activityLogs.isArchived',
    driveId: 'activityLogs.driveId',
    pageId: 'activityLogs.pageId',
    operation: 'activityLogs.operation',
    resourceType: 'activityLogs.resourceType',
  },
  eq: vi.fn().mockReturnValue({}),
  and: vi.fn().mockReturnValue({}),
  desc: vi.fn().mockReturnValue({}),
  gte: vi.fn().mockReturnValue({}),
  lt: vi.fn().mockReturnValue({}),
  inArray: vi.fn().mockReturnValue({}),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    security: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
  auditRequest: vi.fn(),
}));

vi.mock('@pagespace/lib', () => ({
  canUserViewPage: vi.fn().mockResolvedValue(true),
  isUserDriveMember: vi.fn().mockResolvedValue(true),
}));

vi.mock('date-fns', () => ({
  format: vi.fn().mockReturnValue('2024-01-01'),
}));

import { GET } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

const mockUserId = 'user_123';

const mockAuth = () => {
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
    userId: mockUserId,
    tokenVersion: 0,
    tokenType: 'session' as const,
    sessionId: 'test-session',
    role: 'user' as const,
    adminRoleVersion: 0,
  });
};

function makeActivity(i: number) {
  return {
    id: `act-${i}`,
    timestamp: new Date(),
    actorDisplayName: null,
    actorEmail: null,
    operation: 'create',
    resourceType: 'page',
    resourceTitle: null,
    isAiGenerated: false,
    aiProvider: null,
    aiModel: null,
    updatedFields: null,
    user: { id: mockUserId, name: 'Test User', email: 'test@example.com' },
  };
}

describe('GET /api/activities/export audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
    mockFindMany.mockResolvedValue([]);
  });

  it('logs export audit event on successful activities export', async () => {
    await GET(new Request('http://localhost/api/activities/export?context=user'));

    expect(auditRequest).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ eventType: 'data.export', userId: mockUserId, resourceType: 'activities', resourceId: 'self' })
    );
  });
});

describe('GET /api/activities/export pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
  });

  it('given_moreThanOneBatchOfActivities_allAreExported', async () => {
    const batch1 = Array.from({ length: 1000 }, (_, i) => makeActivity(i));
    const batch2 = Array.from({ length: 500 }, (_, i) => makeActivity(i + 1000));

    // First call (offset 0) returns full batch; second call (offset 1000) returns partial batch
    mockFindMany
      .mockResolvedValueOnce(batch1)
      .mockResolvedValueOnce(batch2);

    const response = await GET(new Request('http://localhost/api/activities/export?context=user'));
    const csv = await response.text();

    // 1 header row + 1500 data rows
    const rows = csv.split('\n').filter(r => r.trim().length > 0);
    expect(rows).toHaveLength(1501);

    // Verify findMany was called twice (two batches)
    expect(mockFindMany).toHaveBeenCalledTimes(2);
    expect(mockFindMany).toHaveBeenNthCalledWith(1, expect.objectContaining({ limit: 1000, offset: 0 }));
    expect(mockFindMany).toHaveBeenNthCalledWith(2, expect.objectContaining({ limit: 1000, offset: 1000 }));
  });

  it('given_exactlyOneBatch_stopsAfterOneFetch', async () => {
    const batch = Array.from({ length: 500 }, (_, i) => makeActivity(i));
    mockFindMany.mockResolvedValueOnce(batch);

    await GET(new Request('http://localhost/api/activities/export?context=user'));

    expect(mockFindMany).toHaveBeenCalledTimes(1);
  });

  it('given_no_activities_returns_csv_with_only_header', async () => {
    mockFindMany.mockResolvedValueOnce([]);

    const response = await GET(new Request('http://localhost/api/activities/export?context=user'));
    const csv = await response.text();

    // only the header row
    const rows = csv.split('\n').filter(r => r.trim().length > 0);
    expect(rows).toHaveLength(1);
    expect(mockFindMany).toHaveBeenCalledTimes(1);
  });

  it('response_does_not_include_X_Truncated_header', async () => {
    // Build 1000 activities to trigger what the old code would have truncated
    const batch = Array.from({ length: 1000 }, (_, i) => makeActivity(i));
    mockFindMany
      .mockResolvedValueOnce(batch)
      .mockResolvedValueOnce([]); // second fetch comes back empty

    const response = await GET(new Request('http://localhost/api/activities/export?context=user'));

    expect(response.headers.get('X-Truncated')).toBeNull();
  });
});
