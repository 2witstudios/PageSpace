/**
 * Contract tests for POST /api/pages/[pageId]/convert-content-mode
 *
 * These tests verify the route handler's contract:
 * - Authentication and permission checks
 * - Request body validation (Zod schema)
 * - Content mode conversion logic (html->markdown, markdown->html)
 * - Version snapshot creation before conversion
 * - Side effects: broadcasts
 * - Error handling
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const {
  mockApplyPageMutation,
  mockAuthenticateRequest,
  mockIsAuthError,
  mockBroadcastPageEvent,
  mockCreatePageEventPayload,
  mockPagesFindFirst,
  mockCanUserEditPage,
  mockCreatePageVersion,
  mockTurndown,
  mockMarkedParse,
  mockLoggers,
} = vi.hoisted(() => ({
  mockApplyPageMutation: vi.fn(),
  mockAuthenticateRequest: vi.fn(),
  mockIsAuthError: vi.fn((result: unknown) => result != null && typeof result === 'object' && 'error' in result),
  mockBroadcastPageEvent: vi.fn(),
  mockCreatePageEventPayload: vi.fn((driveId: string, pageId: string, type: string, data: Record<string, unknown>) => ({
    driveId, pageId, type, ...data,
  })),
  mockPagesFindFirst: vi.fn(),
  mockCanUserEditPage: vi.fn(),
  mockCreatePageVersion: vi.fn().mockResolvedValue(undefined),
  mockTurndown: vi.fn().mockReturnValue('# Converted Markdown'),
  mockMarkedParse: vi.fn().mockResolvedValue('<h1>Converted HTML</h1>'),
  mockLoggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

// ── vi.mock declarations ───────────────────────────────────────────────────

vi.mock('@/services/api/page-mutation-service', () => ({
  applyPageMutation: (...args: unknown[]) => mockApplyPageMutation(...args),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: (...args: unknown[]) => mockAuthenticateRequest(...args),
  isAuthError: (result: unknown) => mockIsAuthError(result),
}));

vi.mock('@/lib/websocket', () => ({
  broadcastPageEvent: (...args: unknown[]) => mockBroadcastPageEvent(...args),
  // @ts-expect-error - test mock spread
  createPageEventPayload: (...args: unknown[]) => mockCreatePageEventPayload(...args),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      pages: {
        findFirst: (...args: unknown[]) => mockPagesFindFirst(...args),
      },
    },
  },
  pages: { id: 'id' },
  eq: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  canUserEditPage: (...args: unknown[]) => mockCanUserEditPage(...args),
  createPageVersion: (...args: unknown[]) => mockCreatePageVersion(...args),
  loggers: mockLoggers,
  auditRequest: vi.fn(),
}));

vi.mock('turndown', () => ({
  default: vi.fn().mockImplementation(() => ({
    turndown: (...args: unknown[]) => mockTurndown(...args),
  })),
}));

vi.mock('marked', () => ({
  marked: {
    parse: (...args: unknown[]) => mockMarkedParse(...args),
  },
}));

// ── Imports (after mocks) ──────────────────────────────────────────────────

import { POST } from '../../convert-content-mode/route';

// ── Helpers ────────────────────────────────────────────────────────────────

const mockUserId = 'user_123';
const mockPageId = 'page_123';
const mockDriveId = 'drive_123';

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

const createRequest = (body: Record<string, unknown>) =>
  new Request(`https://example.com/api/pages/${mockPageId}/convert-content-mode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const mockParams = { params: Promise.resolve({ pageId: mockPageId }) };

const mockDocPage = {
  id: mockPageId,
  title: 'Test Document',
  type: 'DOCUMENT',
  content: '<h1>Hello</h1>',
  contentMode: 'html',
  driveId: mockDriveId,
  revision: 5,
  stateHash: 'hash123',
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/pages/[pageId]/convert-content-mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthenticateRequest.mockResolvedValue(mockWebAuth(mockUserId));
    mockCanUserEditPage.mockResolvedValue(true);
    mockTurndown.mockReturnValue('# Converted Markdown');
    mockMarkedParse.mockResolvedValue('<h1>Converted HTML</h1>');
    mockPagesFindFirst
      .mockResolvedValueOnce(mockDocPage)       // first call: fetch current page
      .mockResolvedValueOnce({                   // second call: refetch after update
        ...mockDocPage,
        content: '# Converted Markdown',
        contentMode: 'markdown',
        revision: 6,
      });
    mockApplyPageMutation.mockResolvedValue({});
  });

  describe('authentication', () => {
    it('returns 401 when user is not authenticated', async () => {
      mockAuthenticateRequest.mockResolvedValue(mockAuthError(401));

      const response = await POST(createRequest({ targetMode: 'markdown' }), mockParams);

      expect(response.status).toBe(401);
    });
  });

  describe('validation', () => {
    it('returns 400 for invalid targetMode', async () => {
      const response = await POST(
        createRequest({ targetMode: 'invalid' }),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(Array.isArray(body.error)).toBe(true);
    });

    it('returns 400 for missing targetMode', async () => {
      const response = await POST(createRequest({}), mockParams);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(Array.isArray(body.error)).toBe(true);
    });
  });

  describe('authorization', () => {
    it('returns 403 when user lacks edit permission', async () => {
      mockCanUserEditPage.mockResolvedValue(false);

      const response = await POST(
        createRequest({ targetMode: 'markdown' }),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toMatch(/edit permission/i);
    });
  });

  describe('page validation', () => {
    it('returns 404 when page not found', async () => {
      mockPagesFindFirst.mockReset();
      mockPagesFindFirst.mockResolvedValue(null);

      const response = await POST(
        createRequest({ targetMode: 'markdown' }),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toMatch(/not found/i);
    });

    it('returns 400 when page is not a DOCUMENT type', async () => {
      mockPagesFindFirst.mockReset();
      mockPagesFindFirst.mockResolvedValue({
        ...mockDocPage,
        type: 'AI_CHAT',
      });

      const response = await POST(
        createRequest({ targetMode: 'markdown' }),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toMatch(/DOCUMENT/i);
    });

    it('returns 400 when page is already in target mode', async () => {
      mockPagesFindFirst.mockReset();
      mockPagesFindFirst.mockResolvedValue({
        ...mockDocPage,
        contentMode: 'markdown',
      });

      const response = await POST(
        createRequest({ targetMode: 'markdown' }),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toMatch(/already in markdown/i);
    });
  });

  describe('html to markdown conversion', () => {
    it('converts html to markdown successfully', async () => {
      const response = await POST(
        createRequest({ targetMode: 'markdown' }),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.contentMode).toBe('markdown');
    });

    it('creates a version snapshot before conversion', async () => {
      await POST(createRequest({ targetMode: 'markdown' }), mockParams);

      expect(mockCreatePageVersion).toHaveBeenCalledWith(
        expect.objectContaining({
          pageId: mockPageId,
          driveId: mockDriveId,
          createdBy: mockUserId,
          source: 'system',
          content: '<h1>Hello</h1>',
          pageRevision: 5,
          stateHash: 'hash123',
          metadata: { reason: 'pre-conversion to markdown' },
        })
      );
    });

    it('calls applyPageMutation with converted content', async () => {
      await POST(createRequest({ targetMode: 'markdown' }), mockParams);

      expect(mockApplyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          pageId: mockPageId,
          operation: 'update',
          updates: expect.objectContaining({
            content: '# Converted Markdown',
            contentMode: 'markdown',
          }),
          updatedFields: ['content', 'contentMode'],
          expectedRevision: 5,
          context: { userId: mockUserId },
        })
      );
    });
  });

  describe('markdown to html conversion', () => {
    it('converts markdown to html successfully', async () => {
      mockPagesFindFirst.mockReset();
      mockPagesFindFirst
        .mockResolvedValueOnce({
          ...mockDocPage,
          content: '# Hello',
          contentMode: 'markdown',
        })
        .mockResolvedValueOnce({
          ...mockDocPage,
          content: '<h1>Converted HTML</h1>',
          contentMode: 'html',
          revision: 6,
        });

      const response = await POST(
        createRequest({ targetMode: 'html' }),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.contentMode).toBe('html');
    });
  });

  describe('empty content handling', () => {
    it('converts empty/null content without errors', async () => {
      mockPagesFindFirst.mockReset();
      mockPagesFindFirst
        .mockResolvedValueOnce({
          ...mockDocPage,
          content: null,
          stateHash: null,
        })
        .mockResolvedValueOnce({
          ...mockDocPage,
          content: '',
          contentMode: 'markdown',
        });

      const response = await POST(
        createRequest({ targetMode: 'markdown' }),
        mockParams
      );

      expect(response.status).toBe(200);
      expect(mockCreatePageVersion).toHaveBeenCalledWith(
        expect.objectContaining({
          content: '',
          stateHash: '',
        })
      );
    });
  });

  describe('side effects', () => {
    it('broadcasts content-updated event', async () => {
      await POST(createRequest({ targetMode: 'markdown' }), mockParams);

      expect(mockCreatePageEventPayload).toHaveBeenCalledWith(
        mockDriveId,
        mockPageId,
        'content-updated',
        expect.objectContaining({ title: 'Test Document' })
      );
      expect(mockBroadcastPageEvent).toHaveBeenCalledWith(
        expect.objectContaining({ driveId: mockDriveId, pageId: mockPageId, type: 'content-updated' })
      );
    });
  });

  describe('error handling', () => {
    it('returns 500 for unexpected errors', async () => {
      mockPagesFindFirst.mockReset();
      mockCanUserEditPage.mockRejectedValueOnce(new Error('DB failure'));

      const response = await POST(
        createRequest({ targetMode: 'markdown' }),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to convert content mode');
    });

    it('returns 400 with Zod issues for schema validation errors', async () => {
      const response = await POST(
        createRequest({ targetMode: 123 }),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(Array.isArray(body.error)).toBe(true);
    });
  });
});
