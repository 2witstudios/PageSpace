/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

// ============================================================================
// Contract Tests for GET /api/admin/audit-logs/integrity
//
// Tests the hash chain integrity verification endpoint.
// Supports modes: full, quick, stats, entry.
// ============================================================================

let mockAdminUser: { id: string; role: string; tokenVersion: number; adminRoleVersion: number; authTransport: string } | null = null;

vi.mock('@/lib/auth', () => ({
  withAdminAuth: vi.fn((handler: any) => {
    return async (request: Request) => {
      if (!mockAdminUser) {
        return NextResponse.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
      }
      return handler(mockAdminUser, request);
    };
  }),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@pagespace/lib/monitoring/hash-chain-verifier', () => ({
  verifyHashChain: vi.fn(),
  quickIntegrityCheck: vi.fn(),
  getHashChainStats: vi.fn(),
  verifyEntry: vi.fn(),
}));

vi.mock('@pagespace/lib/validators', () => ({
  isValidId: vi.fn(() => true),
}));

vi.mock('@/lib/utils/query-params', () => ({
  parseBoundedIntParam: vi.fn((value: string | null, opts: { defaultValue: number }) => {
    if (!value) return opts.defaultValue;
    return parseInt(value, 10) || opts.defaultValue;
  }),
}));

import { GET } from '../route';
import { loggers } from '@pagespace/lib/server';
import {
  verifyHashChain,
  quickIntegrityCheck,
  getHashChainStats,
  verifyEntry,
} from '@pagespace/lib/monitoring/hash-chain-verifier';
import { isValidId } from '@pagespace/lib/validators';

// ============================================================================
// Test Helpers
// ============================================================================

const setAdminAuth = (id = 'admin_1') => {
  mockAdminUser = { id, role: 'admin', tokenVersion: 1, adminRoleVersion: 0, authTransport: 'cookie' };
};

const setNoAuth = () => {
  mockAdminUser = null;
};

// ============================================================================
// Tests
// ============================================================================

