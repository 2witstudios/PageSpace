import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/drives/[driveId]/access
//
// Tests mock at the SERVICE SEAM level, not ORM level.
// ============================================================================

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

vi.mock('@pagespace/lib/services/drive-service', () => ({
  updateDriveLastAccessed: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
  checkMCPDriveScope: vi.fn().mockReturnValue(null),
}));

import { POST } from '../route';
import { loggers } from '@pagespace/lib/server';
import { updateDriveLastAccessed } from '@pagespace/lib/services/drive-service';
import { authenticateRequestWithOptions, isAuthError, checkMCPDriveScope } from '@/lib/auth';

// ============================================================================
// Test Helpers
// ============================================================================

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  role: 'user',
  adminRoleVersion: 0,
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const createContext = (driveId: string) => ({
  params: Promise.resolve({ driveId }),
});

// ============================================================================
// POST /api/drives/[driveId]/access - Contract Tests
// ============================================================================

describe('POST /api/drives/[driveId]/access', () => {
  const mockUserId = 'user_123';
  const mockDriveId = 'drive_abc';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(checkMCPDriveScope).mockReturnValue(null);
    vi.mocked(updateDriveLastAccessed).mockResolvedValue(undefined);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/access`, {
        method: 'POST',
      });
      const response = await POST(request, createContext(mockDriveId));

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe('Unauthorized');
    });

    it('should call authenticateRequestWithOptions with CSRF-enabled write options', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/access`, {
        method: 'POST',
      });
      await POST(request, createContext(mockDriveId));

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session', 'mcp'], requireCSRF: true }
      );
    });
  });

  describe('MCP scope check', () => {
    it('should return scope error when MCP scope check fails', async () => {
      const scopeErrorResponse = NextResponse.json({ error: 'Scope denied' }, { status: 403 });
      vi.mocked(checkMCPDriveScope).mockReturnValue(scopeErrorResponse);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/access`, {
        method: 'POST',
      });
      const response = await POST(request, createContext(mockDriveId));

      expect(response.status).toBe(403);
      expect(checkMCPDriveScope).toHaveBeenCalledWith(
        expect.objectContaining({ userId: mockUserId }),
        mockDriveId
      );
    });

    it('should proceed when MCP scope check passes', async () => {
      vi.mocked(checkMCPDriveScope).mockReturnValue(null);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/access`, {
        method: 'POST',
      });
      const response = await POST(request, createContext(mockDriveId));

      expect(response.status).toBe(200);
    });
  });

  describe('service integration', () => {
    it('should call updateDriveLastAccessed with userId and driveId', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/access`, {
        method: 'POST',
      });
      await POST(request, createContext(mockDriveId));

      expect(updateDriveLastAccessed).toHaveBeenCalledWith(mockUserId, mockDriveId);
    });
  });

  describe('response contract', () => {
    it('should return success=true on successful access update', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/access`, {
        method: 'POST',
      });
      const response = await POST(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should return 500 when updateDriveLastAccessed throws an Error', async () => {
      vi.mocked(updateDriveLastAccessed).mockRejectedValueOnce(new Error('Database connection lost'));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/access`, {
        method: 'POST',
      });
      const response = await POST(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to update access time');
    });

    it('should return 500 when updateDriveLastAccessed throws a non-Error', async () => {
      vi.mocked(updateDriveLastAccessed).mockRejectedValueOnce('string error');

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/access`, {
        method: 'POST',
      });
      const response = await POST(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to update access time');
    });

    it('should log error with message when Error is thrown', async () => {
      const error = new Error('Service failure');
      vi.mocked(updateDriveLastAccessed).mockRejectedValueOnce(error);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/access`, {
        method: 'POST',
      });
      await POST(request, createContext(mockDriveId));

      expect(loggers.api.error).toHaveBeenCalledWith(
        'Failed to update drive access time',
        { error: 'Service failure' }
      );
    });

    it('should log error with string conversion when non-Error is thrown', async () => {
      vi.mocked(updateDriveLastAccessed).mockRejectedValueOnce('string error');

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/access`, {
        method: 'POST',
      });
      await POST(request, createContext(mockDriveId));

      expect(loggers.api.error).toHaveBeenCalledWith(
        'Failed to update drive access time',
        { error: 'string error' }
      );
    });
  });
});
