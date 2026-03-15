/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/storage/check
//
// Tests storage quota check (POST) and storage status (GET) endpoints.
// ============================================================================

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib/services/storage-limits', () => ({
  checkStorageQuota: vi.fn(),
  getUserStorageQuota: vi.fn(),
  STORAGE_TIERS: {
    free: {
      maxConcurrentUploads: 3,
      maxFileSizeBytes: 50 * 1024 * 1024,
      quotaBytes: 1024 * 1024 * 1024,
    },
    pro: {
      maxConcurrentUploads: 10,
      maxFileSizeBytes: 500 * 1024 * 1024,
      quotaBytes: 10 * 1024 * 1024 * 1024,
    },
  },
}));

vi.mock('@pagespace/lib/services/upload-semaphore', () => ({
  uploadSemaphore: {
    canAcquireSlot: vi.fn(),
    getStatus: vi.fn(),
  },
}));

vi.mock('@pagespace/lib/services/memory-monitor', () => ({
  checkMemoryMiddleware: vi.fn(),
}));

vi.mock('@/lib/validation/parse-body', () => ({
  safeParseBody: vi.fn(),
}));

import { POST, GET } from '../route';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { checkStorageQuota, getUserStorageQuota } from '@pagespace/lib/services/storage-limits';
import { uploadSemaphore } from '@pagespace/lib/services/upload-semaphore';
import { checkMemoryMiddleware } from '@pagespace/lib/services/memory-monitor';
import { safeParseBody } from '@/lib/validation/parse-body';

// ============================================================================
// Test Helpers
// ============================================================================

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  adminRoleVersion: 0,
  role: 'user',
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const MOCK_QUOTA = {
  tier: 'free' as const,
  usedBytes: 100 * 1024 * 1024,
  quotaBytes: 1024 * 1024 * 1024,
  availableBytes: 924 * 1024 * 1024,
  percentUsed: 10,
};

// ============================================================================
// POST /api/storage/check - Contract Tests
// ============================================================================

describe('POST /api/storage/check', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(safeParseBody).mockResolvedValue({
      success: true,
      data: { fileSize: 1024 },
    });
    vi.mocked(checkMemoryMiddleware).mockResolvedValue({ allowed: true, status: 'ok' });
    vi.mocked(checkStorageQuota).mockResolvedValue({
      allowed: true,
      quota: MOCK_QUOTA,
    } as any);
    vi.mocked(getUserStorageQuota).mockResolvedValue(MOCK_QUOTA as any);
    vi.mocked(uploadSemaphore.canAcquireSlot).mockResolvedValue(true);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('http://localhost/api/storage/check', {
        method: 'POST',
        body: JSON.stringify({ fileSize: 1024 }),
      }) as any;
      const response = await POST(request);

      expect(response.status).toBe(401);
    });
  });

  describe('validation', () => {
    it('should return validation error for invalid body', async () => {
      vi.mocked(safeParseBody).mockResolvedValue({
        success: false,
        response: Response.json({ error: 'Invalid file size' }, { status: 400 }),
      } as any);

      const request = new Request('http://localhost/api/storage/check', {
        method: 'POST',
        body: JSON.stringify({}),
      }) as any;
      const response = await POST(request);

      expect(response.status).toBe(400);
    });
  });

  describe('memory check', () => {
    it('should return 503 when memory is unavailable', async () => {
      vi.mocked(checkMemoryMiddleware).mockResolvedValue({
        allowed: false,
        reason: 'Memory pressure',
        status: 'critical',
      });

      const request = new Request('http://localhost/api/storage/check', {
        method: 'POST',
        body: JSON.stringify({ fileSize: 1024 }),
      }) as any;
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(503);
      expect(body.allowed).toBe(false);
      expect(body.reason).toBe('Memory pressure');
    });
  });

  describe('storage quota', () => {
    it('should return 413 when storage quota exceeded', async () => {
      vi.mocked(checkStorageQuota).mockResolvedValue({
        allowed: false,
        reason: 'Storage quota exceeded',
        quota: MOCK_QUOTA,
        requiredBytes: 2 * 1024 * 1024 * 1024,
      } as any);

      const request = new Request('http://localhost/api/storage/check', {
        method: 'POST',
        body: JSON.stringify({ fileSize: 2 * 1024 * 1024 * 1024 }),
      }) as any;
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(413);
      expect(body.allowed).toBe(false);
      expect(body.reason).toBe('Storage quota exceeded');
    });
  });

  describe('upload quota retrieval failure', () => {
    it('should return 500 when getUserStorageQuota returns null', async () => {
      vi.mocked(getUserStorageQuota).mockResolvedValue(null as any);

      const request = new Request('http://localhost/api/storage/check', {
        method: 'POST',
        body: JSON.stringify({ fileSize: 1024 }),
      }) as any;
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Could not retrieve storage quota');
    });
  });

  describe('concurrent upload limit', () => {
    it('should return 429 when too many concurrent uploads', async () => {
      vi.mocked(uploadSemaphore.canAcquireSlot).mockResolvedValue(false);

      const request = new Request('http://localhost/api/storage/check', {
        method: 'POST',
        body: JSON.stringify({ fileSize: 1024 }),
      }) as any;
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.allowed).toBe(false);
      expect(body.reason).toContain('Too many concurrent uploads');
    });
  });

  describe('success', () => {
    it('should return allowed=true when all checks pass', async () => {
      const request = new Request('http://localhost/api/storage/check', {
        method: 'POST',
        body: JSON.stringify({ fileSize: 1024 }),
      }) as any;
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.allowed).toBe(true);
      expect(body.quota).toBeDefined();
      expect(body.tier).toBe('free');
      expect(body.tierLimits).toBeDefined();
    });
  });

  describe('error handling', () => {
    it('should return 500 when an unexpected error occurs', async () => {
      vi.mocked(checkMemoryMiddleware).mockRejectedValue(new Error('Unexpected'));

      const request = new Request('http://localhost/api/storage/check', {
        method: 'POST',
        body: JSON.stringify({ fileSize: 1024 }),
      }) as any;
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to check storage quota');
    });
  });
});

