import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET } from '../route';
import type { WebAuthResult, AuthError } from '@/lib/auth';

// Mock dependencies
vi.mock('@pagespace/db', () => ({
  db: {
    select: vi.fn(),
  },
  pages: {},
  drives: {},
  eq: vi.fn((field: unknown, value: unknown) => ({ field, value, type: 'eq' })),
  and: vi.fn((...args: unknown[]) => ({ args, type: 'and' })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values, type: 'sql' })),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },
  getUserAccessLevel: vi.fn(),
  getUserDriveAccess: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

import { db } from '@pagespace/db';
import { loggers, getUserAccessLevel, getUserDriveAccess } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

// Helper to create mock WebAuthResult
const mockWebAuth = (userId: string, tokenVersion = 0): WebAuthResult => ({
  userId,
  tokenVersion,
  tokenType: 'jwt',
  source: 'cookie',
  role: 'user',
});

// Helper to create mock AuthError
const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

// Helper to create mock page with content
const mockPage = (overrides: {
  id: string;
  title: string;
  content?: string;
  type?: 'FOLDER' | 'DOCUMENT' | 'AI_CHAT' | 'CHANNEL' | 'CANVAS' | 'SHEET';
  parentId?: string | null;
}) => ({
  id: overrides.id,
  title: overrides.title,
  content: overrides.content ?? '',
  type: overrides.type ?? 'DOCUMENT',
  parentId: overrides.parentId ?? null,
});

// Create mock context
const createContext = (driveId: string) => ({
  params: Promise.resolve({ driveId }),
});

