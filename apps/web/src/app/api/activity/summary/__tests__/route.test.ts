/**
 * Contract tests for /api/activity/summary — security audit coverage
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

const { mockAuditRequest } = vi.hoisted(() => ({
  mockAuditRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: mockAuditRequest,
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

// The canonical page set the user can view (the same primitive pulse scopes to).
vi.mock('@pagespace/lib/permissions/accessible-page-ids', () => ({
  accessiblePageIds: vi.fn(async () => []),
}));

vi.mock('@pagespace/db/db', () => {
  const mockWhere = vi.fn().mockResolvedValue([{ count: 0 }]);
  const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
  const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
  return {
    db: { select: mockSelect },
  };
});
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  lt: vi.fn(),
  gte: vi.fn(),
  ne: vi.fn(),
  sql: Object.assign(vi.fn(), { join: vi.fn(), param: vi.fn((v: unknown) => ({ param: v })) }),
  count: vi.fn(),
  isNotNull: vi.fn(),
  isNull: vi.fn(),
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { driveId: 'driveId', isTrashed: 'isTrashed', updatedAt: 'updatedAt' },
  drives: { id: 'id', ownerId: 'ownerId' },
}));
vi.mock('@pagespace/db/schema/members', () => ({
  driveMembers: { driveId: 'driveId', userId: 'userId', role: 'role' },
}));
vi.mock('@pagespace/db/schema/tasks', () => ({
  taskItems: { assigneeId: 'assigneeId', userId: 'userId', status: 'status', dueDate: 'dueDate', completedAt: 'completedAt' },
}));
vi.mock('@pagespace/db/schema/social', () => ({
  directMessages: { conversationId: 'conversationId', senderId: 'senderId', isRead: 'isRead', isActive: 'isActive', parentId: 'parentId' },
  dmConversations: { id: 'id', participant1Id: 'participant1Id', participant2Id: 'participant2Id' },
}));

import { GET } from '../route';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { accessiblePageIds } from '@pagespace/lib/permissions/accessible-page-ids';

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

describe('GET /api/activity/summary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth('user_1'));
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  it('logs audit event on successful summary fetch', async () => {
    const request = new Request('https://example.com/api/activity/summary');
    await GET(request);

    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ eventType: 'data.read', userId: 'user_1', resourceType: 'activity_summary', resourceId: 'user_1' })
    );
  });

  it('does not count a GUEST drive (redeemed page share link) among the member drives', async () => {
    await GET(new Request('https://example.com/api/activity/summary'));

    // The count is scoped to accessiblePageIds, never a drive_members read of this route's own;
    // its SQL function gives a GUEST row only its explicit grants (drizzle/0309), which
    // accessible-page-ids-agreement.integration.test.ts proves on real Postgres.
    expect(accessiblePageIds).toHaveBeenCalledWith('user_1');
  });

  it('does not log audit event when query throws', async () => {
    const { db } = await import('@pagespace/db/db');
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockRejectedValue(new Error('DB error')),
      }),
    } as never);

    const request = new Request('https://example.com/api/activity/summary');
    await GET(request);

    expect(mockAuditRequest).not.toHaveBeenCalled();
  });

  it('X-6 (partial) counts only pages the user can view (accessiblePageIds): no private page, no page a custom role hides, no page of a drive reached through a stale row, and no drive_members read of its own', async () => {
    const { db } = await import('@pagespace/db/db');
    const { sql } = await import('@pagespace/db/operators');
    vi.mocked(accessiblePageIds).mockResolvedValueOnce(['page_visible_1', 'page_visible_2']);
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ count: 0 }]) }),
    } as never);

    const response = await GET(new Request('https://example.com/api/activity/summary'));

    expect(response.status).toBe(200);
    expect(accessiblePageIds).toHaveBeenCalledWith('user_1');
    const { driveMembers } = await import('@pagespace/db/schema/members');
    const fromCalls = vi.mocked(db.select).mock.results.flatMap((r) => (r.value as { from: ReturnType<typeof vi.fn> }).from.mock.calls.map((c) => c[0]));
    expect(fromCalls).not.toContain(driveMembers);
    // The page-count conditions are built over the visible page ids, not a drive list.
    const paramArgs = vi.mocked(sql.param as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(paramArgs).toContainEqual(['page_visible_1', 'page_visible_2']);
  });

  it('runs no page count when the user can view no page', async () => {
    const { db } = await import('@pagespace/db/db');
    vi.mocked(accessiblePageIds).mockResolvedValueOnce([]);
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ count: 0 }]) }),
    } as never);

    const body = await (await GET(new Request('https://example.com/api/activity/summary'))).json();

    expect(body.pages).toEqual(expect.objectContaining({ updatedToday: 0, updatedThisWeek: 0 }));
  });

  it('does not log audit event when auth fails', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError());
    vi.mocked(isAuthError).mockReturnValue(true);

    const request = new Request('https://example.com/api/activity/summary');
    await GET(request);

    expect(mockAuditRequest).not.toHaveBeenCalled();
  });
});
