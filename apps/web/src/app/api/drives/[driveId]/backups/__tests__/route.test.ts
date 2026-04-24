import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/drives/[driveId]/backups
//
// Tests mock at the SERVICE SEAM level, not ORM level.
// ============================================================================

vi.mock('@pagespace/lib/audit/audit-log', () => ({
    audit: vi.fn(),
    auditRequest: vi.fn(),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
    loggers: {
    api: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@/services/api/drive-backup-service', () => ({
  createDriveBackup: vi.fn(),
  listDriveBackups: vi.fn(),
}));

import { GET, POST } from '../route';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { createDriveBackup, listDriveBackups } from '@/services/api/drive-backup-service';

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

const createParams = (driveId: string) => ({
  params: Promise.resolve({ driveId }),
});

// ============================================================================
// GET /api/drives/[driveId]/backups - Contract Tests
// ============================================================================

describe('GET /api/drives/[driveId]/backups', () => {
  const mockUserId = 'user_123';
  const mockDriveId = 'drive_abc';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/backups`);
      const response = await GET(request, createParams(mockDriveId));

      expect(response.status).toBe(401);
    });

    it('should call authenticateRequestWithOptions with session-only read options', async () => {
      vi.mocked(listDriveBackups).mockResolvedValue({ success: true, backups: [] });

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/backups`);
      await GET(request, createParams(mockDriveId));

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: false }
      );
    });
  });

  describe('query param validation', () => {
    it('should accept valid limit and offset', async () => {
      vi.mocked(listDriveBackups).mockResolvedValue({ success: true, backups: [] });

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/backups?limit=10&offset=5`);
      const response = await GET(request, createParams(mockDriveId));

      expect(response.status).toBe(200);
      expect(listDriveBackups).toHaveBeenCalledWith(mockDriveId, mockUserId, {
        limit: 10,
        offset: 5,
      });
    });

    it('should handle missing limit and offset', async () => {
      vi.mocked(listDriveBackups).mockResolvedValue({ success: true, backups: [] });

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/backups`);
      const response = await GET(request, createParams(mockDriveId));

      expect(response.status).toBe(200);
      expect(listDriveBackups).toHaveBeenCalledWith(mockDriveId, mockUserId, {
        limit: undefined,
        offset: undefined,
      });
    });

    it('should return 400 for invalid limit (NaN)', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/backups?limit=abc`);
      const response = await GET(request, createParams(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid limit parameter');
    });

    it('should return 400 for negative limit', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/backups?limit=-1`);
      const response = await GET(request, createParams(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid limit parameter');
    });

    it('should return 400 for invalid offset (NaN)', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/backups?offset=abc`);
      const response = await GET(request, createParams(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid offset parameter');
    });

    it('should return 400 for negative offset', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/backups?offset=-5`);
      const response = await GET(request, createParams(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid offset parameter');
    });
  });

  describe('service integration', () => {
    it('should return backups from service on success', async () => {
      const backups = [
        { id: 'backup_1', createdAt: '2024-01-01', label: 'Test' },
        { id: 'backup_2', createdAt: '2024-01-02', label: 'Test 2' },
      ];
      vi.mocked(listDriveBackups).mockResolvedValue({ success: true, backups } as never);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/backups`);
      const response = await GET(request, createParams(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.backups).toEqual(backups);
    });

    it('should return error with status when service fails', async () => {
      vi.mocked(listDriveBackups).mockResolvedValue({
        success: false,
        error: 'Access denied',
        status: 403,
      } as never);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/backups`);
      const response = await GET(request, createParams(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Access denied');
    });

    it('should default to 403 when service fails without explicit status', async () => {
      vi.mocked(listDriveBackups).mockResolvedValue({
        success: false,
        error: 'Permission denied',
      } as never);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/backups`);
      const response = await GET(request, createParams(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Permission denied');
    });
  });

  describe('error handling', () => {
    it('should return 500 when service throws', async () => {
      vi.mocked(listDriveBackups).mockRejectedValueOnce(new Error('Database error'));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/backups`);
      const response = await GET(request, createParams(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch backups');
    });

    it('should log error when service throws', async () => {
      const error = new Error('Fetch failure');
      vi.mocked(listDriveBackups).mockRejectedValueOnce(error);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/backups`);
      await GET(request, createParams(mockDriveId));

      expect(loggers.api.error).toHaveBeenCalledWith('Error fetching drive backups', error);
    });
  });
});

// ============================================================================
// POST /api/drives/[driveId]/backups - Contract Tests
// ============================================================================

describe('POST /api/drives/[driveId]/backups', () => {
  const mockUserId = 'user_123';
  const mockDriveId = 'drive_abc';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/backups`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      const response = await POST(request, createParams(mockDriveId));

      expect(response.status).toBe(401);
    });

    it('should call authenticateRequestWithOptions with session-only CSRF write options', async () => {
      vi.mocked(createDriveBackup).mockResolvedValue({
        success: true,
        backupId: 'backup_1',
        status: 'completed',
        counts: { pages: 5, files: 10 },
      } as never);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/backups`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      await POST(request, createParams(mockDriveId));

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: true }
      );
    });
  });

  describe('validation', () => {
    it('should accept valid backup creation body', async () => {
      vi.mocked(createDriveBackup).mockResolvedValue({
        success: true,
        backupId: 'backup_1',
        status: 'completed',
        counts: { pages: 5, files: 10 },
      } as never);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/backups`, {
        method: 'POST',
        body: JSON.stringify({
          label: 'My backup',
          reason: 'Before migration',
          source: 'manual',
          includeTrashed: true,
          metadata: { key: 'value' },
        }),
      });
      const response = await POST(request, createParams(mockDriveId));

      expect(response.status).toBe(201);
    });

    it('should accept empty body (all fields optional)', async () => {
      vi.mocked(createDriveBackup).mockResolvedValue({
        success: true,
        backupId: 'backup_1',
        status: 'completed',
        counts: { pages: 0, files: 0 },
      } as never);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/backups`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      const response = await POST(request, createParams(mockDriveId));

      expect(response.status).toBe(201);
    });

    it('should return 400 for invalid source enum value', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/backups`, {
        method: 'POST',
        body: JSON.stringify({ source: 'invalid_source' }),
      });
      const response = await POST(request, createParams(mockDriveId));

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toEqual(expect.arrayContaining([expect.objectContaining({ message: expect.any(String) })]));
    });
  });

  describe('service integration', () => {
    it('should call createDriveBackup with driveId, userId, and parsed body', async () => {
      vi.mocked(createDriveBackup).mockResolvedValue({
        success: true,
        backupId: 'backup_1',
        status: 'completed',
        counts: { pages: 5, files: 10 },
      } as never);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/backups`, {
        method: 'POST',
        body: JSON.stringify({ label: 'Test backup', source: 'manual' }),
      });
      await POST(request, createParams(mockDriveId));

      expect(createDriveBackup).toHaveBeenCalledWith(mockDriveId, mockUserId, {
        label: 'Test backup',
        source: 'manual',
      });
    });

    it('should return 403 when service denies access', async () => {
      vi.mocked(createDriveBackup).mockResolvedValue({
        success: false,
        error: 'Not authorized',
      } as never);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/backups`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      const response = await POST(request, createParams(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Not authorized');
    });
  });

  describe('response contract', () => {
    it('should return 201 with backupId, status, and counts on success', async () => {
      vi.mocked(createDriveBackup).mockResolvedValue({
        success: true,
        backupId: 'backup_xyz',
        status: 'completed',
        counts: { pages: 10, files: 25 },
      } as never);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/backups`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      const response = await POST(request, createParams(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(201);
      expect(body).toEqual({
        backupId: 'backup_xyz',
        status: 'completed',
        counts: { pages: 10, files: 25 },
      });
    });
  });

  describe('error handling', () => {
    it('should return 400 for ZodError (invalid body)', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/backups`, {
        method: 'POST',
        body: JSON.stringify({ source: 'not_a_valid_enum' }),
      });
      const response = await POST(request, createParams(mockDriveId));

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toEqual(expect.arrayContaining([expect.objectContaining({ message: expect.any(String) })]));
    });

    it('should return 500 when service throws', async () => {
      vi.mocked(createDriveBackup).mockRejectedValueOnce(new Error('Database error'));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/backups`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      const response = await POST(request, createParams(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to create backup');
    });

    it('should log error when service throws', async () => {
      const error = new Error('Creation failure');
      vi.mocked(createDriveBackup).mockRejectedValueOnce(error);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/backups`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      await POST(request, createParams(mockDriveId));

      expect(loggers.api.error).toHaveBeenCalledWith('Error creating drive backup', error);
    });
  });
});
