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

// Ensure DATABASE_URL is available before module loads. This package runs in a
// single fork, so the assignment outlives this file — src/test/setup.ts restores
// the pristine value before each subsequent file for that reason.
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

import { loggers } from '@pagespace/lib/logging/logger-config';
import {
  setPageProcessing,
  setPageCompleted,
  setPageVisual,
  setPageFailed,
  getPageForIngestion,
} from '../db';

/**
 * setPageCompleted is one statement: the FILE fence is the CASE expression, so
 * these tests pin the statement's shape and the log/branching it drives. That
 * the CASE actually protects a DOCUMENT body is proven by executing it against
 * a real Postgres in set-page-completed.integration.test.ts — a mocked driver
 * cannot evaluate SQL.
 */
const SET_PAGE_COMPLETED_SQL = `UPDATE pages
          SET content = CASE WHEN type = $1 THEN $2 ELSE content END,
              "processingStatus" = $3,
              "extractionMethod" = $4,
              "extractionMetadata" = $5::jsonb,
              "processedAt" = NOW()
        WHERE id = $6
      RETURNING type`;

/** Make the UPDATE report the row it wrote back, as RETURNING type does. */
function respondWithPageType(type: string | null): void {
  mockQuery.mockResolvedValue({
    rows: type === null ? [] : [{ type }],
    rowCount: type === null ? 0 : 1,
  });
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

    it('writes content, status and extraction metadata in one statement', async () => {
      await setPageCompleted('page-1', 'extracted', { title: 'Test' }, 'text');

      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockQuery).toHaveBeenCalledWith(SET_PAGE_COMPLETED_SQL, [
        'FILE',
        'extracted',
        'completed',
        'text',
        '{"title":"Test"}',
        'page-1',
      ]);
      expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    it('fences the content write to FILE pages inside the statement itself', async () => {
      await setPageCompleted('page-1', 'extracted', null, 'text');

      const [sql, values] = mockQuery.mock.calls[0] as [string, unknown[]];
      // No separate read-then-write: the UPDATE tests `type` against the same
      // row version it writes, so nothing can convert the page in between.
      expect(sql).toContain('SET content = CASE WHEN type = $1 THEN $2 ELSE content END');
      expect(values[0]).toBe('FILE');
      expect(sql).toContain('RETURNING type');
    });

    it('should use default extraction method (text)', async () => {
      await setPageCompleted('page-1', 'content', null);

      expect(mockQuery).toHaveBeenCalledWith(SET_PAGE_COMPLETED_SQL, [
        'FILE', 'content', 'completed', 'text', null, 'page-1',
      ]);
    });

    it('should pass null when metadata is null', async () => {
      await setPageCompleted('page-1', 'text', null, 'ocr');

      expect(mockQuery).toHaveBeenCalledWith(SET_PAGE_COMPLETED_SQL, [
        'FILE', 'text', 'completed', 'ocr', null, 'page-1',
      ]);
    });

    it('should release client on error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('DB error'));
      await expect(setPageCompleted('p', 'text', null)).rejects.toThrow('DB error');
      expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    it('warns that the body was left alone when the page is no longer a FILE', async () => {
      respondWithPageType('DOCUMENT');
      const warn = vi.spyOn(loggers.processor, 'warn').mockImplementation(() => {});

      await setPageCompleted('page-1', 'extracted text', null, 'text');

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('page-1 is a DOCUMENT, not a FILE')
      );
      warn.mockRestore();
    });

    it('warns when the page no longer exists', async () => {
      respondWithPageType(null);
      const warn = vi.spyOn(loggers.processor, 'warn').mockImplementation(() => {});

      await setPageCompleted('page-1', 'extracted text', null, 'text');

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('no longer exists'));
      warn.mockRestore();
    });

    it('says nothing when the write landed normally', async () => {
      const warn = vi.spyOn(loggers.processor, 'warn').mockImplementation(() => {});

      await setPageCompleted('page-1', 'extracted text', null, 'text');

      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
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
