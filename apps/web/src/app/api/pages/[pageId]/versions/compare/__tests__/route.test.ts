/**
 * Contract tests for GET /api/pages/[pageId]/versions/compare
 *
 * These tests verify the route handler's contract:
 * - Authentication and MCP scope checks
 * - Permission checks (canUserViewPage)
 * - Query parameter validation (Zod schema)
 * - Version existence and page ownership validation
 * - Content resolution (contentRef vs contentSnapshot)
 * - Diff generation and response building
 * - Error handling
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const {
  mockAuthenticateRequest,
  mockIsAuthError,
  mockCheckMCPPageScope,
  mockCanUserViewPage,
  mockGetActivityById,
  mockReadPageContent,
  mockDiffContent,
  mockSummarizeDiff,
  mockMaskIdentifier,
  mockLoggers,
} = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockIsAuthError: vi.fn((result: unknown) => result != null && typeof result === 'object' && 'error' in result),
  mockCheckMCPPageScope: vi.fn().mockResolvedValue(null),
  mockCanUserViewPage: vi.fn(),
  mockGetActivityById: vi.fn(),
  mockReadPageContent: vi.fn(),
  mockDiffContent: vi.fn(),
  mockSummarizeDiff: vi.fn(),
  mockMaskIdentifier: vi.fn((id: string) => `***${id?.slice(-4)}`),
  mockLoggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

// ── vi.mock declarations ───────────────────────────────────────────────────

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: (...args: unknown[]) => mockAuthenticateRequest(...args),
  isAuthError: (result: unknown) => mockIsAuthError(result),
  checkMCPPageScope: (...args: unknown[]) => mockCheckMCPPageScope(...args),
}));

vi.mock('@pagespace/lib', () => ({
  canUserViewPage: (...args: unknown[]) => mockCanUserViewPage(...args),
}));

vi.mock('@/services/api', () => ({
  getActivityById: (...args: unknown[]) => mockGetActivityById(...args),
}));

vi.mock('@pagespace/lib/server', () => ({
  readPageContent: (...args: unknown[]) => mockReadPageContent(...args),
  loggers: mockLoggers,
  auditRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/content', () => ({
  diffContent: (...args: unknown[]) => mockDiffContent(...args),
  summarizeDiff: (...args: unknown[]) => mockSummarizeDiff(...args),
}));

vi.mock('@/lib/logging/mask', () => ({
  // @ts-expect-error - test mock spread
  maskIdentifier: (...args: unknown[]) => mockMaskIdentifier(...args),
}));

// ── Imports (after mocks) ──────────────────────────────────────────────────

import { GET } from '../../compare/route';

// ── Helpers ────────────────────────────────────────────────────────────────

const mockUserId = 'user_123';
const mockPageId = 'page_123';

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  role: 'user',
  adminRoleVersion: 0,
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const createRequest = (params: Record<string, string> = {}) => {
  const url = new URL(`https://example.com/api/pages/${mockPageId}/versions/compare`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new Request(url.toString(), { method: 'GET' });
};

const mockParams = { params: Promise.resolve({ pageId: mockPageId }) };

const mockActivity1 = {
  id: 'v1_id',
  timestamp: new Date('2024-01-01'),
  userId: mockUserId,
  actorEmail: 'user@example.com',
  actorDisplayName: 'Test User',
  operation: 'update',
  resourceType: 'page',
  resourceId: mockPageId,
  resourceTitle: 'Test Page',
  driveId: 'drive_1',
  pageId: mockPageId,
  isAiGenerated: false,
  aiProvider: null,
  aiModel: null,
  contentSnapshot: '<h1>Version 1</h1>',
  contentRef: null,
  contentFormat: 'html',
  contentSize: 20,
  updatedFields: ['content'],
  previousValues: null,
  newValues: null,
  metadata: null,
  streamId: null,
  streamSeq: null,
  changeGroupId: null,
  changeGroupType: null,
  stateHashBefore: null,
  stateHashAfter: null,
  rollbackFromActivityId: null,
  rollbackSourceOperation: null,
  rollbackSourceTimestamp: null,
  rollbackSourceTitle: null,
};

const mockActivity2 = {
  ...mockActivity1,
  id: 'v2_id',
  timestamp: new Date('2024-01-02'),
  contentSnapshot: '<h1>Version 2</h1>',
  contentRef: null,
  contentFormat: 'html',
  contentSize: 20,
};

const mockDiffResult = {
  isIdentical: false,
  changes: [{ type: 'modified', value: 'test' }],
  stats: { additions: 1, deletions: 1, modifications: 1 },
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe('GET /api/pages/[pageId]/versions/compare', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAuthenticateRequest.mockResolvedValue(mockWebAuth(mockUserId));
    mockIsAuthError.mockImplementation((result: unknown) => result != null && typeof result === 'object' && 'error' in result);
    mockCheckMCPPageScope.mockResolvedValue(null);
    mockCanUserViewPage.mockResolvedValue(true);
    mockGetActivityById
      .mockResolvedValueOnce(mockActivity1)
      .mockResolvedValueOnce(mockActivity2);
    mockDiffContent.mockReturnValue(mockDiffResult);
    mockSummarizeDiff.mockReturnValue('1 addition, 1 deletion');
  });

  describe('authentication', () => {
    it('returns 401 when user is not authenticated', async () => {
      mockAuthenticateRequest.mockResolvedValue(mockAuthError(401));

      const response = await GET(
        createRequest({ v1: 'v1_id', v2: 'v2_id' }),
        mockParams
      );

      expect(response.status).toBe(401);
    });
  });

  describe('MCP scope checking', () => {
    it('returns scope error when MCP token lacks page scope', async () => {
      mockCheckMCPPageScope.mockResolvedValue(
        NextResponse.json({ error: 'Scope denied' }, { status: 403 })
      );

      const response = await GET(
        createRequest({ v1: 'v1_id', v2: 'v2_id' }),
        mockParams
      );

      expect(response.status).toBe(403);
    });
  });

  describe('authorization', () => {
    it('returns 403 when user cannot view the page', async () => {
      mockCanUserViewPage.mockResolvedValue(false);

      const response = await GET(
        createRequest({ v1: 'v1_id', v2: 'v2_id' }),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toMatch(/unauthorized/i);
    });
  });

  describe('query parameter validation', () => {
    it('returns 400 when v1 is missing', async () => {
      const response = await GET(
        createRequest({ v2: 'v2_id' }),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid input: expected string, received undefined');
    });

    it('returns 400 when v2 is missing', async () => {
      const response = await GET(
        createRequest({ v1: 'v1_id' }),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid input: expected string, received undefined');
    });

    it('returns 400 when both v1 and v2 are missing', async () => {
      const response = await GET(createRequest(), mockParams);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid input: expected string, received undefined. Invalid input: expected string, received undefined');
    });
  });

  describe('version validation', () => {
    it('returns 404 when version 1 is not found', async () => {
      mockGetActivityById.mockReset();
      mockGetActivityById
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(mockActivity2);

      const response = await GET(
        createRequest({ v1: 'nonexistent', v2: 'v2_id' }),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toMatch(/nonexistent/);
    });

    it('returns 404 when version 2 is not found', async () => {
      mockGetActivityById.mockReset();
      mockGetActivityById
        .mockResolvedValueOnce(mockActivity1)
        .mockResolvedValueOnce(null);

      const response = await GET(
        createRequest({ v1: 'v1_id', v2: 'nonexistent' }),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toMatch(/nonexistent/);
    });

    it('returns 400 when version 1 belongs to a different page', async () => {
      mockGetActivityById.mockReset();
      mockGetActivityById
        .mockResolvedValueOnce({ ...mockActivity1, pageId: 'other_page' })
        .mockResolvedValueOnce(mockActivity2);

      const response = await GET(
        createRequest({ v1: 'v1_id', v2: 'v2_id' }),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toMatch(/does not belong/);
    });

    it('returns 400 when version 2 belongs to a different page', async () => {
      mockGetActivityById.mockReset();
      mockGetActivityById
        .mockResolvedValueOnce(mockActivity1)
        .mockResolvedValueOnce({ ...mockActivity2, pageId: 'other_page' });

      const response = await GET(
        createRequest({ v1: 'v1_id', v2: 'v2_id' }),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toMatch(/does not belong/);
    });
  });

  describe('content resolution', () => {
    it('uses contentSnapshot when contentRef is null', async () => {
      const response = await GET(
        createRequest({ v1: 'v1_id', v2: 'v2_id' }),
        mockParams
      );

      expect(response.status).toBe(200);
      expect(mockDiffContent).toHaveBeenCalledWith(
        '<h1>Version 1</h1>',
        '<h1>Version 2</h1>',
        { lineMode: false, prettyPrint: true, format: 'html' }
      );
    });

    it('reads content from contentRef when available', async () => {
      mockGetActivityById.mockReset();
      mockGetActivityById
        .mockResolvedValueOnce({ ...mockActivity1, contentRef: 'ref/path/1', contentSnapshot: null })
        .mockResolvedValueOnce(mockActivity2);
      mockReadPageContent.mockResolvedValue('<h1>Ref Content</h1>');

      const response = await GET(
        createRequest({ v1: 'v1_id', v2: 'v2_id' }),
        mockParams
      );

      expect(response.status).toBe(200);
      expect(mockReadPageContent).toHaveBeenCalledWith('ref/path/1');
      expect(mockDiffContent).toHaveBeenCalledWith(
        '<h1>Ref Content</h1>',
        '<h1>Version 2</h1>',
        { lineMode: false, prettyPrint: true, format: 'html' }
      );
    });

    it('falls back to contentSnapshot when contentRef read fails', async () => {
      mockGetActivityById.mockReset();
      mockGetActivityById
        .mockResolvedValueOnce({
          ...mockActivity1,
          contentRef: 'ref/path/1',
          contentSnapshot: '<h1>Snapshot Fallback</h1>',
        })
        .mockResolvedValueOnce(mockActivity2);
      mockReadPageContent.mockRejectedValueOnce(new Error('Read failed'));

      const response = await GET(
        createRequest({ v1: 'v1_id', v2: 'v2_id' }),
        mockParams
      );

      expect(response.status).toBe(200);
      expect(mockDiffContent).toHaveBeenCalledWith(
        '<h1>Snapshot Fallback</h1>',
        '<h1>Version 2</h1>',
        { lineMode: false, prettyPrint: true, format: 'html' }
      );
    });

    it('returns 400 when version 1 has no content at all', async () => {
      mockGetActivityById.mockReset();
      mockGetActivityById
        .mockResolvedValueOnce({
          ...mockActivity1,
          contentRef: null,
          contentSnapshot: null,
        })
        .mockResolvedValueOnce(mockActivity2);

      const response = await GET(
        createRequest({ v1: 'v1_id', v2: 'v2_id' }),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toMatch(/no content/i);
    });

    it('returns 400 when version 2 has no content at all', async () => {
      mockGetActivityById.mockReset();
      mockGetActivityById
        .mockResolvedValueOnce(mockActivity1)
        .mockResolvedValueOnce({
          ...mockActivity2,
          contentRef: null,
          contentSnapshot: null,
        });

      const response = await GET(
        createRequest({ v1: 'v1_id', v2: 'v2_id' }),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toMatch(/no content/i);
    });

    it('handles non-Error exception during contentRef read', async () => {
      mockGetActivityById.mockReset();
      mockGetActivityById
        .mockResolvedValueOnce({
          ...mockActivity1,
          contentRef: 'ref/path/1',
          contentSnapshot: '<h1>Fallback</h1>',
        })
        .mockResolvedValueOnce(mockActivity2);
      mockReadPageContent.mockRejectedValueOnce('string error');

      const response = await GET(
        createRequest({ v1: 'v1_id', v2: 'v2_id' }),
        mockParams
      );

      expect(response.status).toBe(200);
    });
  });

  describe('diff options', () => {
    it('passes lineMode and prettyPrint options from query params', async () => {
      // Note: z.coerce.boolean() coerces any non-empty string to true
      // (Boolean('true') === true, Boolean('false') === true)
      await GET(
        createRequest({ v1: 'v1_id', v2: 'v2_id', lineMode: 'true', prettyPrint: 'true' }),
        mockParams
      );

      expect(mockDiffContent).toHaveBeenCalledWith(
        '<h1>Version 1</h1>',
        '<h1>Version 2</h1>',
        { lineMode: true, prettyPrint: true, format: 'html' }
      );
    });

    it('uses default options when lineMode and prettyPrint are not specified', async () => {
      await GET(
        createRequest({ v1: 'v1_id', v2: 'v2_id' }),
        mockParams
      );

      expect(mockDiffContent).toHaveBeenCalledWith(
        '<h1>Version 1</h1>',
        '<h1>Version 2</h1>',
        { lineMode: false, prettyPrint: true, format: 'html' }
      );
    });

    it('includes content format from activity1 when available', async () => {
      await GET(
        createRequest({ v1: 'v1_id', v2: 'v2_id' }),
        mockParams
      );

      expect(mockDiffContent).toHaveBeenCalledWith(
        '<h1>Version 1</h1>',
        '<h1>Version 2</h1>',
        { lineMode: false, prettyPrint: true, format: 'html' }
      );
    });

    it('omits format when activity1 has no contentFormat', async () => {
      mockGetActivityById.mockReset();
      mockGetActivityById
        .mockResolvedValueOnce({ ...mockActivity1, contentFormat: null })
        .mockResolvedValueOnce(mockActivity2);

      await GET(
        createRequest({ v1: 'v1_id', v2: 'v2_id' }),
        mockParams
      );

      const options = mockDiffContent.mock.calls[0][2];
      expect(options.format).toBeUndefined();
    });
  });

  describe('successful response', () => {
    it('returns diff, summary, and version metadata', async () => {
      const response = await GET(
        createRequest({ v1: 'v1_id', v2: 'v2_id' }),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.diff).toEqual(mockDiffResult);
      expect(body.summary).toBe('1 addition, 1 deletion');
      expect(body.versions.v1.id).toBe('v1_id');
      expect(body.versions.v1.operation).toBe('update');
      expect(body.versions.v1.actorEmail).toBe('user@example.com');
      expect(body.versions.v1.actorDisplayName).toBe('Test User');
      expect(body.versions.v1.contentSize).toBe(20);
      expect(body.versions.v1.contentFormat).toBe('html');
      expect(body.versions.v1.isAiGenerated).toBe(false);
      expect(body.versions.v2.id).toBe('v2_id');
    });
  });
});
