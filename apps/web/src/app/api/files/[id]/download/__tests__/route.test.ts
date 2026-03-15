/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

// ============================================================================
// Contract Tests for /api/files/[id]/download
//
// Tests the route handler for downloading files by page or file ID.
// Mocks auth, DB queries, permissions, and the processor fetch.
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
import { GET } from '../route';

// ============================================================================
// Test Helpers
// ============================================================================

const mockUser = { id: 'user_1', name: 'Test User' };

const createRequest = (url = 'https://example.com/api/files/file_1/download') =>
  new Request(url) as any;

const createContext = (id = 'file_1') => ({
  params: Promise.resolve({ id }),
});

const mockFilePageRecord = (overrides: Record<string, unknown> = {}) => ({
  id: 'page_file_1',
  type: 'FILE',
  title: 'test.pdf',
  originalFileName: 'test.pdf',
  filePath: 'abc123hash',
  mimeType: 'application/pdf',
  fileSize: 1024,
  driveId: 'drive_1',
  ...overrides,
});

const mockFileRecord = (overrides: Record<string, unknown> = {}) => ({
  id: 'file_1',
  driveId: 'drive_1',
  storagePath: 'def456hash',
  mimeType: 'image/png',
  sizeBytes: 2048,
  ...overrides,
});

const mockFetch = vi.fn();
global.fetch = mockFetch;

// ============================================================================
// Tests
// ============================================================================

describe('GET /api/files/[id]/download', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyAuth).mockResolvedValue(mockUser as any);
    vi.mocked(isFilePage).mockReturnValue(false);
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(null);
    vi.mocked(db.query.files.findFirst).mockResolvedValue(null);
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

  describe('file page download', () => {
    beforeEach(() => {
      vi.mocked(isFilePage).mockReturnValue(true);
      vi.mocked(db.query.pages.findFirst).mockResolvedValue(mockFilePageRecord() as any);
      vi.mocked(canUserViewPage).mockResolvedValue(true);
      vi.mocked(createPageServiceToken).mockResolvedValue({ token: 'svc-token-123' } as any);
      mockFetch.mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)),
      });
    });

    it('should return 403 when user cannot view the page', async () => {
      vi.mocked(canUserViewPage).mockResolvedValue(false);

      const response = await GET(createRequest(), createContext('page_file_1'));

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe('You do not have access to this file');
    });

    it('should return 500 when file path is missing', async () => {
      vi.mocked(db.query.pages.findFirst).mockResolvedValue(
        mockFilePageRecord({ filePath: null }) as any
      );

      const response = await GET(createRequest(), createContext('page_file_1'));

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe('File path not found');
    });

    it('should download a file page successfully', async () => {
      const response = await GET(createRequest(), createContext('page_file_1'));

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Disposition')).toContain('attachment');
      expect(response.headers.get('Content-Type')).toBe('application/pdf');
      expect(createPageServiceToken).toHaveBeenCalledWith(
        'user_1',
        'page_file_1',
        ['files:read'],
        '5m'
      );
    });

    it('should return 504 on timeout when fetching from processor', async () => {
      const timeoutError = new Error('Timeout');
      timeoutError.name = 'TimeoutError';
      vi.mocked(createPageServiceToken).mockResolvedValue({ token: 'tok' } as any);
      mockFetch.mockRejectedValue(timeoutError);

      const response = await GET(createRequest(), createContext('page_file_1'));

      expect(response.status).toBe(504);
      const body = await response.json();
      expect(body.error).toBe('Request timed out');
    });

    it('should return 500 on non-timeout fetch error for file page', async () => {
      vi.mocked(createPageServiceToken).mockResolvedValue({ token: 'tok' } as any);
      mockFetch.mockRejectedValue(new Error('Connection refused'));

      const response = await GET(createRequest(), createContext('page_file_1'));

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe('File not accessible');
    });
  });

  describe('files table download (channel attachments)', () => {
    beforeEach(() => {
      vi.mocked(isFilePage).mockReturnValue(false);
      vi.mocked(db.query.pages.findFirst).mockResolvedValue(null);
      vi.mocked(db.query.files.findFirst).mockResolvedValue(mockFileRecord() as any);
      vi.mocked(canUserAccessFile).mockResolvedValue(true);
      vi.mocked(createDriveServiceToken).mockResolvedValue({ token: 'svc-token-456' } as any);
      mockFetch.mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)),
      });
    });

    it('should return 404 when file not found in either table', async () => {
      vi.mocked(db.query.files.findFirst).mockResolvedValue(null);

      const response = await GET(createRequest(), createContext('missing_id'));

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe('File not found');
    });

    it('should return 403 when user cannot access the file', async () => {
      vi.mocked(canUserAccessFile).mockResolvedValue(false);

      const response = await GET(createRequest(), createContext('file_1'));

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe('You do not have access to this file');
    });

    it('should download a file from files table successfully', async () => {
      const response = await GET(
        createRequest('https://example.com/api/files/file_1/download?filename=photo.png'),
        createContext('file_1')
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('image/png');
      expect(createDriveServiceToken).toHaveBeenCalledWith(
        'user_1',
        'drive_1',
        ['files:read'],
        '5m'
      );
    });

    it('should return 504 on timeout when fetching file from processor', async () => {
      const timeoutError = new Error('Timeout');
      timeoutError.name = 'TimeoutError';
      mockFetch.mockRejectedValue(timeoutError);

      const response = await GET(createRequest(), createContext('file_1'));

      expect(response.status).toBe(504);
      const body = await response.json();
      expect(body.error).toBe('Request timed out');
    });

    it('should return 500 on non-timeout fetch error for file record', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const response = await GET(createRequest(), createContext('file_1'));

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe('File not accessible');
    });
  });

  describe('error handling', () => {
    it('should return 500 on unexpected error', async () => {
      vi.mocked(verifyAuth).mockRejectedValue(new Error('Unexpected'));

      const response = await GET(createRequest(), createContext());

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe('Failed to download file');
    });
  });
});