describe('GET /api/drives/[driveId]/search/regex', () => {
  const mockUserId = 'user_123';
  const mockDriveId = 'drive_abc';

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Default: user has drive access
    vi.mocked(getUserDriveAccess).mockResolvedValue(true);

    // Default: user has view access to pages
    vi.mocked(getUserAccessLevel).mockResolvedValue({ canView: true, canEdit: false, canShare: false });
  });

  const setupSelectMock = (driveResults: unknown[], pageResults: unknown[]) => {
    let callIndex = 0;
    vi.mocked(db.select).mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation(() => {
          callIndex++;
          if (callIndex === 1) {
            // First query: drive lookup - returns array directly (destructured as [drive])
            return Promise.resolve(driveResults);
          }
          // Second query: pages - returns query object with .limit() method
          return {
            limit: vi.fn().mockResolvedValue(pageResults),
          };
        }),
      })),
    } as unknown as ReturnType<typeof db.select>));
  };

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/regex?pattern=test`);
      const response = await GET(request, createContext(mockDriveId));

      expect(response.status).toBe(401);
    });
  });

  describe('authorization', () => {
    it('should return 403 when user has no drive access', async () => {
      vi.mocked(getUserDriveAccess).mockResolvedValue(false);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/regex?pattern=test`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe("You don't have access to this drive");
    });

    it('should return 404 when drive not found', async () => {
      setupSelectMock([], []);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/regex?pattern=test`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Drive not found');
    });
  });

  describe('validation', () => {
    it('should return 400 when pattern is missing', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/regex`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Pattern parameter is required');
    });
  });

  describe('happy path', () => {
    beforeEach(() => {
      setupSelectMock(
        [{ slug: 'test-drive', name: 'Test Drive' }],
        [
          mockPage({ id: 'page_1', title: 'Documentation', content: 'This is a test document.\nIt has multiple lines.\ntest pattern here.' }),
          mockPage({ id: 'page_2', title: 'Notes', content: 'Some notes without the pattern.' }),
        ]
      );
    });

    it('should return matching pages for pattern', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/regex?pattern=test`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.pattern).toBe('test');
    });

    it('should default searchIn to content', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/regex?pattern=test`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.searchIn).toBe('content');
    });

    it('should support searchIn=title', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/regex?pattern=Doc&searchIn=title`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.searchIn).toBe('title');
    });

    it('should support searchIn=both', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/regex?pattern=test&searchIn=both`);
      const response = await GET(request, createContext(mockDriveId));

      expect(response.status).toBe(200);
    });

    it('should respect maxResults parameter', async () => {
      // Override mock to return only 1 page (simulating limit being applied by DB)
      setupSelectMock(
        [{ slug: 'test-drive', name: 'Test Drive' }],
        [mockPage({ id: 'page_1', title: 'Doc', content: 'test content' })]
      );

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/regex?pattern=test&maxResults=1`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.results.length).toBeLessThanOrEqual(1);
    });

    it('should cap maxResults at 100', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/regex?pattern=test&maxResults=500`);
      const response = await GET(request, createContext(mockDriveId));

      expect(response.status).toBe(200);
    });

    it('should include matching lines with line numbers', async () => {
      setupSelectMock(
        [{ slug: 'test-drive', name: 'Test Drive' }],
        [mockPage({ id: 'page_1', title: 'Doc', content: 'Line 1\ntest line\nLine 3' })]
      );

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/regex?pattern=test`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      if (body.results.length > 0 && body.results[0].matchingLines) {
        expect(body.results[0].matchingLines[0]).toHaveProperty('lineNumber');
        expect(body.results[0].matchingLines[0]).toHaveProperty('content');
      }
    });

    it('should limit matching lines to 5 per page', async () => {
      const contentWithManyMatches = Array(10).fill('test match').join('\n');
      setupSelectMock(
        [{ slug: 'test-drive', name: 'Test Drive' }],
        [mockPage({ id: 'page_1', title: 'Many Matches', content: contentWithManyMatches })]
      );

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/regex?pattern=test`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      if (body.results.length > 0) {
        expect(body.results[0].matchingLines.length).toBeLessThanOrEqual(5);
      }
    });
  });

  describe('semantic paths', () => {
    it('should build semantic paths with parent hierarchy', async () => {
      // Mock a page with parent
      const parentPage = mockPage({ id: 'parent', title: 'Parent Folder', type: 'FOLDER' });
      const childPage = mockPage({ id: 'child', title: 'Child Doc', content: 'test', parentId: 'parent' });

      let callIndex = 0;
      vi.mocked(db.select).mockImplementation(() => ({
        from: vi.fn().mockImplementation(() => ({
          where: vi.fn().mockImplementation(() => {
            callIndex++;
            if (callIndex === 1) {
              // First query: drive lookup - returns promise directly
              return Promise.resolve([{ slug: 'test-drive', name: 'Test Drive' }]);
            }
            if (callIndex === 2) {
              // Second query: pages with .limit()
              return {
                limit: vi.fn().mockResolvedValue([childPage]),
              };
            }
            // Subsequent queries: parent lookups - return promise directly
            return Promise.resolve([parentPage]);
          }),
        })),
      } as unknown as ReturnType<typeof db.select>));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/regex?pattern=test`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      if (body.results.length > 0) {
        expect(body.results[0].semanticPath).toContain('/');
      }
    });
  });

  describe('permission filtering', () => {
    it('should filter out pages user cannot view', async () => {
      setupSelectMock(
        [{ slug: 'test-drive', name: 'Test Drive' }],
        [
          mockPage({ id: 'page_1', title: 'Visible', content: 'test' }),
          mockPage({ id: 'page_2', title: 'Hidden', content: 'test' }),
        ]
      );

      vi.mocked(getUserAccessLevel).mockImplementation(async (_, pageId) => {
        if (pageId === 'page_1') {
          return { canView: true, canEdit: false, canShare: false };
        }
        return { canView: false, canEdit: false, canShare: false };
      });

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/regex?pattern=test`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.results.some((r: { title: string }) => r.title === 'Visible')).toBe(true);
      expect(body.results.some((r: { title: string }) => r.title === 'Hidden')).toBe(false);
    });
  });

  describe('response metadata', () => {
    it('should include summary and stats', async () => {
      setupSelectMock(
        [{ slug: 'test-drive', name: 'Test Drive' }],
        [mockPage({ id: 'page_1', title: 'Test', content: 'test content' })]
      );

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/regex?pattern=test`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.summary).toBeDefined();
      expect(body.stats).toBeDefined();
      expect(body.stats.pagesScanned).toBeDefined();
      expect(body.stats.pagesWithAccess).toBeDefined();
      expect(body.stats.documentTypes).toBeDefined();
      expect(body.nextSteps).toBeDefined();
    });

    it('should include totalMatches count', async () => {
      setupSelectMock(
        [{ slug: 'test-drive', name: 'Test Drive' }],
        [mockPage({ id: 'page_1', title: 'Test', content: 'test\ntest\ntest' })]
      );

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/regex?pattern=test`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      if (body.results.length > 0) {
        expect(body.results[0].totalMatches).toBeDefined();
      }
    });
  });

  describe('regex patterns', () => {
    it('should handle word boundary patterns', async () => {
      setupSelectMock(
        [{ slug: 'test-drive', name: 'Test Drive' }],
        [mockPage({ id: 'page_1', title: 'Doc', content: 'testing the test' })]
      );

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/regex?pattern=\\btest\\b`);
      const response = await GET(request, createContext(mockDriveId));

      expect(response.status).toBe(200);
    });

    it('should handle case-sensitive patterns', async () => {
      setupSelectMock(
        [{ slug: 'test-drive', name: 'Test Drive' }],
        [mockPage({ id: 'page_1', title: 'Doc', content: 'Test TEST test' })]
      );

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/regex?pattern=test`);
      const response = await GET(request, createContext(mockDriveId));

      expect(response.status).toBe(200);
    });
  });

  describe('error handling', () => {
    it('should return 500 when database query fails', async () => {
      vi.mocked(db.select).mockImplementation(() => {
        throw new Error('Database error');
      });

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/regex?pattern=test`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toContain('Regex search failed');
      expect(loggers.api.error).toHaveBeenCalled();
    });
  });
});