describe('GET /api/admin/audit-logs/integrity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAdminAuth();
    vi.mocked(isValidId).mockReturnValue(true);
  });

  describe('authentication & authorization', () => {
    it('should return 403 when not an admin', async () => {
      setNoAuth();

      const request = new Request('https://example.com/api/admin/audit-logs/integrity');
      const response = await GET(request);

      expect(response.status).toBe(403);
    });
  });

  describe('mode: quick (default)', () => {
    it('should use quick mode by default', async () => {
      vi.mocked(quickIntegrityCheck).mockResolvedValue({
        isLikelyValid: true,
        hasChainSeed: true,
        lastEntriesValid: true,
        sampleValid: true,
        details: 'All checks passed',
      } as any);

      const request = new Request('https://example.com/api/admin/audit-logs/integrity');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.mode).toBe('quick');
      expect(body.result).toHaveProperty('isLikelyValid');
      expect(body.result).toHaveProperty('hasChainSeed');
      expect(body.result).toHaveProperty('lastEntriesValid');
      expect(body.result).toHaveProperty('sampleValid');
      expect(body).toHaveProperty('verifiedAt');
    });
  });

  describe('mode: full', () => {
    it('should perform full verification', async () => {
      vi.mocked(verifyHashChain).mockResolvedValue({
        isValid: true,
        totalEntries: 100,
        entriesVerified: 100,
        validEntries: 100,
        invalidEntries: 0,
        entriesWithoutHash: 0,
        chainSeed: 'abcdef1234567890abcdef',
        firstEntryId: 'entry_1',
        lastEntryId: 'entry_100',
        durationMs: 250,
        breakPoint: null,
      } as any);

      const request = new Request('https://example.com/api/admin/audit-logs/integrity?mode=full');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.mode).toBe('full');
      expect(body.result.isValid).toBe(true);
      expect(body.result.totalEntries).toBe(100);
      expect(body.result.entriesVerified).toBe(100);
      expect(body.result.chainSeed).toContain('...');
    });

    it('should include break point when chain is broken', async () => {
      vi.mocked(verifyHashChain).mockResolvedValue({
        isValid: false,
        totalEntries: 100,
        entriesVerified: 50,
        validEntries: 49,
        invalidEntries: 1,
        entriesWithoutHash: 0,
        chainSeed: 'abcdef1234567890abcdef',
        firstEntryId: 'entry_1',
        lastEntryId: 'entry_50',
        durationMs: 150,
        breakPoint: {
          entryId: 'entry_50',
          timestamp: new Date('2024-06-15'),
          position: 50,
          description: 'Hash mismatch detected',
        },
      } as any);

      const request = new Request('https://example.com/api/admin/audit-logs/integrity?mode=full');
      const response = await GET(request);
      const body = await response.json();

      expect(body.result.isValid).toBe(false);
      expect(body.result.breakPoint).toBeDefined();
      expect(body.result.breakPoint.entryId).toBe('entry_50');
    });

    it('should accept limit, dateFrom, and dateTo parameters', async () => {
      vi.mocked(verifyHashChain).mockResolvedValue({
        isValid: true,
        totalEntries: 10,
        entriesVerified: 10,
        validEntries: 10,
        invalidEntries: 0,
        entriesWithoutHash: 0,
        chainSeed: null,
        firstEntryId: null,
        lastEntryId: null,
        durationMs: 50,
        breakPoint: null,
      } as any);

      const request = new Request(
        'https://example.com/api/admin/audit-logs/integrity?mode=full&limit=100&dateFrom=2024-01-01&dateTo=2024-12-31'
      );
      const response = await GET(request);

      expect(response.status).toBe(200);
      expect(verifyHashChain).toHaveBeenCalledWith(
        expect.objectContaining({
          stopOnFirstBreak: true,
        })
      );
    });
  });

  describe('mode: stats', () => {
    it('should return hash chain statistics', async () => {
      vi.mocked(getHashChainStats).mockResolvedValue({
        totalEntries: 500,
        entriesWithHash: 480,
        entriesWithoutHash: 20,
        hasChainSeed: true,
        firstEntryTimestamp: new Date('2024-01-01'),
        lastEntryTimestamp: new Date('2024-12-31'),
      } as any);

      const request = new Request('https://example.com/api/admin/audit-logs/integrity?mode=stats');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.mode).toBe('stats');
      expect(body.result.totalEntries).toBe(500);
      expect(body.result.entriesWithHash).toBe(480);
      expect(body.result.hashCoverage).toBe(96);
      expect(body.result.hasChainSeed).toBe(true);
    });

    it('should handle zero entries for hashCoverage', async () => {
      vi.mocked(getHashChainStats).mockResolvedValue({
        totalEntries: 0,
        entriesWithHash: 0,
        entriesWithoutHash: 0,
        hasChainSeed: false,
        firstEntryTimestamp: null,
        lastEntryTimestamp: null,
      } as any);

      const request = new Request('https://example.com/api/admin/audit-logs/integrity?mode=stats');
      const response = await GET(request);
      const body = await response.json();

      expect(body.result.hashCoverage).toBe(0);
    });
  });

  describe('mode: entry', () => {
    it('should return 400 when entryId is missing', async () => {
      const request = new Request('https://example.com/api/admin/audit-logs/integrity?mode=entry');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('entryId parameter is required for mode=entry');
    });

    it('should return 400 for invalid entryId format', async () => {
      vi.mocked(isValidId).mockReturnValue(false);

      const request = new Request('https://example.com/api/admin/audit-logs/integrity?mode=entry&entryId=invalid');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid entryId format');
    });

    it('should return 404 when entry not found', async () => {
      vi.mocked(verifyEntry).mockResolvedValue(null);

      const request = new Request('https://example.com/api/admin/audit-logs/integrity?mode=entry&entryId=valid_id');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Entry not found');
    });

    it('should return entry verification result', async () => {
      vi.mocked(verifyEntry).mockResolvedValue({
        id: 'entry_1',
        timestamp: new Date('2024-06-15'),
        isValid: true,
        storedHash: 'abcdef1234567890abcdef1234567890',
        computedHash: 'abcdef1234567890abcdef1234567890',
        previousHashUsed: '0000001234567890abcdef1234567890',
      } as any);

      const request = new Request('https://example.com/api/admin/audit-logs/integrity?mode=entry&entryId=entry_1');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.mode).toBe('entry');
      expect(body.result.isValid).toBe(true);
      expect(body.result.storedHash).toContain('...');
      expect(body.result.computedHash).toContain('...');
    });
  });

  describe('invalid mode', () => {
    it('should return 400 for unknown mode', async () => {
      const request = new Request('https://example.com/api/admin/audit-logs/integrity?mode=unknown');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('Invalid mode');
    });
  });

  describe('error handling', () => {
    it('should return 500 when verification throws', async () => {
      vi.mocked(quickIntegrityCheck).mockRejectedValue(new Error('Verification error'));

      const request = new Request('https://example.com/api/admin/audit-logs/integrity');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to check hash chain integrity');
    });

    it('should log error when verification fails', async () => {
      const error = new Error('Check failed');
      vi.mocked(quickIntegrityCheck).mockRejectedValue(error);

      const request = new Request('https://example.com/api/admin/audit-logs/integrity');
      await GET(request);

      expect(loggers.api.error).toHaveBeenCalledWith('Error checking hash chain integrity:', error);
    });
  });
});
