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
  securityAudit: {
    logDataAccess: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@pagespace/lib', () => ({
  generateExcel: vi.fn(),
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
  checkMCPPageScope: vi.fn().mockResolvedValue(null),
}));

import { db } from '@pagespace/db';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { canUserViewPage } from '@pagespace/lib/server';
import { generateExcel, sanitizeFilename } from '@pagespace/lib';
import { parseSheetContent, sanitizeSheetData, evaluateSheet } from '@pagespace/lib/client-safe';
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

describe('GET /api/pages/[pageId]/export/xlsx', () => {
  const mockUserId = 'user_123';
  const mockPageId = 'page_123';

  const createRequest = () => {
    return new Request(`https://example.com/api/pages/${mockPageId}/export/xlsx`, {
      method: 'GET',
    });
  };

  const mockParams = Promise.resolve({ pageId: mockPageId });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(canUserViewPage).mockResolvedValue(true);
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(mockPage() as never);
    vi.mocked(parseSheetContent).mockReturnValue(mockSheetData as never);
    vi.mocked(sanitizeSheetData).mockReturnValue(mockSheetData as never);
    vi.mocked(evaluateSheet).mockReturnValue(mockEvaluation as never);
    vi.mocked(generateExcel).mockReturnValue(Buffer.from('mock excel content') as never);
    vi.mocked(sanitizeFilename).mockReturnValue('Test_Sheet');
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

    it('returns 400 when page is not a SHEET type', async () => {
      vi.mocked(db.query.pages.findFirst).mockResolvedValue(mockPage({ type: 'DOCUMENT' }) as never);

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Excel export is only available for SHEET pages');
    });

    it('returns 400 for FOLDER page type', async () => {
      vi.mocked(db.query.pages.findFirst).mockResolvedValue(mockPage({ type: 'FOLDER' }) as never);

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Excel export is only available for SHEET pages');
    });

    it('returns 400 for AI_CHAT page type', async () => {
      vi.mocked(db.query.pages.findFirst).mockResolvedValue(mockPage({ type: 'AI_CHAT' }) as never);

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Excel export is only available for SHEET pages');
    });

    it('returns 400 for CANVAS page type', async () => {
      vi.mocked(db.query.pages.findFirst).mockResolvedValue(mockPage({ type: 'CANVAS' }) as never);

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Excel export is only available for SHEET pages');
    });
  });

  describe('Excel generation', () => {
    it('generates Excel file successfully', async () => {
      const response = await GET(createRequest(), { params: mockParams });

      expect(response.status).toBe(200);
      expect(parseSheetContent).toHaveBeenCalledWith(mockPage().content);
      expect(evaluateSheet).toHaveBeenCalledWith(
        mockSheetData,
        {
          pageId: mockPageId,
          pageTitle: 'Test Sheet',
        }
      );
      expect(generateExcel).toHaveBeenCalledWith(
        mockEvaluation.display,
        'Test Sheet',
        'Test Sheet'
      );
    });

    it('returns correct content type header', async () => {
      const response = await GET(createRequest(), { params: mockParams });

      expect(response.headers.get('Content-Type')).toBe(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
    });

    it('returns correct content disposition header', async () => {
      const response = await GET(createRequest(), { params: mockParams });

      expect(response.headers.get('Content-Disposition')).toContain('attachment');
      expect(response.headers.get('Content-Disposition')).toContain('.xlsx');
    });

    it('sanitizes sheet data before evaluation', async () => {
      await GET(createRequest(), { params: mockParams });

      expect(sanitizeSheetData).toHaveBeenCalledWith(mockSheetData);
    });

    it('uses fallback filename when title cannot be sanitized', async () => {
      vi.mocked(sanitizeFilename).mockReturnValue('');

      const response = await GET(createRequest(), { params: mockParams });

      expect(response.headers.get('Content-Disposition')).toContain('sheet.xlsx');
    });

    it('includes content length header', async () => {
      const excelBuffer = Buffer.from('mock excel content');
      vi.mocked(generateExcel).mockReturnValue(excelBuffer as never);

      const response = await GET(createRequest(), { params: mockParams });

      expect(response.headers.get('Content-Length')).toBe(String(excelBuffer.length));
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
          exportFormat: 'xlsx',
          pageTitle: 'Test Sheet',
        }
      );
    });
  });

  describe('error handling', () => {
    it('returns 500 when sheet parsing fails', async () => {
      vi.mocked(parseSheetContent).mockImplementation(() => {
        throw new Error('Invalid sheet format');
      });

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to export page as Excel');
    });

    it('returns 500 when Excel generation fails', async () => {
      vi.mocked(generateExcel).mockImplementation(() => {
        throw new Error('Generation failed');
      });

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to export page as Excel');
    });

    it('returns 500 when database query fails', async () => {
      vi.mocked(db.query.pages.findFirst).mockRejectedValueOnce(new Error('Database error'));

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to export page as Excel');
    });
  });

  describe('data preservation', () => {
    it('preserves formula results in export', async () => {
      const formulaData = {
        cells: {
          'A1': { value: '10' },
          'B1': { value: '20' },
          'C1': { value: '=A1+B1' },
        },
        columnWidths: {},
      };
      vi.mocked(parseSheetContent).mockReturnValue(formulaData as never);
      vi.mocked(sanitizeSheetData).mockReturnValue(formulaData as never);
      vi.mocked(evaluateSheet).mockReturnValue({
        display: [['10', '20', '30']],
        errors: {},
      } as never);

      await GET(createRequest(), { params: mockParams });

      expect(generateExcel).toHaveBeenCalledWith(
        [['10', '20', '30']],
        'Test Sheet',
        'Test Sheet'
      );
    });

    it('handles empty sheet', async () => {
      const emptyData = {
        cells: {},
        columnWidths: {},
      };
      vi.mocked(parseSheetContent).mockReturnValue(emptyData as never);
      vi.mocked(sanitizeSheetData).mockReturnValue(emptyData as never);
      vi.mocked(evaluateSheet).mockReturnValue({
        display: [],
        errors: {},
      } as never);

      const response = await GET(createRequest(), { params: mockParams });

      expect(response.status).toBe(200);
      expect(generateExcel).toHaveBeenCalledWith(
        [],
        'Test Sheet',
        'Test Sheet'
      );
    });

    it('handles large sheets', async () => {
      const largeDisplay: string[][] = [];
      for (let i = 0; i < 1000; i++) {
        largeDisplay.push([`Row ${i}`, String(i * 10)]);
      }
      vi.mocked(evaluateSheet).mockReturnValue({
        display: largeDisplay,
        errors: {},
      } as never);
      vi.mocked(generateExcel).mockReturnValue(Buffer.alloc(100000) as never);

      const response = await GET(createRequest(), { params: mockParams });

      expect(response.status).toBe(200);
    });
  });
});
