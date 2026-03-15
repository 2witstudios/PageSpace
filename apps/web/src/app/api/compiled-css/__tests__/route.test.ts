/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ============================================================================
// Contract Tests for /api/compiled-css
//
// Tests GET handler that reads and serves globals.css.
// No auth required - public endpoint.
// ============================================================================

const { mockReadFile } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
}));

vi.mock('fs', () => {
  return {
    default: { promises: { readFile: mockReadFile } },
    promises: { readFile: mockReadFile },
  };
});

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

import { loggers } from '@pagespace/lib/server';

// Import GET after mocks are set up
import { GET } from '../route';

// ============================================================================
// GET /api/compiled-css
// ============================================================================

describe('GET /api/compiled-css', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('success', () => {
    it('should return CSS content with correct content-type', async () => {
      const cssContent = 'body { margin: 0; } .container { display: flex; }';
      mockReadFile.mockResolvedValue(cssContent);

      const response = await GET();
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/css');
      expect(text).toBe(cssContent);
    });

    it('should read from the correct file path', async () => {
      mockReadFile.mockResolvedValue('/* css */');

      await GET();

      expect(mockReadFile).toHaveBeenCalledWith(
        expect.stringContaining('globals.css'),
        'utf-8'
      );
    });
  });

  describe('error handling', () => {
    it('should return 500 with fallback CSS when file read fails', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT: file not found'));

      const response = await GET();
      const text = await response.text();

      expect(response.status).toBe(500);
      expect(response.headers.get('Content-Type')).toBe('text/css');
      expect(text).toBe('/* Failed to load compiled CSS */');
    });

    it('should log error when file read fails', async () => {
      const error = new Error('ENOENT: file not found');
      mockReadFile.mockRejectedValue(error);

      await GET();

      expect(loggers.api.error).toHaveBeenCalledWith('Failed to read globals.css:', error);
    });
  });
});
