/**
 * Contract tests for /api/activity/summary — security audit coverage
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

const { mockAuditRequest } = vi.hoisted(() => ({
  mockAuditRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
  auditRequest: mockAuditRequest,
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/db', () => {
  const mockWhere = vi.fn().mockResolvedValue([{ count: 0 }]);
  const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
  const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
  return {
    db: { select: mockSelect },
    taskItems: { assigneeId: 'assigneeId', userId: 'userId', status: 'status', dueDate: 'dueDate', completedAt: 'completedAt' },
    directMessages: { conversationId: 'conversationId', senderId: 'senderId', isRead: 'isRead' },
    dmConversations: { id: 'id', participant1Id: 'participant1Id', participant2Id: 'participant2Id' },
    pages: { driveId: 'driveId', isTrashed: 'isTrashed', updatedAt: 'updatedAt' },
    drives: { id: 'id', ownerId: 'ownerId' },
    driveMembers: { driveId: 'driveId', userId: 'userId' },
    eq: vi.fn(),
    and: vi.fn(),
    or: vi.fn(),
    lt: vi.fn(),
    gte: vi.fn(),
    ne: vi.fn(),
    sql: Object.assign(vi.fn(), { join: vi.fn() }),
    count: vi.fn(),
  };
});

import { GET } from '../route';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

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
    const { db } = await import('@pagespace/db');
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockRejectedValue(new Error('DB error')),
      }),
    } as never);

    const request = new Request('https://example.com/api/activity/summary');
    await GET(request);

    expect(mockAuditRequest).not.toHaveBeenCalled();
  });

  it('does not log audit event when auth fails', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError());
    vi.mocked(isAuthError).mockReturnValue(true);

    const request = new Request('https://example.com/api/activity/summary');
    await GET(request);

    expect(mockAuditRequest).not.toHaveBeenCalled();
  });
});
