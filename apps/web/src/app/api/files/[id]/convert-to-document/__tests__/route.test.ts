/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/files/[id]/convert-to-document
//
// Tests the POST handler that converts a Word (.docx) file page to a DOCUMENT
// page using mammoth, then inserts the new page and broadcasts events.
// ============================================================================

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      pages: { findFirst: vi.fn() },
    },
    insert: vi.fn(),
  },
  pages: { id: 'id' },
  eq: vi.fn(),
}));

vi.mock('@pagespace/lib', () => ({
  PageType: {
    FILE: 'FILE',
    DOCUMENT: 'DOCUMENT',
  },
  canConvertToType: vi.fn(),
  canUserEditPage: vi.fn(),
  canUserViewPage: vi.fn(),
  createPageServiceToken: vi.fn(),
}));

vi.mock('mammoth', () => ({
  default: {
    convertToHtml: vi.fn(),
  },
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'new_page_id'),
}));

vi.mock('@/lib/websocket', () => ({
  broadcastPageEvent: vi.fn(),
  createPageEventPayload: vi.fn(),
}));

vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn().mockResolvedValue({ name: 'Test User' }),
  logFileActivity: vi.fn(),
  logPageActivity: vi.fn(),
}));

import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db } from '@pagespace/db';
import {
  canConvertToType,
  canUserEditPage,
  canUserViewPage,
  createPageServiceToken,
} from '@pagespace/lib';
import mammoth from 'mammoth';
import { POST } from '../route';

// ============================================================================
// Test Helpers
// ============================================================================

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session',
  adminRoleVersion: 0,
  role: 'user',
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const createRequest = (body: Record<string, unknown> = { title: 'Converted Doc' }) =>
  new Request('https://example.com/api/files/file_1/convert-to-document', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const createContext = (id = 'file_1') => ({
  params: Promise.resolve({ id }),
});

const mockFilePage = (overrides: Record<string, unknown> = {}) => ({
  id: 'file_1',
  type: 'FILE',
  title: 'document.docx',
  originalFileName: 'document.docx',
  mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  filePath: 'hash_abc123',
  driveId: 'drive_1',
  parentId: 'parent_1',
  position: 1,
  drive: { id: 'drive_1', name: 'My Drive', slug: 'my-drive' },
  ...overrides,
});

const mockFetch = vi.fn();
global.fetch = mockFetch;

// ============================================================================
// Tests
// ============================================================================

describe('POST /api/files/[id]/convert-to-document', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth('user_1'));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(mockFilePage() as any);
    vi.mocked(canConvertToType).mockReturnValue(true);
    vi.mocked(canUserViewPage).mockResolvedValue(true);
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    vi.mocked(createPageServiceToken).mockResolvedValue({ token: 'svc-tok' } as any);
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
    });
    vi.mocked(mammoth.convertToHtml).mockResolvedValue({
      value: '<p>Hello World</p>',
      messages: [],
    } as any);
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{
          id: 'new_page_id',
          title: 'Converted Doc',
          type: 'DOCUMENT',
          parentId: 'parent_1',
        }]),
      }),
    } as any);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const response = await POST(createRequest(), createContext());

      expect(response.status).toBe(401);
    });
  });

  describe('validation', () => {
    it('should return 400 when title is missing', async () => {
      const response = await POST(createRequest({}), createContext());

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('Title is required');
    });

    it('should return 400 when title is not a string', async () => {
      const response = await POST(createRequest({ title: 123 }), createContext());

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('Title is required');
    });

    it('should return 404 when file page not found', async () => {
      vi.mocked(db.query.pages.findFirst).mockResolvedValue(null);

      const response = await POST(createRequest(), createContext());

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe('File not found');
    });

    it('should return 400 when page type cannot be converted', async () => {
      vi.mocked(canConvertToType).mockReturnValue(false);

      const response = await POST(createRequest(), createContext());

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('Cannot convert this page type to document');
    });

    it('should return 400 when file is not a Word document', async () => {
      vi.mocked(db.query.pages.findFirst).mockResolvedValue(
        mockFilePage({ mimeType: 'application/pdf' }) as any
      );

      const response = await POST(createRequest(), createContext());

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('File is not a Word document');
    });
  });

  describe('authorization', () => {
    it('should return 403 when user cannot view the file', async () => {
      vi.mocked(canUserViewPage).mockResolvedValue(false);

      const response = await POST(createRequest(), createContext());

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe('You do not have access to this file');
    });

    it('should return 403 when user cannot edit the file', async () => {
      vi.mocked(canUserEditPage).mockResolvedValue(false);

      const response = await POST(createRequest(), createContext());

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe('You do not have permission to convert this file');
    });
  });

  describe('conversion', () => {
    it('should return 500 when filePath is missing', async () => {
      vi.mocked(db.query.pages.findFirst).mockResolvedValue(
        mockFilePage({ filePath: null }) as any
      );

      const response = await POST(createRequest(), createContext());

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe('File path not found');
    });

    it('should successfully convert a Word document to a page', async () => {
      const response = await POST(createRequest(), createContext());

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.pageId).toBe('new_page_id');
      expect(body.title).toBe('Converted Doc');
    });

    it('should call mammoth.convertToHtml with the fetched buffer', async () => {
      await POST(createRequest(), createContext());

      expect(mammoth.convertToHtml).toHaveBeenCalledWith({
        buffer: expect.any(Buffer),
      });
    });

    it('should accept application/msword MIME type', async () => {
      vi.mocked(db.query.pages.findFirst).mockResolvedValue(
        mockFilePage({ mimeType: 'application/msword' }) as any
      );

      const response = await POST(createRequest(), createContext());

      expect(response.status).toBe(200);
    });

    it('should handle processor returning non-ok response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      const response = await POST(createRequest(), createContext());

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe('Failed to convert document');
    });
  });

  describe('error handling', () => {
    it('should return 500 on unexpected error', async () => {
      vi.mocked(authenticateRequestWithOptions).mockRejectedValue(new Error('Boom'));

      const response = await POST(
        new Request('https://example.com/api/files/x/convert-to-document', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'Test' }),
        }),
        createContext()
      );

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe('Failed to convert document');
    });
  });
});
