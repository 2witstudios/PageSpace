import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { GET } from '../route';

/**
 * Security Tests for Audit Logs Search
 *
 * These tests verify that the search functionality properly sanitizes
 * user input to prevent LIKE pattern injection attacks.
 *
 * Vulnerability: SQL LIKE pattern injection
 * Attack Vector: User supplies LIKE wildcards (%, _) in search parameter
 * Impact: Broader pattern matching than intended, data disclosure
 * Fix: Escape LIKE special characters before using in queries
 */

// Mock dependencies
vi.mock('@/lib/auth', () => ({
  verifyAdminAuth: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

// Mock the database module
vi.mock('@pagespace/db', () => {
  // Track the ilike calls to verify escaping
  const ilikeCallTracker: Array<{ column: unknown; pattern: string }> = [];

  // Reset and return the tracker for each test
  const getIlikeCallTracker = () => ilikeCallTracker;
  const clearIlikeCallTracker = () => {
    ilikeCallTracker.length = 0;
  };

  return {
    db: {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([{ count: 0 }]),
          leftJoin: () => ({
            where: () => ({
              orderBy: () => ({
                limit: () => ({
                  offset: () => Promise.resolve([]),
                }),
              }),
            }),
          }),
        }),
      }),
    },
    activityLogs: {
      id: 'id',
      timestamp: 'timestamp',
      userId: 'userId',
      actorEmail: 'actorEmail',
      actorDisplayName: 'actorDisplayName',
      isAiGenerated: 'isAiGenerated',
      aiProvider: 'aiProvider',
      aiModel: 'aiModel',
      aiConversationId: 'aiConversationId',
      operation: { enumValues: ['create', 'update', 'delete'] },
      resourceType: { enumValues: ['page', 'drive', 'user'] },
      resourceId: 'resourceId',
      resourceTitle: 'resourceTitle',
      driveId: 'driveId',
      pageId: 'pageId',
      updatedFields: 'updatedFields',
      previousValues: 'previousValues',
      newValues: 'newValues',
      metadata: 'metadata',
      isArchived: 'isArchived',
      previousLogHash: 'previousLogHash',
      logHash: 'logHash',
      chainSeed: 'chainSeed',
    },
    users: {
      id: 'id',
      name: 'name',
      email: 'email',
      image: 'image',
    },
    eq: vi.fn((col, val) => ({ type: 'eq', col, val })),
    and: vi.fn((...conditions) => ({ type: 'and', conditions })),
    or: vi.fn((...conditions) => ({ type: 'or', conditions })),
    desc: vi.fn((col) => ({ type: 'desc', col })),
    count: vi.fn(() => ({ type: 'count' })),
    gte: vi.fn((col, val) => ({ type: 'gte', col, val })),
    lte: vi.fn((col, val) => ({ type: 'lte', col, val })),
    ilike: vi.fn((column, pattern) => {
      ilikeCallTracker.push({ column, pattern });
      return { type: 'ilike', column, pattern };
    }),
    // Export tracker functions for test access
    __test__: {
      getIlikeCallTracker,
      clearIlikeCallTracker,
    },
  };
});

import { verifyAdminAuth } from '@/lib/auth';
import { ilike, __test__ } from '@pagespace/db';

