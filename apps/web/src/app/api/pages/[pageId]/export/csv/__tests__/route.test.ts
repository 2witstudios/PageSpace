import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { NextResponse } from 'next/server';
import { GET } from '../route';
import type { WebAuthResult, AuthError } from '@/lib/auth';

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
  generateCSV: vi.fn(),
  sanitizeFilename: vi.fn((name: string) => name.replace(/[^a-zA-Z0-9-_]/g, '_')),
}));

vi.mock('@pagespace/lib/client-safe', () => ({
  parseSheetContent: vi.fn(),
  sanitizeSheetData: vi.fn((data: unknown) => data),
  evaluateSheet: vi.fn(),
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
import { generateCSV, sanitizeFilename } from '@pagespace/lib';
import { parseSheetContent, sanitizeSheetData, evaluateSheet } from '@pagespace/lib/client-safe';
import { trackPageOperation } from '@pagespace/lib/activity-tracker';

// Helper to create mock WebAuthResult
const mockWebAuth = (userId: string): WebAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'jwt',
  source: 'cookie',
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
  title: overrides?.title ?? 'Test Sheet',
  type: overrides?.type ?? 'SHEET',
  content: overrides?.content ?? '{"cells":{},"columnWidths":{}}',
  driveId: 'drive_123',
  parentId: null,
  position: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  isTrashed: false,
});

// Mock sheet data
const mockSheetData = {
  cells: {
    'A1': { value: 'Name' },
    'B1': { value: 'Age' },
    'A2': { value: 'John' },
    'B2': { value: '30' },
  },
  columnWidths: {},
};

const mockEvaluation = {
  display: [
    ['Name', 'Age'],
    ['John', '30'],
  ],
  errors: {},
};

describe('GET /api/pages/[pageId]/export/csv', () => {
  const mockUserId = 'user_123';
  const mockPageId = 'page_123';

  const createRequest = () => {
    return new Request(`https://example.com/api/pages/${mockPageId}/export/csv`, {
      method: 'GET',
    });
  };

  const mockParams = Promise.resolve({ pageId: mockPageId });

  beforeEach(() => {
    vi.clearAllMocks();
    (authenticateRequestWithOptions as Mock).mockResolvedValue(mockWebAuth(mockUserId));
    (canUserViewPage as Mock).mockResolvedValue(true);
    (db.query.pages.findFirst as Mock).mockResolvedValue(mockPage());
    (parseSheetContent as Mock).mockReturnValue(mockSheetData);
    (sanitizeSheetData as Mock).mockReturnValue(mockSheetData);
    (evaluateSheet as Mock).mockReturnValue(mockEvaluation);
    (generateCSV as Mock).mockReturnValue('Name,Age\nJohn,30');
    (sanitizeFilename as Mock).mockReturnValue('Test_Sheet');
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

    it('returns 400 when page is not a SHEET type', async () => {
      (db.query.pages.findFirst as Mock).mockResolvedValue(mockPage({ type: 'DOCUMENT' }));

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('CSV export is only available for SHEET pages');
    });

    it('returns 400 for FOLDER page type', async () => {
      (db.query.pages.findFirst as Mock).mockResolvedValue(mockPage({ type: 'FOLDER' }));

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('CSV export is only available for SHEET pages');
    });

    it('returns 400 for AI_CHAT page type', async () => {
      (db.query.pages.findFirst as Mock).mockResolvedValue(mockPage({ type: 'AI_CHAT' }));

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('CSV export is only available for SHEET pages');
    });
  });

  describe('CSV generation', () => {
    it('generates CSV file successfully', async () => {
      const response = await GET(createRequest(), { params: mockParams });

      expect(response.status).toBe(200);
      expect(parseSheetContent).toHaveBeenCalled();
      expect(evaluateSheet).toHaveBeenCalledWith(
        mockSheetData,
        expect.objectContaining({
          pageId: mockPageId,
          pageTitle: 'Test Sheet',
        })
      );
      expect(generateCSV).toHaveBeenCalledWith(mockEvaluation.display);
    });

    it('returns correct content type header', async () => {
      const response = await GET(createRequest(), { params: mockParams });

      expect(response.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    });

    it('returns correct content disposition header', async () => {
      const response = await GET(createRequest(), { params: mockParams });

      expect(response.headers.get('Content-Disposition')).toContain('attachment');
      expect(response.headers.get('Content-Disposition')).toContain('.csv');
    });

    it('sanitizes sheet data before evaluation', async () => {
      await GET(createRequest(), { params: mockParams });

      expect(sanitizeSheetData).toHaveBeenCalledWith(mockSheetData);
    });

    it('uses fallback filename when title cannot be sanitized', async () => {
      (sanitizeFilename as Mock).mockReturnValue('');

      const response = await GET(createRequest(), { params: mockParams });

      expect(response.headers.get('Content-Disposition')).toContain('sheet.csv');
    });

    it('includes content length header', async () => {
      (generateCSV as Mock).mockReturnValue('Name,Age\nJohn,30');

      const response = await GET(createRequest(), { params: mockParams });

      expect(response.headers.get('Content-Length')).toBeDefined();
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
          exportFormat: 'csv',
          pageTitle: 'Test Sheet',
        })
      );
    });
  });

  describe('error handling', () => {
    it('returns 500 when sheet parsing fails', async () => {
      (parseSheetContent as Mock).mockImplementation(() => {
        throw new Error('Invalid sheet format');
      });

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to export page as CSV');
    });

    it('returns 500 when CSV generation fails', async () => {
      (generateCSV as Mock).mockImplementation(() => {
        throw new Error('Generation failed');
      });

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to export page as CSV');
    });

    it('returns 500 when database query fails', async () => {
      (db.query.pages.findFirst as Mock).mockRejectedValue(new Error('Database error'));

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to export page as CSV');
    });
  });

  describe('special characters handling', () => {
    it('handles sheet with special characters', async () => {
      const specialData = {
        cells: {
          'A1': { value: 'Name, "Nickname"' },
          'A2': { value: 'John\nDoe' },
        },
        columnWidths: {},
      };
      (parseSheetContent as Mock).mockReturnValue(specialData);
      (sanitizeSheetData as Mock).mockReturnValue(specialData);
      (evaluateSheet as Mock).mockReturnValue({
        display: [['Name, "Nickname"'], ['John\nDoe']],
        errors: {},
      });
      (generateCSV as Mock).mockReturnValue('"Name, ""Nickname"""\n"John\nDoe"');

      const response = await GET(createRequest(), { params: mockParams });

      expect(response.status).toBe(200);
    });

    it('handles empty sheet', async () => {
      const emptyData = {
        cells: {},
        columnWidths: {},
      };
      (parseSheetContent as Mock).mockReturnValue(emptyData);
      (sanitizeSheetData as Mock).mockReturnValue(emptyData);
      (evaluateSheet as Mock).mockReturnValue({
        display: [],
        errors: {},
      });
      (generateCSV as Mock).mockReturnValue('');

      const response = await GET(createRequest(), { params: mockParams });

      expect(response.status).toBe(200);
    });
  });
});
