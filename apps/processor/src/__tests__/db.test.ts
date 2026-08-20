/**
 * @boundary-contract - Database layer: pg Pool mocking is necessary because db.ts IS
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

const SET_PAGE_COMPLETED_SQL = 'UPDATE pages SET content = $1, "processingStatus" = $2, "extractionMethod" = $3, "extractionMetadata" = $4::jsonb, "processedAt" = NOW() WHERE id = $5';
const STATUS_ONLY_SQL = 'UPDATE pages SET "processingStatus" = $1, "extractionMethod" = $2, "extractionMetadata" = $3::jsonb, "processedAt" = NOW() WHERE id = $4';
const TYPE_LOCK_SQL = 'SELECT type FROM pages WHERE id = $1 FOR UPDATE';

/**
 * setPageCompleted reads the page's type under a row lock before deciding
 * whether the body may be written. Every call has to answer that SELECT.
 */
function respondWithPageType(type: string | null): void {
  mockQuery.mockImplementation((sql: string) => {
    if (sql === TYPE_LOCK_SQL) {
      return Promise.resolve({ rows: type === null ? [] : [{ type }], rowCount: type === null ? 0 : 1 });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
}

/** SQL text of every UPDATE the call issued. */
function updateStatements(): string[] {
  return mockQuery.mock.calls
    .map((call) => String(call[0]))
    .filter((sql) => sql.startsWith('UPDATE '));
}

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
    beforeEach(() => {
      respondWithPageType('FILE');
    });

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
        SET_PAGE_COMPLETED_SQL,
        ['content', 'completed', 'text', null, 'page-1'],
      );
      expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    it('should pass null when metadata is null', async () => {
      await setPageCompleted('page-1', 'text', null, 'ocr');
      expect(mockQuery).toHaveBeenCalledWith(
        SET_PAGE_COMPLETED_SQL,
        ['text', 'completed', 'ocr', null, 'page-1'],
      );
      expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    it('should stringify non-null metadata', async () => {
      await setPageCompleted('page-1', 'text', { key: 'val' }, 'text');
      expect(mockQuery).toHaveBeenCalledWith(
        SET_PAGE_COMPLETED_SQL,
        ['text', 'completed', 'text', '{"key":"val"}', 'page-1'],
      );
      expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    it('should release client on error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('DB error'));
      await expect(setPageCompleted('p', 'text', null)).rejects.toThrow('DB error');
      expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    it('given a page converted to DOCUMENT after enqueue, never writes content', async () => {
      respondWithPageType('DOCUMENT');

      await setPageCompleted('page-1', 'extracted text', { title: 'Doc' }, 'text');

      expect(updateStatements()).toEqual([STATUS_ONLY_SQL]);
      expect(mockQuery).not.toHaveBeenCalledWith(
        SET_PAGE_COMPLETED_SQL,
        expect.anything(),
      );
      // The authored body survives; only the processing bookkeeping lands.
      expect(mockQuery).toHaveBeenCalledWith(
        STATUS_ONLY_SQL,
        ['completed', 'text', '{"title":"Doc"}', 'page-1'],
      );
      expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    it('given any non-FILE page type, refuses the content write', async () => {
      for (const type of ['FOLDER', 'AI_CHAT', 'CHANNEL', 'SHEET', 'CANVAS']) {
        mockQuery.mockClear();
        respondWithPageType(type);
        await setPageCompleted('page-1', 'extracted text', null, 'text');
        expect(updateStatements()).toEqual([STATUS_ONLY_SQL]);
      }
    });

    it('given the page no longer exists, writes nothing at all', async () => {
      respondWithPageType(null);

      await setPageCompleted('page-1', 'extracted text', null, 'text');

      expect(updateStatements()).toEqual([]);
      expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    it('reads the type under a row lock in the same transaction as the write', async () => {
      respondWithPageType('FILE');

      await setPageCompleted('page-1', 'extracted text', null, 'text');

      const sqls = mockQuery.mock.calls.map((call) => String(call[0]));
      expect(sqls[0]).toBe('BEGIN');
      expect(sqls[1]).toBe(TYPE_LOCK_SQL);
      expect(sqls[2]).toBe(SET_PAGE_COMPLETED_SQL);
      expect(sqls[3]).toBe('COMMIT');
    });

    it('rolls back when the write fails', async () => {
      respondWithPageType('FILE');
      mockQuery.mockImplementationOnce(() => Promise.resolve({ rows: [], rowCount: 0 })) // BEGIN
        .mockImplementationOnce(() => Promise.resolve({ rows: [{ type: 'FILE' }], rowCount: 1 }))
        .mockImplementationOnce(() => Promise.reject(new Error('write failed')));

      await expect(setPageCompleted('page-1', 'text', null)).rejects.toThrow('write failed');
      expect(mockQuery.mock.calls.map((c) => String(c[0]))).toContain('ROLLBACK');
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

describe('getPool throws when DATABASE_URL is not set', () => {
  it('throws DATABASE_URL error when env var is missing at call time', async () => {
    const savedUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;

    vi.resetModules();
    vi.doMock('pg', () => {
      class MockPool {
        connect() { return Promise.resolve({ query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }), release: vi.fn() }); }
        end() { return Promise.resolve(); }
      }
      return { default: { Pool: MockPool }, Pool: MockPool };
    });

    const freshDb = await import('../db');
    await expect(freshDb.setPageProcessing('page-1')).rejects.toThrow('DATABASE_URL is not configured');

    if (savedUrl !== undefined) process.env.DATABASE_URL = savedUrl;
    vi.resetModules();
  });
});
