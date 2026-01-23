import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { NextResponse } from 'next/server';
import { GET } from '../route';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// Mock dependencies
vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      pages: {
        findFirst: vi.fn(),
      },
    },
  },
  pages: { id: 'pages.id' },
  eq: vi.fn((field: unknown, value: unknown) => ({ field, value, type: 'eq' })),
}));

vi.mock('@pagespace/lib/server', () => ({
  canUserViewPage: vi.fn(),
  loggers: {
    api: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

vi.mock('@pagespace/lib', () => ({
  generateDOCX: vi.fn(),
  sanitizeFilename: vi.fn((name: string) => name.replace(/[^a-zA-Z0-9-_]/g, '_')),
}));

vi.mock('@pagespace/lib/activity-tracker', () => ({
  trackPageOperation: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result) => 'error' in result),
}));

import { db } from '@pagespace/db';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { canUserViewPage } from '@pagespace/lib/server';
import { generateDOCX, sanitizeFilename } from '@pagespace/lib';
import { trackPageOperation } from '@pagespace/lib/activity-tracker';

// Helper to create mock SessionAuthResult
const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  
  role: 'user',
});

// Helper to create mock AuthError
const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

// Helper to create mock page
const mockPage = (overrides?: Partial<{
  id: string;
  title: string;
  type: string;
  content: string;
}>) => ({
  id: overrides?.id ?? 'page_123',
  title: overrides?.title ?? 'Test Document',
  type: overrides?.type ?? 'DOCUMENT',
  content: overrides?.content ?? '<p>Hello World</p>',
  driveId: 'drive_123',
  parentId: null,
  position: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  isTrashed: false,
});

describe('GET /api/pages/[pageId]/export/docx', () => {
  const mockUserId = 'user_123';
  const mockPageId = 'page_123';

  const createRequest = () => {
    return new Request(`https://example.com/api/pages/${mockPageId}/export/docx`, {
      method: 'GET',
    });
  };

  const mockParams = Promise.resolve({ pageId: mockPageId });

  beforeEach(() => {
    vi.clearAllMocks();
    (authenticateRequestWithOptions as Mock).mockResolvedValue(mockWebAuth(mockUserId));
    (canUserViewPage as Mock).mockResolvedValue(true);
    (db.query.pages.findFirst as Mock).mockResolvedValue(mockPage());
    (generateDOCX as Mock).mockResolvedValue(Buffer.from('mock docx content'));
    (sanitizeFilename as Mock).mockReturnValue('Test_Document');
  });

  describe('authentication', () => {
    it('returns 401 when user is not authenticated', async () => {
      (authenticateRequestWithOptions as Mock).mockResolvedValue(mockAuthError(401));

      const response = await GET(createRequest(), { params: mockParams });

      expect(response.status).toBe(401);
    });
  });

  describe('authorization', () => {
    it('returns 403 when user lacks view permission', async () => {
      (canUserViewPage as Mock).mockResolvedValue(false);

      const response = await GET(createRequest(), { params: mockParams });

      expect(response.status).toBe(403);
    });
  });

  describe('page validation', () => {
    it('returns 404 when page does not exist', async () => {
      (db.query.pages.findFirst as Mock).mockResolvedValue(null);

      const response = await GET(createRequest(), { params: mockParams });

      expect(response.status).toBe(404);
    });

    it('returns 400 when page is not a DOCUMENT type', async () => {
      (db.query.pages.findFirst as Mock).mockResolvedValue(mockPage({ type: 'FOLDER' }));

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('DOCX export is only available for DOCUMENT pages');
    });

    it('returns 400 for AI_CHAT page type', async () => {
      (db.query.pages.findFirst as Mock).mockResolvedValue(mockPage({ type: 'AI_CHAT' }));

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('DOCX export is only available for DOCUMENT pages');
    });

    it('returns 400 for SHEET page type', async () => {
      (db.query.pages.findFirst as Mock).mockResolvedValue(mockPage({ type: 'SHEET' }));

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('DOCX export is only available for DOCUMENT pages');
    });
  });

  describe('DOCX generation', () => {
    it('generates DOCX file successfully', async () => {
      const docxBuffer = Buffer.from('mock docx content');
      (generateDOCX as Mock).mockResolvedValue(docxBuffer);

      const response = await GET(createRequest(), { params: mockParams });

      expect(response.status).toBe(200);
      expect(generateDOCX).toHaveBeenCalledWith('<p>Hello World</p>', 'Test Document');
    });

    it('returns correct content type header', async () => {
      const response = await GET(createRequest(), { params: mockParams });

      expect(response.headers.get('Content-Type')).toBe(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      );
    });

    it('returns correct content disposition header', async () => {
      const response = await GET(createRequest(), { params: mockParams });

      expect(response.headers.get('Content-Disposition')).toContain('attachment');
      expect(response.headers.get('Content-Disposition')).toContain('.docx');
    });

    it('uses default content when page has no content', async () => {
      (db.query.pages.findFirst as Mock).mockResolvedValue(mockPage({ content: '' }));

      await GET(createRequest(), { params: mockParams });

      expect(generateDOCX).toHaveBeenCalledWith('<p>No content</p>', expect.any(String));
    });

    it('uses fallback filename when title cannot be sanitized', async () => {
      (sanitizeFilename as Mock).mockReturnValue('');

      const response = await GET(createRequest(), { params: mockParams });

      expect(response.headers.get('Content-Disposition')).toContain('document.docx');
    });
  });

  describe('activity tracking', () => {
    it('tracks the export operation', async () => {
      await GET(createRequest(), { params: mockParams });

      expect(trackPageOperation).toHaveBeenCalledWith(
        mockUserId,
        'read',
        mockPageId,
        expect.objectContaining({
          exportFormat: 'docx',
          pageTitle: 'Test Document',
        })
      );
    });
  });

  describe('error handling', () => {
    it('returns 500 when DOCX generation fails', async () => {
      (generateDOCX as Mock).mockRejectedValue(new Error('Generation failed'));

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to export page as DOCX');
    });

    it('returns 500 when database query fails', async () => {
      (db.query.pages.findFirst as Mock).mockRejectedValue(new Error('Database error'));

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to export page as DOCX');
    });
  });
});
