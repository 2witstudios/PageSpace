import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET } from '../route';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

const mockTurndown = vi.fn();

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

vi.mock('turndown', () => ({
  default: vi.fn().mockImplementation(() => ({
    turndown: mockTurndown,
  })),
}));

import { db } from '@pagespace/db';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { canUserViewPage } from '@pagespace/lib/server';
import { sanitizeFilename } from '@pagespace/lib';
import { trackPageOperation } from '@pagespace/lib/activity-tracker';
import TurndownService from 'turndown';

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
  contentMode: 'html' | 'markdown';
}>) => ({
  id: overrides?.id ?? 'page_123',
  title: overrides?.title ?? 'Test Document',
  type: overrides?.type ?? 'DOCUMENT',
  content: overrides?.content ?? '<h1>Hello</h1><p>World</p>',
  contentMode: overrides?.contentMode ?? 'html',
  driveId: 'drive_123',
  parentId: null,
  position: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  isTrashed: false,
});

describe('GET /api/pages/[pageId]/export/markdown', () => {
  const mockUserId = 'user_123';
  const mockPageId = 'page_123';

  const createRequest = () => {
    return new Request(`https://example.com/api/pages/${mockPageId}/export/markdown`, {
      method: 'GET',
    });
  };

  const mockParams = Promise.resolve({ pageId: mockPageId });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(canUserViewPage).mockResolvedValue(true);
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(mockPage() as never);
    vi.mocked(sanitizeFilename).mockReturnValue('Test_Document');
    mockTurndown.mockReturnValue('# Hello\n\nWorld');
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
      vi.mocked(db.query.pages.findFirst).mockResolvedValue(mockPage({ type: 'SHEET' }) as never);

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Markdown export is only available for DOCUMENT pages');
    });
  });

  describe('markdown generation', () => {
    it('exports markdown pages without conversion', async () => {
      vi.mocked(db.query.pages.findFirst).mockResolvedValue(
        mockPage({ contentMode: 'markdown', content: '# Existing Markdown' }) as never
      );

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(body).toBe('# Existing Markdown');
      expect(TurndownService).not.toHaveBeenCalled();
      expect(mockTurndown).not.toHaveBeenCalled();
    });

    it('converts HTML content to markdown for html-mode pages', async () => {
      vi.mocked(db.query.pages.findFirst).mockResolvedValue(
        mockPage({ contentMode: 'html', content: '<h1>Hello</h1><p>World</p>' }) as never
      );
      mockTurndown.mockReturnValue('# Hello\n\nWorld');

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(TurndownService).toHaveBeenCalledWith({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced',
      });
      expect(mockTurndown).toHaveBeenCalledWith('<h1>Hello</h1><p>World</p>');
      expect(body).toBe('# Hello\n\nWorld');
    });

    it('returns correct content type header', async () => {
      const response = await GET(createRequest(), { params: mockParams });

      expect(response.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
    });

    it('returns correct content disposition header', async () => {
      const response = await GET(createRequest(), { params: mockParams });

      expect(response.headers.get('Content-Disposition')).toContain('attachment');
      expect(response.headers.get('Content-Disposition')).toContain('.md');
    });

    it('uses fallback filename when title cannot be sanitized', async () => {
      vi.mocked(sanitizeFilename).mockReturnValue('');

      const response = await GET(createRequest(), { params: mockParams });

      expect(response.headers.get('Content-Disposition')).toContain('document.md');
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
          exportFormat: 'markdown',
          pageTitle: 'Test Document',
        }
      );
    });
  });

  describe('error handling', () => {
    it('returns 500 when conversion fails', async () => {
      mockTurndown.mockImplementation(() => {
        throw new Error('Conversion failed');
      });

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to export page as Markdown');
    });

    it('returns 500 when database query fails', async () => {
      vi.mocked(db.query.pages.findFirst).mockRejectedValueOnce(new Error('Database error'));

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to export page as Markdown');
    });
  });
});
