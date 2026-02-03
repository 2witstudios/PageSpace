import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET } from '../route';
import type { SessionAuthResult, AuthError } from '@/lib/auth';
// Use inferred types to avoid export issues
type DriveSearchInfo = NonNullable<Awaited<ReturnType<typeof import('@pagespace/lib/server').checkDriveAccessForSearch>>>;
type RegexSearchResponse = Awaited<ReturnType<typeof import('@pagespace/lib/server').regexSearchPages>>;

// ============================================================================
// Contract Tests for /api/drives/[driveId]/search/regex
//
// These tests mock at the SERVICE SEAM level, NOT at the ORM/query-builder level.
// ============================================================================

vi.mock('@pagespace/lib/server', () => ({
  checkDriveAccessForSearch: vi.fn(),
  regexSearchPages: vi.fn(),
  loggers: {
    api: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
  checkMCPDriveScope: vi.fn(() => null), // Allow all drives by default
}));

import { checkDriveAccessForSearch, regexSearchPages } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError, checkMCPDriveScope } from '@/lib/auth';

// ============================================================================
// Test Fixtures
// ============================================================================

const mockWebAuth = (userId: string, tokenVersion = 0): SessionAuthResult => ({
  userId,
  tokenVersion,
  tokenType: 'session',
  sessionId: 'test-session-id',
  role: 'user',
  adminRoleVersion: 0,
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const createDriveSearchInfo = (overrides: Partial<DriveSearchInfo> = {}): DriveSearchInfo => ({
  hasAccess: overrides.hasAccess ?? true,
  drive: overrides.drive !== undefined ? overrides.drive : {
    id: 'drive_abc',
    slug: 'test-drive',
    name: 'Test Drive',
  },
});

const createRegexSearchResponse = (overrides: Partial<RegexSearchResponse> = {}): RegexSearchResponse => ({
  driveSlug: overrides.driveSlug ?? 'test-drive',
  pattern: overrides.pattern ?? 'test',
  searchIn: overrides.searchIn ?? 'content',
  results: overrides.results ?? [
    {
      pageId: 'page_1',
      title: 'Documentation',
      type: 'DOCUMENT',
      semanticPath: '/test-drive/Documentation',
      matchingLines: [{ lineNumber: 1, content: 'This is a test document.' }],
      totalMatches: 1,
    },
  ],
  totalResults: overrides.totalResults ?? 1,
  summary: overrides.summary ?? 'Found 1 page matching pattern "test"',
  stats: overrides.stats ?? {
    pagesScanned: 10,
    pagesWithAccess: 1,
    documentTypes: ['DOCUMENT'],
  },
  nextSteps: overrides.nextSteps ?? ['Use read_page with the pageId to examine full content'],
});

const createContext = (driveId: string) => ({
  params: Promise.resolve({ driveId }),
});

// ============================================================================
// GET /api/drives/[driveId]/search/regex - Contract Tests
// ============================================================================

describe('GET /api/drives/[driveId]/search/regex', () => {
  const mockUserId = 'user_123';
  const mockDriveId = 'drive_abc';

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/regex?pattern=test`);
      const response = await GET(request, createContext(mockDriveId));

      expect(response.status).toBe(401);
    });

    it('should allow JWT authentication', async () => {
      vi.mocked(checkDriveAccessForSearch).mockResolvedValue(createDriveSearchInfo());
      vi.mocked(regexSearchPages).mockResolvedValue(createRegexSearchResponse());

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/regex?pattern=test`);
      await GET(request, createContext(mockDriveId));

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session', 'mcp'] }
      );
    });

    it('should allow MCP authentication', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
        ...mockWebAuth(mockUserId),
        tokenType: 'mcp',
      } as unknown as SessionAuthResult);
      vi.mocked(checkDriveAccessForSearch).mockResolvedValue(createDriveSearchInfo());
      vi.mocked(regexSearchPages).mockResolvedValue(createRegexSearchResponse());

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/regex?pattern=test`);
      const response = await GET(request, createContext(mockDriveId));

      expect(response.status).toBe(200);
    });
  });

  describe('authorization', () => {
    it('should return 403 when user has no drive access', async () => {
      vi.mocked(checkDriveAccessForSearch).mockResolvedValue(createDriveSearchInfo({
        hasAccess: false,
        drive: null,
      }));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/regex?pattern=test`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe("You don't have access to this drive");
    });

    it('should return 404 when drive not found', async () => {
      vi.mocked(checkDriveAccessForSearch).mockResolvedValue(createDriveSearchInfo({
        hasAccess: true,
        drive: null,
      }));

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

  describe('service integration', () => {
    it('should call checkDriveAccessForSearch with driveId and userId', async () => {
      vi.mocked(checkDriveAccessForSearch).mockResolvedValue(createDriveSearchInfo());
      vi.mocked(regexSearchPages).mockResolvedValue(createRegexSearchResponse());

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/regex?pattern=test`);
      await GET(request, createContext(mockDriveId));

      expect(checkDriveAccessForSearch).toHaveBeenCalledWith(mockDriveId, mockUserId);
    });

    it('should call regexSearchPages with correct parameters', async () => {
      vi.mocked(checkDriveAccessForSearch).mockResolvedValue(createDriveSearchInfo());
      vi.mocked(regexSearchPages).mockResolvedValue(createRegexSearchResponse());

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/regex?pattern=test&maxResults=25`);
      await GET(request, createContext(mockDriveId));

      expect(regexSearchPages).toHaveBeenCalledWith(
        mockDriveId,
        mockUserId,
        'test',
        'test-drive',
        { searchIn: 'content', maxResults: 25 }
      );
    });

    it('should default searchIn to content', async () => {
      vi.mocked(checkDriveAccessForSearch).mockResolvedValue(createDriveSearchInfo());
      vi.mocked(regexSearchPages).mockResolvedValue(createRegexSearchResponse());

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/regex?pattern=test`);
      await GET(request, createContext(mockDriveId));

      expect(regexSearchPages).toHaveBeenCalledWith(
        mockDriveId,
        mockUserId,
        'test',
        'test-drive',
        { searchIn: 'content', maxResults: 50 }
      );
    });

    it('should pass searchIn=title to regexSearchPages', async () => {
      vi.mocked(checkDriveAccessForSearch).mockResolvedValue(createDriveSearchInfo());
      vi.mocked(regexSearchPages).mockResolvedValue(createRegexSearchResponse({ searchIn: 'title' }));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/regex?pattern=Doc&searchIn=title`);
      await GET(request, createContext(mockDriveId));

      expect(regexSearchPages).toHaveBeenCalledWith(
        mockDriveId,
        mockUserId,
        'Doc',
        'test-drive',
        { searchIn: 'title', maxResults: 50 }
      );
    });

    it('should pass searchIn=both to regexSearchPages', async () => {
      vi.mocked(checkDriveAccessForSearch).mockResolvedValue(createDriveSearchInfo());
      vi.mocked(regexSearchPages).mockResolvedValue(createRegexSearchResponse({ searchIn: 'both' }));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/regex?pattern=test&searchIn=both`);
      await GET(request, createContext(mockDriveId));

      expect(regexSearchPages).toHaveBeenCalledWith(
        mockDriveId,
        mockUserId,
        'test',
        'test-drive',
        { searchIn: 'both', maxResults: 50 }
      );
    });

    it('should cap maxResults at 100', async () => {
      vi.mocked(checkDriveAccessForSearch).mockResolvedValue(createDriveSearchInfo());
      vi.mocked(regexSearchPages).mockResolvedValue(createRegexSearchResponse());

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/regex?pattern=test&maxResults=500`);
      await GET(request, createContext(mockDriveId));

      expect(regexSearchPages).toHaveBeenCalledWith(
        mockDriveId,
        mockUserId,
        'test',
        'test-drive',
        { searchIn: 'content', maxResults: 100 }
      );
    });
  });

  describe('response contract', () => {
    it('should return success=true on successful search', async () => {
      vi.mocked(checkDriveAccessForSearch).mockResolvedValue(createDriveSearchInfo());
      vi.mocked(regexSearchPages).mockResolvedValue(createRegexSearchResponse());

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/regex?pattern=test`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });

    it('should include pattern in response', async () => {
      vi.mocked(checkDriveAccessForSearch).mockResolvedValue(createDriveSearchInfo());
      vi.mocked(regexSearchPages).mockResolvedValue(createRegexSearchResponse({ pattern: 'custom-pattern' }));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/regex?pattern=custom-pattern`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(body.pattern).toBe('custom-pattern');
    });

    it('should include searchIn in response', async () => {
      vi.mocked(checkDriveAccessForSearch).mockResolvedValue(createDriveSearchInfo());
      vi.mocked(regexSearchPages).mockResolvedValue(createRegexSearchResponse({ searchIn: 'title' }));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/regex?pattern=test&searchIn=title`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(body.searchIn).toBe('title');
    });

    it('should include driveSlug in response', async () => {
      vi.mocked(checkDriveAccessForSearch).mockResolvedValue(createDriveSearchInfo());
      vi.mocked(regexSearchPages).mockResolvedValue(createRegexSearchResponse({ driveSlug: 'my-drive' }));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/regex?pattern=test`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(body.driveSlug).toBe('my-drive');
    });

    it('should include results array with matchingLines', async () => {
      const mockResults = [
        {
          pageId: 'page_1',
          title: 'Test Doc',
          type: 'DOCUMENT',
          semanticPath: '/test/Test Doc',
          matchingLines: [
            { lineNumber: 2, content: 'This is a test line' },
            { lineNumber: 5, content: 'Another test here' },
          ],
          totalMatches: 2,
        },
      ];
      vi.mocked(checkDriveAccessForSearch).mockResolvedValue(createDriveSearchInfo());
      vi.mocked(regexSearchPages).mockResolvedValue(createRegexSearchResponse({
        results: mockResults,
        totalResults: 1,
      }));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/regex?pattern=test`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(body.results).toHaveLength(1);
      expect(body.results[0]).toHaveProperty('pageId');
      expect(body.results[0]).toHaveProperty('title');
      expect(body.results[0]).toHaveProperty('type');
      expect(body.results[0]).toHaveProperty('semanticPath');
      expect(body.results[0]).toHaveProperty('matchingLines');
      expect(body.results[0]).toHaveProperty('totalMatches');
      expect(body.results[0].matchingLines[0]).toHaveProperty('lineNumber');
      expect(body.results[0].matchingLines[0]).toHaveProperty('content');
    });

    it('should include summary and stats', async () => {
      vi.mocked(checkDriveAccessForSearch).mockResolvedValue(createDriveSearchInfo());
      vi.mocked(regexSearchPages).mockResolvedValue(createRegexSearchResponse());

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/regex?pattern=test`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(body.summary).toBeDefined();
      expect(body.stats).toBeDefined();
      expect(body.stats.pagesScanned).toBeDefined();
      expect(body.stats.pagesWithAccess).toBeDefined();
      expect(body.stats.documentTypes).toBeDefined();
      expect(body.nextSteps).toBeDefined();
    });

    it('should return empty results when no matches', async () => {
      vi.mocked(checkDriveAccessForSearch).mockResolvedValue(createDriveSearchInfo());
      vi.mocked(regexSearchPages).mockResolvedValue(createRegexSearchResponse({
        results: [],
        totalResults: 0,
        stats: {
          pagesScanned: 10,
          pagesWithAccess: 0,
          documentTypes: [],
        },
      }));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/regex?pattern=nomatch`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.results).toHaveLength(0);
      expect(body.totalResults).toBe(0);
    });
  });

  describe('regex pattern handling', () => {
    it('should pass word boundary patterns correctly', async () => {
      vi.mocked(checkDriveAccessForSearch).mockResolvedValue(createDriveSearchInfo());
      vi.mocked(regexSearchPages).mockResolvedValue(createRegexSearchResponse());

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/regex?pattern=\\btest\\b`);
      await GET(request, createContext(mockDriveId));

      expect(regexSearchPages).toHaveBeenCalledWith(
        mockDriveId,
        mockUserId,
        '\\btest\\b',
        'test-drive',
        { searchIn: 'content', maxResults: 50 }
      );
    });

    it('should pass complex regex patterns correctly', async () => {
      vi.mocked(checkDriveAccessForSearch).mockResolvedValue(createDriveSearchInfo());
      vi.mocked(regexSearchPages).mockResolvedValue(createRegexSearchResponse());

      const pattern = 'function\\s+\\w+';
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/regex?pattern=${encodeURIComponent(pattern)}`);
      await GET(request, createContext(mockDriveId));

      expect(regexSearchPages).toHaveBeenCalledWith(
        mockDriveId,
        mockUserId,
        pattern,
        'test-drive',
        { searchIn: 'content', maxResults: 50 }
      );
    });
  });

  describe('error handling', () => {
    it('should return 500 when service throws unexpected error', async () => {
      vi.mocked(checkDriveAccessForSearch).mockRejectedValue(new Error('Database error'));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/regex?pattern=test`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toContain('Regex search failed');
    });

    it('should return 500 when regexSearchPages throws', async () => {
      vi.mocked(checkDriveAccessForSearch).mockResolvedValue(createDriveSearchInfo());
      vi.mocked(regexSearchPages).mockRejectedValue(new Error('Invalid regex pattern'));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/regex?pattern=[invalid`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toContain('Regex search failed');
    });
  });
});
