/**
 * @scaffold - Database layer: pg Pool mocking is necessary because db.ts IS
 * the lowest persistence seam (raw SQL over pg Pool). These tests characterize
 * query composition and connection lifecycle (acquire → query → release).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
const mockRelease = vi.fn();
const mockConnect = vi.fn(() =>
  Promise.resolve({ query: mockQuery, release: mockRelease }),
);

// Ensure DATABASE_URL is available before module loads
vi.hoisted(() => {
  process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
});

// Mock pg - the module uses require('pg') but vitest transforms it
vi.mock('pg', () => {
  class MockPool {
    connect() {
      return mockConnect();
    }
    end() {
      return Promise.resolve();
    }
  }
  return { default: { Pool: MockPool }, Pool: MockPool };
});

import {
  setPageProcessing,
  setPageCompleted,
  setPageVisual,
  setPageFailed,
  getPageForIngestion,
} from '../db';

describe('db module', () => {
  beforeEach(() => {
    mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    mockRelease.mockReset();
    mockConnect.mockReset().mockImplementation(() =>
      Promise.resolve({ query: mockQuery, release: mockRelease }),
    );
  });

  describe('setPageProcessing', () => {
    it('should execute correct query', async () => {
      await setPageProcessing('page-1');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('processingStatus'),
        ['processing', 'page-1'],
      );
      expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    it('should release client on error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('DB error'));
      await expect(setPageProcessing('page-1')).rejects.toThrow('DB error');
      expect(mockRelease).toHaveBeenCalledTimes(1);
    });
  });

  describe('setPageCompleted', () => {
    it('should execute with metadata and extraction method', async () => {
      await setPageCompleted('page-1', 'extracted', { title: 'Test' }, 'text');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('processingStatus'),
        expect.arrayContaining(['extracted', 'completed']),
      );
      expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    it('should use default extraction method (text)', async () => {
      await setPageCompleted('page-1', 'content', null);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['content', 'completed', 'text']),
      );
    });

    it('should pass null when metadata is null', async () => {
      await setPageCompleted('page-1', 'text', null, 'ocr');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        ['text', 'completed', 'ocr', null, 'page-1'],
      );
    });

    it('should stringify non-null metadata', async () => {
      await setPageCompleted('page-1', 'text', { key: 'val' }, 'text');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining([JSON.stringify({ key: 'val' })]),
      );
    });

    it('should release client on error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('DB error'));
      await expect(setPageCompleted('p', 'text', null)).rejects.toThrow('DB error');
      expect(mockRelease).toHaveBeenCalledTimes(1);
    });
  });

  describe('setPageVisual', () => {
    it('should execute correct query', async () => {
      await setPageVisual('page-1');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('processingStatus'),
        ['visual', 'visual', 'page-1'],
      );
      expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    it('should release client on error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('DB error'));
      await expect(setPageVisual('page-1')).rejects.toThrow('DB error');
      expect(mockRelease).toHaveBeenCalledTimes(1);
    });
  });

  describe('setPageFailed', () => {
    it('should execute correct query', async () => {
      await setPageFailed('page-1', 'Processing failed');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('processingStatus'),
        ['failed', 'Processing failed', 'page-1'],
      );
      expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    it('should release client on error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('DB error'));
      await expect(setPageFailed('page-1', 'err')).rejects.toThrow('DB error');
      expect(mockRelease).toHaveBeenCalledTimes(1);
    });
  });

  describe('getPageForIngestion', () => {
    it('should return page data when found', async () => {
      const row = { id: 'p1', contentHash: 'abc', mimeType: 'application/pdf', originalFileName: 'f.pdf' };
      mockQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 });
      const result = await getPageForIngestion('p1');
      expect(result).toEqual(row);
      expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    it('should return null when no rows', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      const result = await getPageForIngestion('missing');
      expect(result).toBeNull();
      expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    it('should release client on error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('DB error'));
      await expect(getPageForIngestion('p1')).rejects.toThrow('DB error');
      expect(mockRelease).toHaveBeenCalledTimes(1);
    });
  });
});

describe('getPool throws when DATABASE_URL is not set (lines 21-22)', () => {
  it('throws DATABASE_URL error when env var is missing at call time', async () => {
    // The pool is a module-level singleton. Since we cannot reset it without vi.isolateModules,
    // we test this path by verifying that the error message string is present in the source,
    // and by testing it via a fresh module import with vi.resetModules.
    // Note: this test runs AFTER the main test suite has already set up the pool singleton,
    // so we verify the behavior by checking getPool() throws before pool is initialized.
    // The throw at lines 21-22 reads: throw new Error('DATABASE_URL is not configured')
    // We verify this by trying a fresh module in a way that doesn't break others.
    const savedUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;

    vi.resetModules();
    // Re-register pg mock so the fresh module load still has pg available
    vi.doMock('pg', () => {
      class MockPool {
        connect() { return Promise.resolve({ query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }), release: vi.fn() }); }
        end() { return Promise.resolve(); }
      }
      return { default: { Pool: MockPool }, Pool: MockPool };
    });

    const freshDb = await import('../db');
    await expect(freshDb.setPageProcessing('page-1')).rejects.toThrow('DATABASE_URL is not configured');

    // Restore
    if (savedUrl !== undefined) process.env.DATABASE_URL = savedUrl;
    vi.resetModules();
  });
});
