import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET } from '../route';
import type { SessionAuthResult, AuthError } from '@/lib/auth';
// Use inferred types to avoid export issues
type DriveSearchInfo = NonNullable<Awaited<ReturnType<typeof import('@pagespace/lib/services/drive-search-service').checkDriveAccessForSearch>>>;
type GlobSearchResponse = Awaited<ReturnType<typeof import('@pagespace/lib/services/drive-search-service').globSearchPages>>;

// ============================================================================
// Contract Tests for /api/drives/[driveId]/search/glob
//
// These tests mock at the SERVICE SEAM level, NOT at the ORM/query-builder level.
// ============================================================================

vi.mock('@pagespace/lib/services/drive-search-service', () => ({
    checkDriveAccessForSearch: vi.fn(),
    globSearchPages: vi.fn(),
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
    auditRequest: vi.fn(),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
    loggers: {
    api: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
  checkMCPDriveScope: vi.fn(() => null), // Allow all drives by default
  isScopedMCPAuth: vi.fn(() => false), // Session/unscoped fixtures by default
}));

vi.mock('@pagespace/lib/permissions/app-permissions', () => ({
  getAppDriveAccessLevel: vi.fn(),
}));

import { checkDriveAccessForSearch, globSearchPages } from '@pagespace/lib/services/drive-search-service';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { PAGE_TYPE_VALUES } from '@pagespace/lib/utils/enums';

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

const createGlobSearchResponse = (overrides: Partial<GlobSearchResponse> = {}): GlobSearchResponse => ({
  driveSlug: overrides.driveSlug ?? 'test-drive',
  pattern: overrides.pattern ?? '*.md',
  results: overrides.results ?? [
    {
      pageId: 'page_1',
      title: 'README.md',
      type: 'DOCUMENT',
      semanticPath: '/test-drive/README.md',
      matchedOn: 'title',
    },
  ],
  totalResults: overrides.totalResults ?? 1,
  summary: overrides.summary ?? 'Found 1 page matching pattern "*.md"',
  stats: overrides.stats ?? {
    totalPagesScanned: 10,
    matchingPages: 1,
    documentTypes: ['DOCUMENT'],
    matchTypes: { path: 0, title: 1 },
  },
  nextSteps: overrides.nextSteps ?? ['Use read_page with the pageId to examine content'],
});

const createContext = (driveId: string) => ({
  params: Promise.resolve({ driveId }),
});

// ============================================================================
// GET /api/drives/[driveId]/search/glob - Contract Tests
// ============================================================================

describe('GET /api/drives/[driveId]/search/glob', () => {
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

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/glob?pattern=*.md`);
      const response = await GET(request, createContext(mockDriveId));

      expect(response.status).toBe(401);
    });

    it('should allow session authentication', async () => {
      vi.mocked(checkDriveAccessForSearch).mockResolvedValue(createDriveSearchInfo());
      vi.mocked(globSearchPages).mockResolvedValue(createGlobSearchResponse());

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/glob?pattern=*.md`);
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
      vi.mocked(globSearchPages).mockResolvedValue(createGlobSearchResponse());

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/glob?pattern=*.md`);
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

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/glob?pattern=*.md`);
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

  describe('service integration', () => {
    it('should call checkDriveAccessForSearch with driveId and userId', async () => {
      vi.mocked(checkDriveAccessForSearch).mockResolvedValue(createDriveSearchInfo());
      vi.mocked(globSearchPages).mockResolvedValue(createGlobSearchResponse());

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/glob?pattern=*.md`);
      await GET(request, createContext(mockDriveId));

      expect(checkDriveAccessForSearch).toHaveBeenCalledWith(mockDriveId, mockUserId);
    });

    it('should call globSearchPages with correct parameters', async () => {
      vi.mocked(checkDriveAccessForSearch).mockResolvedValue(createDriveSearchInfo());
      vi.mocked(globSearchPages).mockResolvedValue(createGlobSearchResponse());

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/glob?pattern=*.md&maxResults=50`);
      await GET(request, createContext(mockDriveId));

      expect(globSearchPages).toHaveBeenCalledWith(
        mockDriveId,
        mockUserId,
        '*.md',
        'test-drive',
        { includeTypes: undefined, maxResults: 50 }
      );
    });

    it('should pass includeTypes to globSearchPages', async () => {
      vi.mocked(checkDriveAccessForSearch).mockResolvedValue(createDriveSearchInfo());
      vi.mocked(globSearchPages).mockResolvedValue(createGlobSearchResponse());

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/glob?pattern=*&includeTypes=DOCUMENT,FOLDER`);
      await GET(request, createContext(mockDriveId));

      expect(globSearchPages).toHaveBeenCalledWith(
        mockDriveId,
        mockUserId,
        '*',
        'test-drive',
        { includeTypes: ['DOCUMENT', 'FOLDER'], maxResults: 100 }
      );
    });

    it('should filter out invalid includeTypes values', async () => {
      vi.mocked(checkDriveAccessForSearch).mockResolvedValue(createDriveSearchInfo());
      vi.mocked(globSearchPages).mockResolvedValue(createGlobSearchResponse());

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/glob?pattern=*&includeTypes=DOCUMENT,INVALID_TYPE`);
      await GET(request, createContext(mockDriveId));

      expect(globSearchPages).toHaveBeenCalledWith(
        mockDriveId,
        mockUserId,
        '*',
        'test-drive',
        { includeTypes: ['DOCUMENT'], maxResults: 100 }
      );
    });

    it('should include TASK_LIST as a valid includeTypes value (#1773)', async () => {
      vi.mocked(checkDriveAccessForSearch).mockResolvedValue(createDriveSearchInfo());
      vi.mocked(globSearchPages).mockResolvedValue(createGlobSearchResponse());

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/glob?pattern=*&includeTypes=TASK_LIST`);
      await GET(request, createContext(mockDriveId));

      expect(globSearchPages).toHaveBeenCalledWith(
        mockDriveId,
        mockUserId,
        '*',
        'test-drive',
        { includeTypes: ['TASK_LIST'], maxResults: 100 }
      );
    });

    it('should not silently drop the filter when TASK_LIST is the only requested type (#1773)', async () => {
      vi.mocked(checkDriveAccessForSearch).mockResolvedValue(createDriveSearchInfo());
      vi.mocked(globSearchPages).mockResolvedValue(createGlobSearchResponse());

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/glob?pattern=*&includeTypes=TASK_LIST`);
      await GET(request, createContext(mockDriveId));

      const [, , , , options] = vi.mocked(globSearchPages).mock.calls[0];
      // Must be a real, non-empty filter — NOT undefined (which would mean "return everything").
      expect(options?.includeTypes).toEqual(['TASK_LIST']);
    });

    // Regression tests for #2150: the route hand-declared VALID_PAGE_TYPES with
    // only 8 of the enum's 10 members, so FILE and MACHINE were stripped from
    // the filter. Asking for FILE alone left an empty array, which
    // globSearchPages treats as "no filter" — the caller silently got EVERY
    // page instead of only files.
    it('should include FILE and MACHINE as valid includeTypes values (#2150)', async () => {
      vi.mocked(checkDriveAccessForSearch).mockResolvedValue(createDriveSearchInfo());
      vi.mocked(globSearchPages).mockResolvedValue(createGlobSearchResponse());

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/glob?pattern=*&includeTypes=FILE,MACHINE`);
      await GET(request, createContext(mockDriveId));

      expect(globSearchPages).toHaveBeenCalledWith(
        mockDriveId,
        mockUserId,
        '*',
        'test-drive',
        { includeTypes: ['FILE', 'MACHINE'], maxResults: 100 }
      );
    });

    it('should not silently widen the search when FILE is the only requested type (#2150)', async () => {
      vi.mocked(checkDriveAccessForSearch).mockResolvedValue(createDriveSearchInfo());
      vi.mocked(globSearchPages).mockResolvedValue(createGlobSearchResponse());

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/glob?pattern=*&includeTypes=FILE`);
      await GET(request, createContext(mockDriveId));

      const [, , , , options] = vi.mocked(globSearchPages).mock.calls[0];
      // Must be a real, non-empty filter — an empty array would mean "return everything".
      expect(options?.includeTypes).toEqual(['FILE']);
    });

    it('should accept every page type in the canonical enum (#2150)', async () => {
      vi.mocked(checkDriveAccessForSearch).mockResolvedValue(createDriveSearchInfo());
      vi.mocked(globSearchPages).mockResolvedValue(createGlobSearchResponse());

      const request = new Request(
        `https://example.com/api/drives/${mockDriveId}/search/glob?pattern=*&includeTypes=${PAGE_TYPE_VALUES.join(',')}`
      );
      await GET(request, createContext(mockDriveId));

      const [, , , , options] = vi.mocked(globSearchPages).mock.calls[0];
      expect(options?.includeTypes).toEqual([...PAGE_TYPE_VALUES]);
    });

    it('should trim whitespace around includeTypes values (#2150)', async () => {
      vi.mocked(checkDriveAccessForSearch).mockResolvedValue(createDriveSearchInfo());
      vi.mocked(globSearchPages).mockResolvedValue(createGlobSearchResponse());

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/glob?pattern=*&includeTypes=FOLDER,%20FILE`);
      await GET(request, createContext(mockDriveId));

      const [, , , , options] = vi.mocked(globSearchPages).mock.calls[0];
      expect(options?.includeTypes).toEqual(['FOLDER', 'FILE']);
    });

    it('should dedupe repeated includeTypes values (#2150)', async () => {
      vi.mocked(checkDriveAccessForSearch).mockResolvedValue(createDriveSearchInfo());
      vi.mocked(globSearchPages).mockResolvedValue(createGlobSearchResponse());

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/glob?pattern=*&includeTypes=FILE,FOLDER,FILE`);
      await GET(request, createContext(mockDriveId));

      const [, , , , options] = vi.mocked(globSearchPages).mock.calls[0];
      expect(options?.includeTypes).toEqual(['FILE', 'FOLDER']);
    });

    it('should cap maxResults at 200', async () => {
      vi.mocked(checkDriveAccessForSearch).mockResolvedValue(createDriveSearchInfo());
      vi.mocked(globSearchPages).mockResolvedValue(createGlobSearchResponse());

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/glob?pattern=*&maxResults=500`);
      await GET(request, createContext(mockDriveId));

      expect(globSearchPages).toHaveBeenCalledWith(
        mockDriveId,
        mockUserId,
        '*',
        'test-drive',
        { includeTypes: undefined, maxResults: 200 }
      );
    });
  });

  describe('response contract', () => {
    it('should return success=true on successful search', async () => {
      vi.mocked(checkDriveAccessForSearch).mockResolvedValue(createDriveSearchInfo());
      vi.mocked(globSearchPages).mockResolvedValue(createGlobSearchResponse());

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/glob?pattern=*.md`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });

    it('should include pattern in response', async () => {
      vi.mocked(checkDriveAccessForSearch).mockResolvedValue(createDriveSearchInfo());
      vi.mocked(globSearchPages).mockResolvedValue(createGlobSearchResponse({ pattern: 'test-pattern' }));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/glob?pattern=test-pattern`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(body.pattern).toBe('test-pattern');
    });

    it('should include driveSlug in response', async () => {
      vi.mocked(checkDriveAccessForSearch).mockResolvedValue(createDriveSearchInfo());
      vi.mocked(globSearchPages).mockResolvedValue(createGlobSearchResponse({ driveSlug: 'my-drive' }));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/glob?pattern=*`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(body.driveSlug).toBe('my-drive');
    });

    it('should include results array', async () => {
      const mockResults = [
        { pageId: 'page_1', title: 'Test', type: 'DOCUMENT', semanticPath: '/test/Test', matchedOn: 'title' as const },
        { pageId: 'page_2', title: 'Test2', type: 'FOLDER', semanticPath: '/test/Test2', matchedOn: 'path' as const },
      ];
      vi.mocked(checkDriveAccessForSearch).mockResolvedValue(createDriveSearchInfo());
      vi.mocked(globSearchPages).mockResolvedValue(createGlobSearchResponse({
        results: mockResults,
        totalResults: 2,
      }));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/glob?pattern=*`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(body.results).toHaveLength(2);
      expect(body.results[0]).toHaveProperty('pageId');
      expect(body.results[0]).toHaveProperty('title');
      expect(body.results[0]).toHaveProperty('type');
      expect(body.results[0]).toHaveProperty('semanticPath');
      expect(body.results[0]).toHaveProperty('matchedOn');
    });

    it('should include summary and stats', async () => {
      vi.mocked(checkDriveAccessForSearch).mockResolvedValue(createDriveSearchInfo());
      vi.mocked(globSearchPages).mockResolvedValue(createGlobSearchResponse());

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/glob?pattern=*`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(body.summary).toBe('Found 1 page matching pattern "*.md"');
      expect(body.stats).toEqual({
        totalPagesScanned: 10,
        matchingPages: 1,
        documentTypes: ['DOCUMENT'],
        matchTypes: { path: 0, title: 1 },
      });
      expect(body.stats.totalPagesScanned).toBe(10);
      expect(body.stats.matchingPages).toBe(1);
      expect(body.stats.documentTypes).toEqual(['DOCUMENT']);
      expect(body.stats.matchTypes).toEqual({ path: 0, title: 1 });
      expect(body.nextSteps).toEqual(['Use read_page with the pageId to examine content']);
    });

    it('should return empty results when no matches', async () => {
      vi.mocked(checkDriveAccessForSearch).mockResolvedValue(createDriveSearchInfo());
      vi.mocked(globSearchPages).mockResolvedValue(createGlobSearchResponse({
        results: [],
        totalResults: 0,
        stats: {
          totalPagesScanned: 10,
          matchingPages: 0,
          documentTypes: [],
          matchTypes: { path: 0, title: 0 },
        },
      }));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/glob?pattern=nomatch`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.results).toHaveLength(0);
      expect(body.totalResults).toBe(0);
    });
  });

  describe('error handling', () => {
    it('should return 500 when service throws unexpected error', async () => {
      vi.mocked(checkDriveAccessForSearch).mockRejectedValueOnce(new Error('Database error'));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/glob?pattern=*`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toContain('Glob search failed');
    });

    it('should return 500 when globSearchPages throws', async () => {
      vi.mocked(checkDriveAccessForSearch).mockResolvedValue(createDriveSearchInfo());
      vi.mocked(globSearchPages).mockRejectedValueOnce(new Error('Search failed'));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/search/glob?pattern=*`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toContain('Glob search failed');
    });
  });
});
