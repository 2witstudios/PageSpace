/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ============================================================================
// Contract Tests for /api/files/[id]/view
//
// Tests the route handler for viewing/serving files inline.
// Similar to download but uses Content-Disposition: inline for safe types.
// ============================================================================

vi.mock('@/lib/auth', () => ({
  verifyAuth: vi.fn(),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      pages: { findFirst: vi.fn() },
      files: { findFirst: vi.fn() },
    },
  },
  pages: { id: 'id' },
  files: { id: 'id' },
  eq: vi.fn(),
}));

vi.mock('@pagespace/lib', () => ({
  PageType: { FILE: 'FILE', DOCUMENT: 'DOCUMENT' },
  canUserViewPage: vi.fn(),
  isFilePage: vi.fn(),
  createPageServiceToken: vi.fn(),
  createDriveServiceToken: vi.fn(),
}));

vi.mock('@pagespace/lib/permissions', () => ({
  canUserAccessFile: vi.fn(),
}));

vi.mock('@pagespace/lib/utils/file-security', () => ({
  sanitizeFilenameForHeader: vi.fn((name: string) => name),
  isDangerousMimeType: vi.fn(() => false),
  getCSPHeaderForFile: vi.fn(() => "default-src 'none'; script-src 'none';"),
}));

import { verifyAuth } from '@/lib/auth';
import { db } from '@pagespace/db';
import {
  canUserViewPage,
  isFilePage,
  createPageServiceToken,
  createDriveServiceToken,
} from '@pagespace/lib';
import { canUserAccessFile } from '@pagespace/lib/permissions';
import { isDangerousMimeType } from '@pagespace/lib/utils/file-security';
import { GET } from '../route';

// ============================================================================
// Test Helpers
// ============================================================================

const mockUser = { id: 'user_1', name: 'Test User' };

const createRequest = (url = 'https://example.com/api/files/file_1/view') =>
  new Request(url) as any;

const createContext = (id = 'file_1') => ({
  params: Promise.resolve({ id }),
});

const mockFilePageRecord = (overrides: Record<string, unknown> = {}) => ({
  id: 'page_file_1',
  type: 'FILE',
  title: 'report.pdf',
  originalFileName: 'report.pdf',
  filePath: 'hash123',
  mimeType: 'application/pdf',
  fileSize: 4096,
  driveId: 'drive_1',
  ...overrides,
});

const mockFileRecord = (overrides: Record<string, unknown> = {}) => ({
  id: 'file_1',
  driveId: 'drive_1',
  storagePath: 'hash456',
  mimeType: 'image/jpeg',
  sizeBytes: 8192,
  ...overrides,
});

const mockFetch = vi.fn();
global.fetch = mockFetch;

// ============================================================================
// Tests
// ============================================================================

describe('GET /api/files/[id]/view', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyAuth).mockResolvedValue(mockUser as any);
    vi.mocked(isFilePage).mockReturnValue(false);
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(null);
    vi.mocked(db.query.files.findFirst).mockResolvedValue(null);
    vi.mocked(isDangerousMimeType).mockReturnValue(false);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(verifyAuth).mockResolvedValue(null);

      const response = await GET(createRequest(), createContext());

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe('Unauthorized');
    });
  });

  describe('file page view', () => {
    beforeEach(() => {
      vi.mocked(isFilePage).mockReturnValue(true);
      vi.mocked(db.query.pages.findFirst).mockResolvedValue(mockFilePageRecord() as any);
      vi.mocked(canUserViewPage).mockResolvedValue(true);
      vi.mocked(createPageServiceToken).mockResolvedValue({ token: 'svc-tok' } as any);
      mockFetch.mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)),
      });
    });

    it('should return 403 when user cannot view page', async () => {
      vi.mocked(canUserViewPage).mockResolvedValue(false);

      const response = await GET(createRequest(), createContext('page_file_1'));

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe('You do not have access to this file');
    });

    it('should return 500 when filePath is missing', async () => {
      vi.mocked(db.query.pages.findFirst).mockResolvedValue(
        mockFilePageRecord({ filePath: null }) as any
      );

      const response = await GET(createRequest(), createContext('page_file_1'));

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe('File path not found');
    });

    it('should serve file inline for safe MIME types', async () => {
      vi.mocked(isDangerousMimeType).mockReturnValue(false);

      const response = await GET(createRequest(), createContext('page_file_1'));

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Disposition')).toContain('inline');
      expect(response.headers.get('Content-Security-Policy')).toBe("default-src 'none';");
    });

    it('should force download for dangerous MIME types', async () => {
      vi.mocked(isDangerousMimeType).mockReturnValue(true);

      const response = await GET(createRequest(), createContext('page_file_1'));

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Disposition')).toContain('attachment');
    });

    it('should set security headers', async () => {
      const response = await GET(createRequest(), createContext('page_file_1'));

      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    });

    it('should return 504 on timeout from processor', async () => {
      const err = new Error('Timeout');
      err.name = 'TimeoutError';
      mockFetch.mockRejectedValue(err);

      const response = await GET(createRequest(), createContext('page_file_1'));

      expect(response.status).toBe(504);
      const body = await response.json();
      expect(body.error).toBe('Request timed out');
    });

    it('should return 500 on non-timeout processor error', async () => {
      mockFetch.mockRejectedValue(new Error('Connection refused'));

      const response = await GET(createRequest(), createContext('page_file_1'));

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe('File not accessible');
    });
  });

  describe('files table view (channel attachments)', () => {
    beforeEach(() => {
      vi.mocked(isFilePage).mockReturnValue(false);
      vi.mocked(db.query.pages.findFirst).mockResolvedValue(null);
      vi.mocked(db.query.files.findFirst).mockResolvedValue(mockFileRecord() as any);
      vi.mocked(canUserAccessFile).mockResolvedValue(true);
      vi.mocked(createDriveServiceToken).mockResolvedValue({ token: 'svc-tok-2' } as any);
      mockFetch.mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
      });
    });

    it('should return 404 when file not found', async () => {
      vi.mocked(db.query.files.findFirst).mockResolvedValue(null);

      const response = await GET(createRequest(), createContext('missing'));

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe('File not found');
    });

    it('should return 403 when user has no access', async () => {
      vi.mocked(canUserAccessFile).mockResolvedValue(false);

      const response = await GET(createRequest(), createContext('file_1'));

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe('You do not have access to this file');
    });

    it('should serve file from files table successfully', async () => {
      const response = await GET(
        createRequest('https://example.com/api/files/file_1/view?filename=photo.jpg'),
        createContext('file_1')
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('image/jpeg');
      expect(createDriveServiceToken).toHaveBeenCalledWith(
        'user_1',
        'drive_1',
        ['files:read'],
        '5m'
      );
    });

    it('should return 504 on timeout for file record', async () => {
      const err = new Error('Timeout');
      err.name = 'TimeoutError';
      mockFetch.mockRejectedValue(err);

      const response = await GET(createRequest(), createContext('file_1'));

      expect(response.status).toBe(504);
    });
  });

  describe('error handling', () => {
    it('should return 500 on unexpected error', async () => {
      vi.mocked(verifyAuth).mockRejectedValue(new Error('Crash'));

      const response = await GET(createRequest(), createContext());

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe('Failed to view file');
    });
  });
});
