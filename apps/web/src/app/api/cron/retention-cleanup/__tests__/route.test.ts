/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

// ============================================================================
// Contract Tests for /api/cron/retention-cleanup
//
// Tests data retention cleanup across tables with expiresAt columns.
// ============================================================================

vi.mock('@/lib/auth/cron-auth', () => ({
  validateSignedCronRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/compliance/retention/retention-engine', () => ({
  runRetentionCleanup: vi.fn(),
}));

vi.mock('@pagespace/db', () => ({
  db: {},
}));

import { GET, POST } from '../route';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';
import { runRetentionCleanup } from '@pagespace/lib/compliance/retention/retention-engine';

// ============================================================================
// Fixtures
// ============================================================================

const MOCK_RESULTS = [
  { table: 'sessions', deleted: 5 },
  { table: 'verification_tokens', deleted: 3 },
  { table: 'socket_tokens', deleted: 0 },
];

// ============================================================================
// GET /api/cron/retention-cleanup - Contract Tests
// ============================================================================

describe('GET /api/cron/retention-cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateSignedCronRequest).mockReturnValue(null);
  });

  describe('authentication', () => {
    it('should return auth error when cron request is invalid', async () => {
      const errorResponse = NextResponse.json(
        { error: 'Forbidden' },
        { status: 403 }
      );
      vi.mocked(validateSignedCronRequest).mockReturnValue(errorResponse);

      const request = new Request('http://localhost/api/cron/retention-cleanup');
      const response = await GET(request);

      expect(response.status).toBe(403);
    });
  });

  describe('success', () => {
    it('should return total deleted and per-table results', async () => {
      vi.mocked(runRetentionCleanup).mockResolvedValue(MOCK_RESULTS);

      const request = new Request('http://localhost/api/cron/retention-cleanup');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.totalDeleted).toBe(8);
      expect(body.results).toEqual(MOCK_RESULTS);
      expect(body.timestamp).toBeDefined();
    });

    it('should return totalDeleted=0 when nothing is expired', async () => {
      vi.mocked(runRetentionCleanup).mockResolvedValue([
        { table: 'sessions', deleted: 0 },
        { table: 'socket_tokens', deleted: 0 },
      ]);

      const request = new Request('http://localhost/api/cron/retention-cleanup');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.totalDeleted).toBe(0);
    });

    it('should pass db instance to runRetentionCleanup', async () => {
      vi.mocked(runRetentionCleanup).mockResolvedValue([]);

      const request = new Request('http://localhost/api/cron/retention-cleanup');
      await GET(request);

      expect(runRetentionCleanup).toHaveBeenCalledWith(expect.anything());
    });
  });

  describe('error handling', () => {
    it('should return 500 when retention cleanup throws', async () => {
      vi.mocked(runRetentionCleanup).mockRejectedValue(new Error('Cleanup failed'));

      const request = new Request('http://localhost/api/cron/retention-cleanup');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.error).toBe('Cleanup failed');
    });

    it('should return "Unknown error" for non-Error throws', async () => {
      vi.mocked(runRetentionCleanup).mockRejectedValue({ code: 'ERR' });

      const request = new Request('http://localhost/api/cron/retention-cleanup');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Unknown error');
    });
  });
});

// ============================================================================
// POST /api/cron/retention-cleanup - Delegates to GET
// ============================================================================

describe('POST /api/cron/retention-cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateSignedCronRequest).mockReturnValue(null);
  });

  it('should delegate to GET handler', async () => {
    vi.mocked(runRetentionCleanup).mockResolvedValue(MOCK_RESULTS);

    const request = new Request('http://localhost/api/cron/retention-cleanup', { method: 'POST' });
    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.totalDeleted).toBe(8);
  });
});
