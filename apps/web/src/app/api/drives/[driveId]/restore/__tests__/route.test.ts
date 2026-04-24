import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/drives/[driveId]/restore
//
// Tests mock at the SERVICE SEAM level, not ORM level.
// ============================================================================

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      drives: {
        findFirst: vi.fn(),
      },
    },
    update: vi.fn(),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a, b) => ({ field: a, value: b })),
  and: vi.fn((...args: unknown[]) => args),
}));
vi.mock('@pagespace/db/schema/core', () => ({
  drives: { id: 'drives.id', ownerId: 'drives.ownerId' },
}));

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

vi.mock('@/lib/websocket', () => ({
  broadcastDriveEvent: vi.fn().mockResolvedValue(undefined),
  createDriveEventPayload: vi.fn((driveId, event, data) => ({ driveId, event, data })),
}));

vi.mock('@pagespace/lib/services/drive-member-service', () => ({
  getDriveRecipientUserIds: vi.fn().mockResolvedValue(['user-123', 'user-456']),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
  isMCPAuthResult: vi.fn().mockReturnValue(false),
  checkMCPDriveScope: vi.fn().mockReturnValue(null),
}));

vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn().mockResolvedValue({ actorEmail: 'test@example.com', actorDisplayName: 'Test User' }),
  logDriveActivity: vi.fn(),
}));

import { POST } from '../route';
import { db } from '@pagespace/db/db';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { broadcastDriveEvent, createDriveEventPayload } from '@/lib/websocket';
import { getDriveRecipientUserIds } from '@pagespace/lib/services/drive-member-service';
import { authenticateRequestWithOptions, isAuthError, isMCPAuthResult, checkMCPDriveScope } from '@/lib/auth';
import { getActorInfo, logDriveActivity } from '@pagespace/lib/monitoring/activity-logger';

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

const createDriveFixture = (overrides: { id: string; name: string; ownerId?: string; isTrashed?: boolean; slug?: string }) => ({
  id: overrides.id,
  name: overrides.name,
  slug: overrides.slug ?? overrides.name.toLowerCase().replace(/\s+/g, '-'),
  ownerId: overrides.ownerId ?? 'user_123',
  isTrashed: overrides.isTrashed ?? true,
  trashedAt: overrides.isTrashed !== false ? new Date('2024-06-01') : null,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  drivePrompt: null,
});

// ============================================================================
// POST /api/drives/[driveId]/restore - Contract Tests
// ============================================================================

