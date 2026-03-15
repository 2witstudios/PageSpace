/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/trash/drives/[driveId]
//
// Tests the DELETE handler that permanently deletes a trashed drive.
// Only the drive owner can permanently delete; drive must be in trash.
// ============================================================================

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      drives: { findFirst: vi.fn() },
    },
    delete: vi.fn(),
  },
  drives: { id: 'id', ownerId: 'ownerId' },
  eq: vi.fn(),
  and: vi.fn((...args: unknown[]) => args),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@/lib/websocket', () => ({
  broadcastDriveEvent: vi.fn(),
  createDriveEventPayload: vi.fn(),
}));

vi.mock('@pagespace/lib/services/drive-member-service', () => ({
  getDriveRecipientUserIds: vi.fn(),
}));

import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db } from '@pagespace/db';
import { broadcastDriveEvent } from '@/lib/websocket';
import { getDriveRecipientUserIds } from '@pagespace/lib/services/drive-member-service';
import { DELETE } from '../route';

// ============================================================================
// Test Helpers
// ============================================================================

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session',
  adminRoleVersion: 0,
  role: 'user',
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const createContext = (driveId = 'drive_1') => ({
  params: Promise.resolve({ driveId }),
});

const createRequest = () =>
  new Request('https://example.com/api/trash/drives/drive_1', {
    method: 'DELETE',
  });

const mockDrive = (overrides: Record<string, unknown> = {}) => ({
  id: 'drive_1',
  name: 'My Drive',
  slug: 'my-drive',
  ownerId: 'user_1',
  isTrashed: true,
  ...overrides,
});

// ============================================================================
// Tests
// ============================================================================

describe('DELETE /api/trash/drives/[driveId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth('user_1'));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(mockDrive() as any);
    vi.mocked(getDriveRecipientUserIds).mockResolvedValue(['user_1', 'user_2']);
    vi.mocked(db.delete).mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    } as any);
    vi.mocked(broadcastDriveEvent).mockResolvedValue(undefined);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const response = await DELETE(createRequest(), createContext());

      expect(response.status).toBe(401);
    });
  });

  describe('authorization and validation', () => {
    it('should return 404 when drive not found', async () => {
      vi.mocked(db.query.drives.findFirst).mockResolvedValue(null);

      const response = await DELETE(createRequest(), createContext());

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe('Drive not found or access denied');
    });

    it('should return 404 when drive belongs to another user (ownership check in query)', async () => {
      // The query includes ownerId filter, so a non-match returns null
      vi.mocked(db.query.drives.findFirst).mockResolvedValue(null);

      const response = await DELETE(createRequest(), createContext());

      expect(response.status).toBe(404);
    });

    it('should return 400 when drive is not in trash', async () => {
      vi.mocked(db.query.drives.findFirst).mockResolvedValue(
        mockDrive({ isTrashed: false }) as any
      );

      const response = await DELETE(createRequest(), createContext());

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('Drive must be in trash before permanent deletion');
    });
  });

  describe('success path', () => {
    it('should permanently delete the drive and return success', async () => {
      const response = await DELETE(createRequest(), createContext());

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(db.delete).toHaveBeenCalled();
    });

    it('should get recipient user IDs before deleting', async () => {
      await DELETE(createRequest(), createContext());

      expect(getDriveRecipientUserIds).toHaveBeenCalledWith('drive_1');
    });

    it('should broadcast drive deletion event', async () => {
      await DELETE(createRequest(), createContext());

      expect(broadcastDriveEvent).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should return 500 on unexpected error', async () => {
      vi.mocked(db.query.drives.findFirst).mockRejectedValue(new Error('DB crash'));

      const response = await DELETE(createRequest(), createContext());

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe('Failed to permanently delete drive');
    });

    it('should return 500 when delete operation fails', async () => {
      vi.mocked(db.delete).mockReturnValue({
        where: vi.fn().mockRejectedValue(new Error('Foreign key constraint')),
      } as any);

      const response = await DELETE(createRequest(), createContext());

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe('Failed to permanently delete drive');
    });
  });
});
