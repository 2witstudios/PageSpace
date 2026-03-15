/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for GET /api/activity/summary
//
// Tests the route handler's contract for the activity summary dashboard.
// ============================================================================

vi.mock('@pagespace/db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([{ count: 0 }]),
        innerJoin: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ count: 0 }]),
        })),
      })),
    })),
  },
  taskItems: {
    assigneeId: 'assigneeId',
    userId: 'userId',
    status: 'status',
    dueDate: 'dueDate',
    completedAt: 'completedAt',
  },
  directMessages: {
    conversationId: 'conversationId',
    senderId: 'senderId',
    isRead: 'isRead',
  },
  dmConversations: {
    id: 'id',
    participant1Id: 'participant1Id',
    participant2Id: 'participant2Id',
  },
  pages: {
    driveId: 'driveId',
    isTrashed: 'isTrashed',
    updatedAt: 'updatedAt',
  },
  drives: {
    id: 'id',
    ownerId: 'ownerId',
  },
  driveMembers: {
    driveId: 'driveId',
    userId: 'userId',
  },
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  lt: vi.fn(),
  gte: vi.fn(),
  ne: vi.fn(),
  sql: Object.assign(vi.fn(), { join: vi.fn() }),
  count: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

import { GET } from '../route';
import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

// ============================================================================
// Test Helpers
// ============================================================================

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  adminRoleVersion: 0,
  role: 'user',
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

// Helper to set up chained DB mock responses
function setupDbMock(responses: Array<{ count: number } | { id: string } | { driveId: string }>[]): void {
  let callIndex = 0;
  vi.mocked(db.select).mockImplementation(() => ({
    from: vi.fn().mockImplementation(() => ({
      where: vi.fn().mockImplementation(() => {
        const result = responses[callIndex] || [{ count: 0 }];
        callIndex++;
        return Promise.resolve(result);
      }),
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation(() => {
          const result = responses[callIndex] || [{ count: 0 }];
          callIndex++;
          return Promise.resolve(result);
        }),
      }),
    })),
  }) as any);
}

// ============================================================================
// Tests
// ============================================================================

describe('GET /api/activity/summary', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Default: all counts return 0, no conversations, no drives
    setupDbMock([
      [{ count: 0 }], // tasks due today
      [{ count: 0 }], // tasks due this week
      [{ count: 0 }], // tasks overdue
      [{ count: 0 }], // tasks completed this week
      [],              // user conversations (empty)
      [],              // owned drives
      [],              // member drives
    ]);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/activity/summary');
      const response = await GET(request);

      expect(response.status).toBe(401);
    });

    it('should use session-only auth', async () => {
      const request = new Request('https://example.com/api/activity/summary');
      await GET(request);

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'] }
      );
    });
  });

  describe('success', () => {
    it('should return activity summary with all sections', async () => {
      const request = new Request('https://example.com/api/activity/summary');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toHaveProperty('tasks');
      expect(body).toHaveProperty('messages');
      expect(body).toHaveProperty('pages');
      expect(body.tasks).toHaveProperty('dueToday');
      expect(body.tasks).toHaveProperty('dueThisWeek');
      expect(body.tasks).toHaveProperty('overdue');
      expect(body.tasks).toHaveProperty('completedThisWeek');
      expect(body.messages).toHaveProperty('unreadCount');
      expect(body.pages).toHaveProperty('updatedToday');
      expect(body.pages).toHaveProperty('updatedThisWeek');
    });

    it('should return zero counts when user has no data', async () => {
      const request = new Request('https://example.com/api/activity/summary');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.tasks.dueToday).toBe(0);
      expect(body.tasks.dueThisWeek).toBe(0);
      expect(body.tasks.overdue).toBe(0);
      expect(body.tasks.completedThisWeek).toBe(0);
      expect(body.messages.unreadCount).toBe(0);
      expect(body.pages.updatedToday).toBe(0);
      expect(body.pages.updatedThisWeek).toBe(0);
    });
  });

  describe('error handling', () => {
    it('should return 500 when database query fails', async () => {
      vi.mocked(db.select).mockImplementation(() => {
        throw new Error('DB error');
      });

      const request = new Request('https://example.com/api/activity/summary');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch activity summary');
    });

    it('should log error when query fails', async () => {
      const error = new Error('Query failed');
      vi.mocked(db.select).mockImplementation(() => {
        throw error;
      });

      const request = new Request('https://example.com/api/activity/summary');
      await GET(request);

      expect(loggers.api.error).toHaveBeenCalledWith('Error fetching activity summary:', error);
    });
  });
});
