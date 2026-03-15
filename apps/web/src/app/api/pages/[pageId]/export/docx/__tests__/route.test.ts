import { describe, it, expect, beforeEach, vi } from 'vitest';
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
  checkMCPPageScope: vi.fn().mockResolvedValue(null),
}));

vi.mock('marked', () => ({
  marked: {
    parse: vi.fn(() => Promise.resolve('<h1>Hello World</h1>')),
  },
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
  adminRoleVersion: 0,
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
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(canUserViewPage).mockResolvedValue(true);
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(mockPage() as never);
    vi.mocked(generateDOCX).mockResolvedValue(Buffer.from('mock docx content'));
    vi.mocked(sanitizeFilename).mockReturnValue('Test_Document');
  });

  describe('authentication', () => {
    it('returns 401 when user is not authenticated', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const response = await GET(createRequest(), { params: mockParams });

      expect(response.status).toBe(401);
    });
  });

  describe('authorization', () => {
    it('returns 403 when user lacks view permission', async () => {
      vi.mocked(canUserViewPage).mockResolvedValue(false);

      const response = await GET(createRequest(), { params: mockParams });

      expect(response.status).toBe(403);
    });
  });

  describe('page validation', () => {
    it('returns 404 when page does not exist', async () => {
      vi.mocked(db.query.pages.findFirst).mockResolvedValue(null as never);

      const response = await GET(createRequest(), { params: mockParams });

      expect(response.status).toBe(404);
    });

    it('returns 400 when page is not a DOCUMENT type', async () => {
      vi.mocked(db.query.pages.findFirst).mockResolvedValue(mockPage({ type: 'FOLDER' }) as never);

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('DOCX export is only available for DOCUMENT pages');
    });

    it('returns 400 for AI_CHAT page type', async () => {
      vi.mocked(db.query.pages.findFirst).mockResolvedValue(mockPage({ type: 'AI_CHAT' }) as never);

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('DOCX export is only available for DOCUMENT pages');
    });

    it('returns 400 for SHEET page type', async () => {
      vi.mocked(db.query.pages.findFirst).mockResolvedValue(mockPage({ type: 'SHEET' }) as never);

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('DOCX export is only available for DOCUMENT pages');
    });
  });

  describe('DOCX generation', () => {
    it('generates DOCX file successfully', async () => {
      const docxBuffer = Buffer.from('mock docx content');
      vi.mocked(generateDOCX).mockResolvedValue(docxBuffer);

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

    it('converts markdown content to HTML before generating DOCX', async () => {
      vi.mocked(db.query.pages.findFirst).mockResolvedValue({
        ...mockPage(),
        contentMode: 'markdown',
        content: '# Hello World',
      } as never);

      await GET(createRequest(), { params: mockParams });

      // generateDOCX should receive HTML converted from markdown, not the raw markdown
      expect(generateDOCX).toHaveBeenCalledWith(
        '<h1>Hello World</h1>',
        'Test Document'
      );
    });

    it('uses default content when page has no content', async () => {
      vi.mocked(db.query.pages.findFirst).mockResolvedValue(mockPage({ content: '' }) as never);

      await GET(createRequest(), { params: mockParams });

      expect(generateDOCX).toHaveBeenCalledWith('<p>No content</p>', 'Test Document');
    });

    it('uses fallback filename when title cannot be sanitized', async () => {
      vi.mocked(sanitizeFilename).mockReturnValue('');

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
        {
          exportFormat: 'docx',
          pageTitle: 'Test Document',
        }
      );
    });
  });

  describe('error handling', () => {
    it('returns 500 when DOCX generation fails', async () => {
      vi.mocked(generateDOCX).mockRejectedValueOnce(new Error('Generation failed'));

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to export page as DOCX');
    });

    it('returns 500 when database query fails', async () => {
      vi.mocked(db.query.pages.findFirst).mockRejectedValueOnce(new Error('Database error'));

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to export page as DOCX');
    });
  });
});