// ============================================================================
// GET /api/storage/check - Contract Tests
// ============================================================================

describe('GET /api/storage/check', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(getUserStorageQuota).mockResolvedValue(MOCK_QUOTA as any);
    vi.mocked(uploadSemaphore.getStatus).mockReturnValue({
      totalActive: 1,
      userUploads: new Map([['user_123', 1]]),
    } as any);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('http://localhost/api/storage/check') as any;
      const response = await GET(request);

      expect(response.status).toBe(401);
    });
  });

  describe('success', () => {
    it('should return storage status with quota and upload info', async () => {
      const request = new Request('http://localhost/api/storage/check') as any;
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.quota).toBeDefined();
      expect(body.tierLimits).toBeDefined();
      expect(body.activeUploads).toBe(1);
      expect(body.canUpload).toBe(true);
    });

    it('should return canUpload=false when at max concurrent uploads', async () => {
      vi.mocked(uploadSemaphore.getStatus).mockReturnValue({
        totalActive: 3,
        userUploads: new Map([['user_123', 3]]),
      } as any);

      const request = new Request('http://localhost/api/storage/check') as any;
      const response = await GET(request);
      const body = await response.json();

      expect(body.activeUploads).toBe(3);
      expect(body.canUpload).toBe(false);
    });

    it('should return 0 active uploads when user has none', async () => {
      vi.mocked(uploadSemaphore.getStatus).mockReturnValue({
        totalActive: 0,
        userUploads: new Map(),
      } as any);

      const request = new Request('http://localhost/api/storage/check') as any;
      const response = await GET(request);
      const body = await response.json();

      expect(body.activeUploads).toBe(0);
      expect(body.canUpload).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should return 500 when getUserStorageQuota returns null', async () => {
      vi.mocked(getUserStorageQuota).mockResolvedValue(null as any);

      const request = new Request('http://localhost/api/storage/check') as any;
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Could not retrieve storage quota');
    });

    it('should return 500 on unexpected error', async () => {
      vi.mocked(getUserStorageQuota).mockRejectedValue(new Error('DB error'));

      const request = new Request('http://localhost/api/storage/check') as any;
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to get storage info');
    });
  });
});
