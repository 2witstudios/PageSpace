/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/pulse
//
// Tests the route handler for the Pulse dashboard endpoint which aggregates
// summary, tasks, messages, pages, and calendar stats.
// ============================================================================

// Create chainable DB mock helper
function createChainMock(resolvedValue: any = [{ count: 0 }]) {
  const chain: any = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.from = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(chain);
  chain.orderBy = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockResolvedValue(resolvedValue);
  chain.innerJoin = vi.fn().mockReturnValue(chain);
  // When chain is awaited directly (without .limit())
  chain.then = (resolve: any) => Promise.resolve(resolvedValue).then(resolve);
  return chain;
}

const mockDbChain = createChainMock();

vi.mock('@pagespace/db', () => ({
  db: {
    select: vi.fn(() => mockDbChain),
  },
  pulseSummaries: { userId: 'userId', generatedAt: 'generatedAt' },
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
  driveMembers: {
    driveId: 'driveId',
    userId: 'userId',
  },
  calendarEvents: {
    id: 'id',
    driveId: 'driveId',
    createdById: 'createdById',
    visibility: 'visibility',
    isTrashed: 'isTrashed',
    startAt: 'startAt',
  },
  eventAttendees: {
    userId: 'userId',
    status: 'status',
    eventId: 'eventId',
  },
  users: {
    id: 'id',
    timezone: 'timezone',
  },
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  lt: vi.fn(),
  gte: vi.fn(),
  ne: vi.fn(),
  desc: vi.fn(),
  count: vi.fn(),
  inArray: vi.fn(),
  isNull: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@/lib/ai/core', () => ({
  getStartOfTodayInTimezone: vi.fn().mockReturnValue(new Date('2024-01-15T00:00:00Z')),
  normalizeTimezone: vi.fn().mockReturnValue('America/New_York'),
}));

import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { GET } from '../route';

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

