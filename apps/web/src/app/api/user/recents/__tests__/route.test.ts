/**
 * Tests for /api/user/recents
 * - Verifies auditRequest is called for GET (security audit).
 * - Verifies the optional driveId param triggers server-side drive scoping
 *   (join path) and maps rows correctly.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: unknown) => result && typeof result === 'object' && 'error' in result),
}));

// Chainable mock for db.select()...innerJoin()...limit() (the driveId branch).
// `selectRows` is mutated per-test to control what the query resolves to.
let selectRows: unknown[] = [];
const selectChain = {
  from: vi.fn(() => selectChain),
  innerJoin: vi.fn(() => selectChain),
  where: vi.fn(() => selectChain),
  orderBy: vi.fn(() => selectChain),
  limit: vi.fn(() => Promise.resolve(selectRows)),
};

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      userPageViews: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    },
    select: vi.fn(() => selectChain),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  desc: vi.fn(),
}));
vi.mock('@pagespace/db/schema/page-views', () => ({
  userPageViews: { userId: 'userId', pageId: 'pageId', viewedAt: 'viewedAt' },
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id', title: 'title', type: 'type', driveId: 'driveId', isTrashed: 'isTrashed' },
  drives: { id: 'id', name: 'name', isTrashed: 'isTrashed' },
}));

vi.mock('@pagespace/lib/client-safe', () => ({
  PageType: {
    FOLDER: 'FOLDER',
    DOCUMENT: 'DOCUMENT',
    CHANNEL: 'CHANNEL',
    AI_CHAT: 'AI_CHAT',
    CANVAS: 'CANVAS',
    FILE: 'FILE',
    SHEET: 'SHEET',
    TASK_LIST: 'TASK_LIST',
    CODE: 'CODE',
  },
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    security: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  audit: vi.fn(),
  auditRequest: vi.fn(),
}));

import { GET } from '../route';
import { db } from '@pagespace/db/db';
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

describe('GET /api/user/recents audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectRows = [];
    mockAuth();
  });

  it('logs read audit event on successful recents retrieval', async () => {
    const req = new Request('http://localhost/api/user/recents');
    await GET(req);

    expect(auditRequest).toHaveBeenCalledWith(
      req,
      { eventType: 'data.read', userId: mockUserId, resourceType: 'recents', resourceId: 'self' }
    );
  });
});

describe('GET /api/user/recents driveId scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectRows = [];
    mockAuth();
  });

  it('uses the server-side join path and maps drive-scoped rows', async () => {
    selectRows = [
      {
        id: 'page_1',
        title: 'Spec',
        type: 'DOCUMENT',
        driveId: 'drive_1',
        driveName: 'Marketing',
        viewedAt: new Date('2026-01-02T03:04:05.000Z'),
      },
    ];

    const req = new Request('http://localhost/api/user/recents?driveId=drive_1&limit=6');
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.recents).toEqual([
      {
        id: 'page_1',
        title: 'Spec',
        type: 'DOCUMENT',
        driveId: 'drive_1',
        driveName: 'Marketing',
        viewedAt: '2026-01-02T03:04:05.000Z',
      },
    ]);
    // Confirms the join branch was taken rather than the global relational path.
    expect(selectChain.innerJoin).toHaveBeenCalledTimes(2);
    expect(db.query.userPageViews.findMany).not.toHaveBeenCalled();
  });

  it('drops rows with unrecognized page types', async () => {
    selectRows = [
      { id: 'p1', title: 'Known', type: 'DOCUMENT', driveId: 'd1', driveName: 'D', viewedAt: new Date() },
      { id: 'p2', title: 'Mystery', type: 'NOT_A_TYPE', driveId: 'd1', driveName: 'D', viewedAt: new Date() },
    ];

    const req = new Request('http://localhost/api/user/recents?driveId=d1');
    const res = await GET(req);
    const body = await res.json();

    expect(body.recents).toHaveLength(1);
    expect(body.recents[0].id).toBe('p1');
  });
});
