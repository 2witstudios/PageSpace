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

// The one member-drive set (org-aware; owned drives plus accepted rows while dark).
vi.mock('@pagespace/lib/permissions/member-drives', () => ({
  getMemberDriveIds: vi.fn(async () => []),
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
  sql: Object.assign(vi.fn(), { join: vi.fn() }),
  count: vi.fn(),
  isNotNull: vi.fn(),
  isNull: vi.fn(),
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { driveId: 'driveId', isTrashed: 'isTrashed', updatedAt: 'updatedAt' },
  drives: { id: 'id', ownerId: 'ownerId' },
}));
vi.mock('@pagespace/db/schema/members', () => ({
  driveMembers: { driveId: 'driveId', userId: 'userId' },
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
import { getMemberDriveIds } from '@pagespace/lib/permissions/member-drives';

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

  it('DRV-5 (partial) X-6 (partial) counts updated pages over the org-aware member-drive set (trash included, as before), never a drive_members read of its own', async () => {
    const { db } = await import('@pagespace/db/db');
    vi.mocked(getMemberDriveIds).mockResolvedValueOnce(['drive_open_org']);
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ count: 0 }]) }),
    } as never);

    const response = await GET(new Request('https://example.com/api/activity/summary'));

    expect(response.status).toBe(200);
    expect(getMemberDriveIds).toHaveBeenCalledWith('user_1', { includeTrashed: true });
    const { driveMembers } = await import('@pagespace/db/schema/members');
    const fromCalls = vi.mocked(db.select).mock.results.flatMap((r) => (r.value as { from: ReturnType<typeof vi.fn> }).from.mock.calls.map((c) => c[0]));
    expect(fromCalls).not.toContain(driveMembers);
  });

  it('does not log audit event when auth fails', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError());
    vi.mocked(isAuthError).mockReturnValue(true);

    const request = new Request('https://example.com/api/activity/summary');
    await GET(request);

    expect(mockAuditRequest).not.toHaveBeenCalled();
  });
});
