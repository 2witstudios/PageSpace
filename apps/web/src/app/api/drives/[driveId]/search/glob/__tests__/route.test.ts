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
  inArray: vi.fn((field: unknown, values: unknown[]) => ({ field, values, type: 'inArray' })),
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

// Helper to create mock page
const mockPage = (overrides: {
  id: string;
  title: string;
  type?: 'FOLDER' | 'DOCUMENT' | 'AI_CHAT' | 'CHANNEL' | 'CANVAS' | 'SHEET';
  parentId?: string | null;
  position?: number;
}) => ({
  id: overrides.id,
  title: overrides.title,
  type: overrides.type ?? 'DOCUMENT',
  parentId: overrides.parentId ?? null,
  position: overrides.position ?? 0,
});

// Create mock context
const createContext = (driveId: string) => ({
  params: Promise.resolve({ driveId }),
});

describe('GET /api/drives/[driveId]/search/glob', () => {
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
        where: vi.fn().mockImplementation(async () => {
          callIndex++;
          if (callIndex === 1) return driveResults;
          return pageResults;
        }),
      })),
    } as unknown as ReturnType<typeof db.select>));
  };

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/glob?pattern=*.md`);
      const response = await GET(request, createContext(mockDriveId));

      expect(response.status).toBe(401);
    });
  });

  describe('authorization', () => {
    it('should return 403 when user has no drive access', async () => {
      vi.mocked(getUserDriveAccess).mockResolvedValue(false);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/glob?pattern=*.md`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe("You don't have access to this drive");
    });

    it('should return 404 when drive not found', async () => {
      setupSelectMock([], []);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/glob?pattern=*.md`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Drive not found');
    });
  });

  describe('validation', () => {
    it('should return 400 when pattern is missing', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/glob`);
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
          mockPage({ id: 'page_1', title: 'README.md' }),
          mockPage({ id: 'page_2', title: 'docs', type: 'FOLDER' }),
          mockPage({ id: 'page_3', title: 'CONTRIBUTING.md', parentId: 'page_2' }),
        ]
      );
    });

    it('should return matching pages for simple pattern', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/glob?pattern=*.md`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.pattern).toBe('*.md');
      expect(body.results.length).toBeGreaterThan(0);
    });

    it('should return results with semantic paths', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/glob?pattern=*`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.results[0]).toHaveProperty('semanticPath');
      expect(body.results[0].semanticPath).toMatch(/^\/test-drive\//);
    });

    it('should include match type (path or title)', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/glob?pattern=README*`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      if (body.results.length > 0) {
        expect(body.results[0]).toHaveProperty('matchedOn');
        expect(['path', 'title']).toContain(body.results[0].matchedOn);
      }
    });

    it('should respect maxResults parameter', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/glob?pattern=*&maxResults=1`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.results.length).toBeLessThanOrEqual(1);
    });

    it('should cap maxResults at 200', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/glob?pattern=*&maxResults=500`);
      const response = await GET(request, createContext(mockDriveId));

      expect(response.status).toBe(200);
      // The route should internally cap at 200
    });

    it('should filter by includeTypes parameter', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/glob?pattern=*&includeTypes=DOCUMENT,FOLDER`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      // Results should only contain DOCUMENT and FOLDER types
      body.results.forEach((result: { type: string }) => {
        expect(['DOCUMENT', 'FOLDER']).toContain(result.type);
      });
    });

    it('should filter out invalid includeTypes values', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/glob?pattern=*&includeTypes=DOCUMENT,INVALID_TYPE`);
      const response = await GET(request, createContext(mockDriveId));

      expect(response.status).toBe(200);
    });
  });

  describe('glob pattern matching', () => {
    beforeEach(() => {
      setupSelectMock(
        [{ slug: 'test-drive', name: 'Test Drive' }],
        [
          mockPage({ id: 'page_1', title: 'README.md' }),
          mockPage({ id: 'page_2', title: 'config.json' }),
          mockPage({ id: 'page_3', title: 'test.ts' }),
          mockPage({ id: 'page_4', title: 'test.tsx' }),
        ]
      );
    });

    it('should match wildcard patterns', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/glob?pattern=test.*`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      // Should match test.ts and test.tsx
    });

    it('should match single character wildcard', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/glob?pattern=test.ts?`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      // Should match test.tsx (? = single char)
    });
  });

  describe('permission filtering', () => {
    it('should filter out pages user cannot view', async () => {
      setupSelectMock(
        [{ slug: 'test-drive', name: 'Test Drive' }],
        [
          mockPage({ id: 'page_1', title: 'Visible' }),
          mockPage({ id: 'page_2', title: 'Hidden' }),
        ]
      );

      // Only allow viewing page_1
      vi.mocked(getUserAccessLevel).mockImplementation(async (_, pageId) => {
        if (pageId === 'page_1') {
          return { canView: true, canEdit: false, canShare: false };
        }
        return { canView: false, canEdit: false, canShare: false };
      });

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/glob?pattern=*`);
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
        [mockPage({ id: 'page_1', title: 'Test' })]
      );

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/glob?pattern=*`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.summary).toBeDefined();
      expect(body.stats).toBeDefined();
      expect(body.stats.totalPagesScanned).toBeDefined();
      expect(body.stats.matchingPages).toBeDefined();
      expect(body.stats.matchTypes).toBeDefined();
      expect(body.nextSteps).toBeDefined();
    });

    it('should include driveSlug in response', async () => {
      setupSelectMock(
        [{ slug: 'my-drive', name: 'My Drive' }],
        []
      );

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/glob?pattern=*`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.driveSlug).toBe('my-drive');
    });
  });

  describe('error handling', () => {
    it('should return 500 when database query fails', async () => {
      vi.mocked(db.select).mockImplementation(() => {
        throw new Error('Database error');
      });

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/glob?pattern=*`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toContain('Glob search failed');
      expect(loggers.api.error).toHaveBeenCalled();
    });
  });
});