describe('GET /api/pulse', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Reset the mock chain for each test
    // We need to mock db.select to return a chainable object
    // that ultimately resolves to appropriate values for each query
    const selectMock = vi.fn();

    // Phase 1 queries (7 parallel queries):
    // 1. User timezone
    // 2. Summary
    // 3. User drives
    // 4. Tasks overdue
    // 5. Tasks due today
    // 6. Tasks due this week
    // 7. Tasks completed this week
    // 8. User conversations

    // Phase 2 queries (5 parallel queries):
    // 1. Unread messages (or Promise.resolve)
    // 2. Calendar events today
    // 3. Pending invites
    // 4. Pages updated today (or Promise.resolve)
    // 5. Pages updated this week (or Promise.resolve)

    // Create chains for each call
    let callCount = 0;
    selectMock.mockImplementation(() => {
      callCount++;
      const chain: any = {};
      chain.from = vi.fn().mockReturnValue(chain);
      chain.where = vi.fn().mockReturnValue(chain);
      chain.orderBy = vi.fn().mockReturnValue(chain);
      chain.limit = vi.fn().mockImplementation(() => {
        // Call 1: user timezone query
        if (callCount === 1) return Promise.resolve([{ timezone: 'America/New_York' }]);
        // Call 2: summaries (ordered, limited to 1)
        if (callCount === 2) return Promise.resolve([]);
        // All others return count results
        return Promise.resolve([{ count: 0 }]);
      });
      chain.innerJoin = vi.fn().mockReturnValue(chain);
      // For queries without .limit() (like count queries), resolve via then
      chain.then = (resolve: any) => {
        if (callCount === 1) return Promise.resolve([{ timezone: 'America/New_York' }]).then(resolve);
        if (callCount <= 2) return Promise.resolve([]).then(resolve);
        // Drives query
        if (callCount === 3) return Promise.resolve([]).then(resolve);
        // Count queries
        return Promise.resolve([{ count: 0 }]).then(resolve);
      };
      return chain;
    });

    vi.mocked(db.select).mockImplementation(selectMock);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/pulse');
      const response = await GET(request);

      expect(response.status).toBe(401);
    });

    it('should call authenticateRequestWithOptions with session-only auth', async () => {
      const request = new Request('https://example.com/api/pulse');

      // Wrap in try to handle mock chain issues
      try {
        await GET(request);
      } catch {
        // May fail due to complex mocking, but auth should be called
      }

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'] }
      );
    });
  });

  describe('response contract', () => {
    it('should return pulse response with expected shape', async () => {
      // For this test, we set up all the db.select mocks to return predictable values
      let callIdx = 0;
      vi.mocked(db.select).mockImplementation((() => {
        callIdx++;
        const chain: any = {};
        chain.from = vi.fn().mockReturnValue(chain);
        chain.where = vi.fn().mockReturnValue(chain);
        chain.orderBy = vi.fn().mockReturnValue(chain);
        chain.innerJoin = vi.fn().mockReturnValue(chain);
        chain.limit = vi.fn().mockImplementation(() => {
          // Summary query (has orderBy + limit)
          return Promise.resolve([]);
        });
        chain.then = (resolve: any) => {
          const idx = callIdx;
          // 1: user timezone
          if (idx === 1) return Promise.resolve([{ timezone: 'America/New_York' }]).then(resolve);
          // 2: pulse summaries (limit 1)
          if (idx === 2) return Promise.resolve([]).then(resolve);
          // 3: user drives
          if (idx === 3) return Promise.resolve([]).then(resolve);
          // 4-7: task counts
          if (idx >= 4 && idx <= 7) return Promise.resolve([{ count: 0 }]).then(resolve);
          // 8: conversations
          if (idx === 8) return Promise.resolve([]).then(resolve);
          // 9+: phase 2 queries
          return Promise.resolve([{ count: 0 }]).then(resolve);
        };
        return chain;
      }) as any);

      const request = new Request('https://example.com/api/pulse');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toHaveProperty('summary');
      expect(body).toHaveProperty('stats');
      expect(body).toHaveProperty('shouldRefresh');
      expect(body.stats).toHaveProperty('tasks');
      expect(body.stats).toHaveProperty('messages');
      expect(body.stats).toHaveProperty('pages');
      expect(body.stats).toHaveProperty('calendar');
    });

    it('should set shouldRefresh=true when no summary exists', async () => {
      let callIdx = 0;
      vi.mocked(db.select).mockImplementation((() => {
        callIdx++;
        const chain: any = {};
        chain.from = vi.fn().mockReturnValue(chain);
        chain.where = vi.fn().mockReturnValue(chain);
        chain.orderBy = vi.fn().mockReturnValue(chain);
        chain.innerJoin = vi.fn().mockReturnValue(chain);
        chain.limit = vi.fn().mockResolvedValue([]);
        chain.then = (resolve: any) => {
          const idx = callIdx;
          if (idx === 1) return Promise.resolve([{ timezone: 'America/New_York' }]).then(resolve);
          if (idx === 3) return Promise.resolve([]).then(resolve); // drives
          if (idx === 8) return Promise.resolve([]).then(resolve); // conversations
          return Promise.resolve([{ count: 0 }]).then(resolve);
        };
        return chain;
      }) as any);

      const request = new Request('https://example.com/api/pulse');
      const response = await GET(request);
      const body = await response.json();

      expect(body.summary).toBeNull();
      expect(body.shouldRefresh).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should return 500 on database error', async () => {
      vi.mocked(db.select).mockImplementation(() => {
        throw new Error('Database error');
      });

      const request = new Request('https://example.com/api/pulse');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch pulse');
    });

    it('should log error on failure', async () => {
      const error = new Error('Database error');
      vi.mocked(db.select).mockImplementation(() => {
        throw error;
      });

      const request = new Request('https://example.com/api/pulse');
      await GET(request);

      expect(loggers.api.error).toHaveBeenCalledWith(
        'Error fetching pulse:',
        error
      );
    });
  });
});