describe('/api/admin/audit-logs - Search Security', () => {
  const mockAdminUser = {
    userId: 'admin-user-id',
    userRole: 'admin' as const,
    sessionId: 'test-session-id',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    __test__.clearIlikeCallTracker();
    (verifyAdminAuth as unknown as Mock).mockResolvedValue(mockAdminUser);
  });

  describe('LIKE pattern injection prevention', () => {
    it('GET_withPercentWildcardInSearch_escapesWildcard', async () => {
      // Arrange: Search contains SQL LIKE wildcard %
      const maliciousSearch = '100%';
      const request = new Request(
        `http://localhost/api/admin/audit-logs?search=${encodeURIComponent(maliciousSearch)}`,
        { method: 'GET' }
      );

      // Act
      await GET(request);

      // Assert: The % should be escaped to \%
      const tracker = __test__.getIlikeCallTracker();
      expect(tracker.length).toBeGreaterThan(0);
      // Pattern should have the % escaped, wrapped in search wildcards
      expect(tracker[0].pattern).toBe('%100\\%%');
    });

    it('GET_withUnderscoreWildcardInSearch_escapesWildcard', async () => {
      // Arrange: Search contains SQL LIKE single-char wildcard _
      const maliciousSearch = 'user_name';
      const request = new Request(
        `http://localhost/api/admin/audit-logs?search=${encodeURIComponent(maliciousSearch)}`,
        { method: 'GET' }
      );

      // Act
      await GET(request);

      // Assert: The _ should be escaped to \_
      const tracker = __test__.getIlikeCallTracker();
      expect(tracker.length).toBeGreaterThan(0);
      expect(tracker[0].pattern).toBe('%user\\_name%');
    });

    it('GET_withBackslashInSearch_escapesBackslash', async () => {
      // Arrange: Search contains backslash (escape char in SQL LIKE)
      const maliciousSearch = 'path\\to\\file';
      const request = new Request(
        `http://localhost/api/admin/audit-logs?search=${encodeURIComponent(maliciousSearch)}`,
        { method: 'GET' }
      );

      // Act
      await GET(request);

      // Assert: Backslashes should be escaped
      const tracker = __test__.getIlikeCallTracker();
      expect(tracker.length).toBeGreaterThan(0);
      expect(tracker[0].pattern).toBe('%path\\\\to\\\\file%');
    });

    it('GET_withCombinedSpecialCharsInSearch_escapesAll', async () => {
      // Arrange: Search contains multiple LIKE special characters
      const maliciousSearch = '50%_off\\deal';
      const request = new Request(
        `http://localhost/api/admin/audit-logs?search=${encodeURIComponent(maliciousSearch)}`,
        { method: 'GET' }
      );

      // Act
      await GET(request);

      // Assert: All special characters should be escaped
      const tracker = __test__.getIlikeCallTracker();
      expect(tracker.length).toBeGreaterThan(0);
      // Order of escaping: \ first, then %, then _
      expect(tracker[0].pattern).toBe('%50\\%\\_off\\\\deal%');
    });

    it('GET_withNormalSearch_doesNotAddExtraEscapes', async () => {
      // Arrange: Normal search term without special characters
      const normalSearch = 'admin user';
      const request = new Request(
        `http://localhost/api/admin/audit-logs?search=${encodeURIComponent(normalSearch)}`,
        { method: 'GET' }
      );

      // Act
      await GET(request);

      // Assert: Pattern should just have the search term wrapped in wildcards
      const tracker = __test__.getIlikeCallTracker();
      expect(tracker.length).toBeGreaterThan(0);
      expect(tracker[0].pattern).toBe('%admin user%');
    });

    it('GET_withSearch_usesIlikeFunctionInsteadOfRawSql', async () => {
      // Arrange
      const request = new Request(
        'http://localhost/api/admin/audit-logs?search=test',
        { method: 'GET' }
      );

      // Act
      await GET(request);

      // Assert: ilike function should be called (not raw SQL template)
      expect(ilike).toHaveBeenCalled();
      // Should search across all 4 fields
      expect(ilike).toHaveBeenCalledTimes(4);
    });
  });

  describe('authentication requirements', () => {
    it('GET_withoutAdminAuth_returns403', async () => {
      // Arrange: Not an admin
      (verifyAdminAuth as unknown as Mock).mockResolvedValue(null);

      const request = new Request(
        'http://localhost/api/admin/audit-logs?search=test',
        { method: 'GET' }
      );

      // Act
      const response = await GET(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(403);
      expect(body.error).toBe('Unauthorized: Admin access required');
    });
  });
});
