/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

// ============================================================================
// Contract Tests for /api/cron/verify-audit-chain
//
// Tests security audit hash chain integrity verification.
// ============================================================================

vi.mock('@/lib/auth/cron-auth', () => ({
  validateSignedCronRequest: vi.fn(),
}));

vi.mock('@pagespace/lib', () => ({
  verifySecurityAuditChain: vi.fn(),
}));

import { GET, POST } from '../route';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';
import { verifySecurityAuditChain } from '@pagespace/lib';

// ============================================================================
// Fixtures
// ============================================================================

const VALID_CHAIN_RESULT = {
  isValid: true,
  totalEntries: 100,
  entriesVerified: 100,
  validEntries: 100,
  invalidEntries: 0,
  breakPoint: null,
};

const BROKEN_CHAIN_RESULT = {
  isValid: false,
  totalEntries: 100,
  entriesVerified: 50,
  validEntries: 49,
  invalidEntries: 1,
  breakPoint: { entryId: 'entry_50', position: 50 },
};

// ============================================================================
// GET /api/cron/verify-audit-chain - Contract Tests
// ============================================================================

describe('GET /api/cron/verify-audit-chain', () => {
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

      const request = new Request('http://localhost/api/cron/verify-audit-chain');
      const response = await GET(request);

      expect(response.status).toBe(403);
    });
  });

  describe('success - valid chain', () => {
    it('should return success with valid chain results', async () => {
      vi.mocked(verifySecurityAuditChain).mockResolvedValue(VALID_CHAIN_RESULT);

      const request = new Request('http://localhost/api/cron/verify-audit-chain');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.isValid).toBe(true);
      expect(body.totalEntries).toBe(100);
      expect(body.entriesVerified).toBe(100);
      expect(body.validEntries).toBe(100);
      expect(body.invalidEntries).toBe(0);
      expect(body.breakPoint).toBeNull();
      expect(body.timestamp).toBeDefined();
    });

    it('should call verifySecurityAuditChain with stopOnFirstBreak option', async () => {
      vi.mocked(verifySecurityAuditChain).mockResolvedValue(VALID_CHAIN_RESULT);

      const request = new Request('http://localhost/api/cron/verify-audit-chain');
      await GET(request);

      expect(verifySecurityAuditChain).toHaveBeenCalledWith({ stopOnFirstBreak: true });
    });
  });

  describe('success - broken chain', () => {
    it('should return success=true but isValid=false for broken chain', async () => {
      vi.mocked(verifySecurityAuditChain).mockResolvedValue(BROKEN_CHAIN_RESULT);

      const request = new Request('http://localhost/api/cron/verify-audit-chain');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.isValid).toBe(false);
      expect(body.invalidEntries).toBe(1);
      expect(body.breakPoint).toEqual({ entryId: 'entry_50', position: 50 });
    });
  });

  describe('error handling', () => {
    it('should return 500 when verification throws', async () => {
      vi.mocked(verifySecurityAuditChain).mockRejectedValue(new Error('Hash computation failed'));

      const request = new Request('http://localhost/api/cron/verify-audit-chain');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.error).toBe('Hash computation failed');
    });

    it('should return "Unknown error" for non-Error throws', async () => {
      vi.mocked(verifySecurityAuditChain).mockRejectedValue(undefined);

      const request = new Request('http://localhost/api/cron/verify-audit-chain');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Unknown error');
    });
  });
});

// ============================================================================
// POST /api/cron/verify-audit-chain - Delegates to GET
// ============================================================================

describe('POST /api/cron/verify-audit-chain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateSignedCronRequest).mockReturnValue(null);
  });

  it('should delegate to GET handler', async () => {
    vi.mocked(verifySecurityAuditChain).mockResolvedValue(VALID_CHAIN_RESULT);

    const request = new Request('http://localhost/api/cron/verify-audit-chain', { method: 'POST' });
    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.isValid).toBe(true);
  });
});