describe('POST /api/drives/[driveId]/restore', () => {
  const mockUserId = 'user_123';
  const mockDriveId = 'drive_abc';
  const mockSetFn = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(checkMCPDriveScope).mockReturnValue(null);
    vi.mocked(isMCPAuthResult).mockReturnValue(false);
    vi.mocked(db.update).mockReturnValue({ set: mockSetFn } as never);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/restore`, {
        method: 'POST',
      });
      const response = await POST(request, createContext(mockDriveId));

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe('Unauthorized');
    });

    it('should call authenticateRequestWithOptions with CSRF-enabled write options', async () => {
      vi.mocked(db.query.drives.findFirst).mockResolvedValue(
        createDriveFixture({ id: mockDriveId, name: 'Test', isTrashed: true })
      );

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/restore`, {
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

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/restore`, {
        method: 'POST',
      });
      const response = await POST(request, createContext(mockDriveId));

      expect(response.status).toBe(403);
    });
  });

  describe('authorization', () => {
    it('should return 404 when drive not found', async () => {
      vi.mocked(db.query.drives.findFirst).mockResolvedValue(undefined);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/restore`, {
        method: 'POST',
      });
      const response = await POST(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Drive not found or access denied');
    });

    it('should return 400 when drive is not in trash', async () => {
      vi.mocked(db.query.drives.findFirst).mockResolvedValue(
        createDriveFixture({ id: mockDriveId, name: 'Test', isTrashed: false })
      );

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/restore`, {
        method: 'POST',
      });
      const response = await POST(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Drive is not in trash');
    });
  });

  describe('service integration', () => {
    it('should update drive to remove trashed state', async () => {
      const drive = createDriveFixture({ id: mockDriveId, name: 'Test', isTrashed: true });
      vi.mocked(db.query.drives.findFirst).mockResolvedValue(drive);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/restore`, {
        method: 'POST',
      });
      await POST(request, createContext(mockDriveId));

      expect(db.update).toHaveBeenCalledWith({ id: 'drives.id', ownerId: 'drives.ownerId' });
      expect(mockSetFn).toHaveBeenCalledWith(
        expect.objectContaining({
          isTrashed: false,
          trashedAt: null,
        })
      );
    });
  });

  describe('boundary obligations', () => {
    it('should broadcast drive updated event', async () => {
      const drive = createDriveFixture({ id: mockDriveId, name: 'Restored Drive', slug: 'restored-drive', isTrashed: true });
      vi.mocked(db.query.drives.findFirst).mockResolvedValue(drive);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/restore`, {
        method: 'POST',
      });
      await POST(request, createContext(mockDriveId));

      expect(getDriveRecipientUserIds).toHaveBeenCalledWith(mockDriveId);
      expect(createDriveEventPayload).toHaveBeenCalledWith(
        mockDriveId,
        'updated',
        { name: 'Restored Drive', slug: 'restored-drive' }
      );
      expect(broadcastDriveEvent).toHaveBeenCalledWith(
        expect.objectContaining({ driveId: mockDriveId, event: 'updated' }),
        ['user-123', 'user-456']
      );
    });

    it('should log drive activity for audit trail', async () => {
      const drive = createDriveFixture({ id: mockDriveId, name: 'Audit Drive', isTrashed: true });
      vi.mocked(db.query.drives.findFirst).mockResolvedValue(drive);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/restore`, {
        method: 'POST',
      });
      await POST(request, createContext(mockDriveId));

      expect(getActorInfo).toHaveBeenCalledWith(mockUserId);
      expect(logDriveActivity).toHaveBeenCalledWith(
        mockUserId,
        'restore',
        { id: mockDriveId, name: 'Audit Drive' },
        expect.objectContaining({
          actorEmail: 'test@example.com',
          actorDisplayName: 'Test User',
          metadata: undefined,
          previousValues: { isTrashed: true },
          newValues: { isTrashed: false },
        })
      );
    });

    it('should include MCP metadata when auth is MCP', async () => {
      const drive = createDriveFixture({ id: mockDriveId, name: 'MCP Drive', isTrashed: true });
      vi.mocked(db.query.drives.findFirst).mockResolvedValue(drive);
      vi.mocked(isMCPAuthResult).mockReturnValue(true);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/restore`, {
        method: 'POST',
      });
      await POST(request, createContext(mockDriveId));

      expect(logDriveActivity).toHaveBeenCalledWith(
        mockUserId,
        'restore',
        { id: mockDriveId, name: 'MCP Drive' },
        expect.objectContaining({
          metadata: { source: 'mcp' },
        })
      );
    });
  });

  describe('response contract', () => {
    it('should return success=true on successful restore', async () => {
      const drive = createDriveFixture({ id: mockDriveId, name: 'Test', isTrashed: true });
      vi.mocked(db.query.drives.findFirst).mockResolvedValue(drive);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/restore`, {
        method: 'POST',
      });
      const response = await POST(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should return 500 when database throws', async () => {
      vi.mocked(db.query.drives.findFirst).mockRejectedValueOnce(new Error('Database error'));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/restore`, {
        method: 'POST',
      });
      const response = await POST(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to restore drive');
    });

    it('should log error when database throws', async () => {
      const error = new Error('Restore failure');
      vi.mocked(db.query.drives.findFirst).mockRejectedValueOnce(error);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/restore`, {
        method: 'POST',
      });
      await POST(request, createContext(mockDriveId));

      expect(loggers.api.error).toHaveBeenCalledWith('Error restoring drive:', error);
    });
  });
});
