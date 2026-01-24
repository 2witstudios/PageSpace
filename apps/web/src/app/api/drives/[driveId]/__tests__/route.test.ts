import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET, PATCH, DELETE } from '../route';
import type { SessionAuthResult, AuthError } from '@/lib/auth';
import type { DriveWithAccess, DriveAccessInfo } from '@pagespace/lib/server';

// ============================================================================
// Contract Tests for /api/drives/[driveId]
//
// These tests mock at the SERVICE SEAM level (getDriveById, getDriveAccess, etc.),
// NOT at the ORM/query-builder level. This tests the route handler's contract:
// Request → Response + boundary obligations (broadcast events)
// ============================================================================

// Mock the service seam - this is the ONLY place we mock DB-related logic
vi.mock('@pagespace/lib/server', () => ({
  getDriveById: vi.fn(),
  getDriveAccess: vi.fn(),
  getDriveWithAccess: vi.fn(),
  updateDrive: vi.fn(),
  trashDrive: vi.fn(),
  loggers: {
    api: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

vi.mock('@/lib/websocket', () => ({
  broadcastDriveEvent: vi.fn().mockResolvedValue(undefined),
  createDriveEventPayload: vi.fn((driveId, event, data) => ({ driveId, event, data })),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

import {
  getDriveById,
  getDriveAccess,
  getDriveWithAccess,
  updateDrive,
  trashDrive,
  loggers,
} from '@pagespace/lib/server';
import { broadcastDriveEvent, createDriveEventPayload } from '@/lib/websocket';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

// ============================================================================
// Test Helpers
// ============================================================================

const mockWebAuth = (userId: string, tokenVersion = 0): SessionAuthResult => ({
  userId,
  tokenVersion,
  tokenType: 'session',
  sessionId: 'test-session-id',
  role: 'user',
  adminRoleVersion: 0,
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

// Raw drive fixture (without access info)
const createRawDriveFixture = (overrides: { id: string; name: string; ownerId?: string }) => ({
  id: overrides.id,
  name: overrides.name,
  slug: overrides.name.toLowerCase().replace(/\s+/g, '-'),
  ownerId: overrides.ownerId ?? 'user_123',
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  isTrashed: false,
  trashedAt: null,
  drivePrompt: null,
});

// Drive with access info fixture
const createDriveWithAccessFixture = (
  overrides: Partial<DriveWithAccess> & { id: string; name: string; isMember?: boolean }
): DriveWithAccess & { isMember: boolean } => ({
  id: overrides.id,
  name: overrides.name,
  slug: overrides.slug ?? overrides.name.toLowerCase().replace(/\s+/g, '-'),
  ownerId: overrides.ownerId ?? 'user_123',
  createdAt: overrides.createdAt ?? new Date('2024-01-01'),
  updatedAt: overrides.updatedAt ?? new Date('2024-01-01'),
  isTrashed: overrides.isTrashed ?? false,
  trashedAt: overrides.trashedAt ?? null,
  drivePrompt: overrides.drivePrompt ?? null,
  isOwned: overrides.isOwned ?? true,
  role: overrides.role ?? 'OWNER',
  isMember: (overrides as { isMember?: boolean }).isMember ?? false,
});

// Access info fixture
const createAccessFixture = (overrides: Partial<DriveAccessInfo> = {}): DriveAccessInfo => ({
  isOwner: overrides.isOwner ?? false,
  isAdmin: overrides.isAdmin ?? false,
  isMember: overrides.isMember ?? false,
  role: overrides.role ?? null,
});

// Create mock context with async params (Next.js 15 pattern)
const createContext = (driveId: string) => ({
  params: Promise.resolve({ driveId }),
});

// ============================================================================
// GET /api/drives/[driveId] - Contract Tests
// ============================================================================

describe('GET /api/drives/[driveId]', () => {
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

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`);
      const response = await GET(request, createContext(mockDriveId));

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe('Unauthorized');
    });

    it('should call authenticateRequestWithOptions with read auth options', async () => {
      vi.mocked(getDriveWithAccess).mockResolvedValue(
        createDriveWithAccessFixture({ id: mockDriveId, name: 'Test' })
      );

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`);
      await GET(request, createContext(mockDriveId));

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session', 'mcp'], requireCSRF: false }
      );
    });
  });

  describe('service integration', () => {
    it('should call getDriveWithAccess with driveId and userId', async () => {
      vi.mocked(getDriveWithAccess).mockResolvedValue(
        createDriveWithAccessFixture({ id: mockDriveId, name: 'Test' })
      );

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`);
      await GET(request, createContext(mockDriveId));

      expect(getDriveWithAccess).toHaveBeenCalledWith(mockDriveId, mockUserId);
    });

    it('should call getDriveById when getDriveWithAccess returns null', async () => {
      vi.mocked(getDriveWithAccess).mockResolvedValue(null);
      vi.mocked(getDriveById).mockResolvedValue(createRawDriveFixture({ id: mockDriveId, name: 'Test' }));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`);
      await GET(request, createContext(mockDriveId));

      expect(getDriveById).toHaveBeenCalledWith(mockDriveId);
    });
  });

  describe('authorization', () => {
    it('should return 404 when drive not found', async () => {
      vi.mocked(getDriveWithAccess).mockResolvedValue(null);
      vi.mocked(getDriveById).mockResolvedValue(null);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Drive not found');
    });

    it('should return 403 when user has no access but drive exists', async () => {
      vi.mocked(getDriveWithAccess).mockResolvedValue(null);
      vi.mocked(getDriveById).mockResolvedValue(
        createRawDriveFixture({ id: mockDriveId, name: 'Other Drive', ownerId: 'other_user' })
      );

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Access denied');
    });
  });

  describe('response contract', () => {
    it('should return drive with isOwned=true when user is owner', async () => {
      vi.mocked(getDriveWithAccess).mockResolvedValue(
        createDriveWithAccessFixture({
          id: mockDriveId,
          name: 'My Drive',
          isOwned: true,
          role: 'OWNER',
          isMember: false,
        })
      );

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        id: mockDriveId,
        name: 'My Drive',
        isOwned: true,
        isMember: false,
        role: 'OWNER',
      });
    });

    it('should return drive with isMember=true when user is member', async () => {
      vi.mocked(getDriveWithAccess).mockResolvedValue(
        createDriveWithAccessFixture({
          id: mockDriveId,
          name: 'Shared Drive',
          ownerId: 'other_user',
          isOwned: false,
          role: 'MEMBER',
          isMember: true,
        })
      );

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.isOwned).toBe(false);
      expect(body.isMember).toBe(true);
      expect(body.role).toBe('MEMBER');
    });

    it('should return all drive fields in response', async () => {
      vi.mocked(getDriveWithAccess).mockResolvedValue(
        createDriveWithAccessFixture({
          id: mockDriveId,
          name: 'Full Drive',
          slug: 'full-drive',
          drivePrompt: 'Custom prompt',
        })
      );

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(body).toHaveProperty('id');
      expect(body).toHaveProperty('name');
      expect(body).toHaveProperty('slug');
      expect(body).toHaveProperty('ownerId');
      expect(body).toHaveProperty('isTrashed');
      expect(body).toHaveProperty('drivePrompt');
      expect(body).toHaveProperty('isOwned');
      expect(body).toHaveProperty('role');
    });
  });

  describe('error handling', () => {
    it('should return 500 when service throws', async () => {
      vi.mocked(getDriveWithAccess).mockRejectedValue(new Error('Database error'));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch drive');
    });

    it('should log error when service throws', async () => {
      const error = new Error('Service failure');
      vi.mocked(getDriveWithAccess).mockRejectedValue(error);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`);
      await GET(request, createContext(mockDriveId));

      expect(loggers.api.error).toHaveBeenCalledWith('Error fetching drive:', error);
    });
  });
});

// ============================================================================
// PATCH /api/drives/[driveId] - Contract Tests
// ============================================================================

describe('PATCH /api/drives/[driveId]', () => {
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

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Updated' }),
      });
      const response = await PATCH(request, createContext(mockDriveId));

      expect(response.status).toBe(401);
    });

    it('should require CSRF for write operations', async () => {
      vi.mocked(getDriveById).mockResolvedValue(createRawDriveFixture({ id: mockDriveId, name: 'Test' }));
      vi.mocked(getDriveAccess).mockResolvedValue(createAccessFixture({ isOwner: true }));
      vi.mocked(updateDrive).mockResolvedValue(createRawDriveFixture({ id: mockDriveId, name: 'Updated' }));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Updated' }),
      });
      await PATCH(request, createContext(mockDriveId));

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session', 'mcp'], requireCSRF: true }
      );
    });
  });

  describe('authorization', () => {
    it('should return 404 when drive not found', async () => {
      vi.mocked(getDriveById).mockResolvedValue(null);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Updated' }),
      });
      const response = await PATCH(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Drive not found');
    });

    it('should return 403 when user is not owner or admin', async () => {
      vi.mocked(getDriveById).mockResolvedValue(
        createRawDriveFixture({ id: mockDriveId, name: 'Other Drive', ownerId: 'other_user' })
      );
      vi.mocked(getDriveAccess).mockResolvedValue(
        createAccessFixture({ isOwner: false, isAdmin: false, isMember: true, role: 'MEMBER' })
      );

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Updated' }),
      });
      const response = await PATCH(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Only drive owners and admins can update drive settings');
    });

    it('should allow owner to update drive', async () => {
      vi.mocked(getDriveById).mockResolvedValue(createRawDriveFixture({ id: mockDriveId, name: 'Test' }));
      vi.mocked(getDriveAccess).mockResolvedValue(createAccessFixture({ isOwner: true, role: 'OWNER' }));
      vi.mocked(updateDrive).mockResolvedValue(createRawDriveFixture({ id: mockDriveId, name: 'Updated' }));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Updated' }),
      });
      const response = await PATCH(request, createContext(mockDriveId));

      expect(response.status).toBe(200);
    });

    it('should allow admin to update drive', async () => {
      vi.mocked(getDriveById).mockResolvedValue(
        createRawDriveFixture({ id: mockDriveId, name: 'Shared Drive', ownerId: 'other_user' })
      );
      vi.mocked(getDriveAccess).mockResolvedValue(
        createAccessFixture({ isOwner: false, isAdmin: true, isMember: true, role: 'ADMIN' })
      );
      vi.mocked(updateDrive).mockResolvedValue(createRawDriveFixture({ id: mockDriveId, name: 'Updated' }));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Updated' }),
      });
      const response = await PATCH(request, createContext(mockDriveId));

      expect(response.status).toBe(200);
    });
  });

  describe('validation', () => {
    it('should reject drivePrompt exceeding max length', async () => {
      vi.mocked(getDriveById).mockResolvedValue(createRawDriveFixture({ id: mockDriveId, name: 'Test' }));
      vi.mocked(getDriveAccess).mockResolvedValue(createAccessFixture({ isOwner: true }));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'PATCH',
        body: JSON.stringify({ drivePrompt: 'a'.repeat(10001) }),
      });
      const response = await PATCH(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid request body');
    });

    it('should accept valid optional fields', async () => {
      vi.mocked(getDriveById).mockResolvedValue(createRawDriveFixture({ id: mockDriveId, name: 'Test' }));
      vi.mocked(getDriveAccess).mockResolvedValue(createAccessFixture({ isOwner: true }));
      vi.mocked(updateDrive).mockResolvedValue(createRawDriveFixture({ id: mockDriveId, name: 'New Name' }));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: 'New Name',
          aiProvider: 'openai',
          aiModel: 'gpt-4',
          drivePrompt: 'Custom instructions',
        }),
      });
      const response = await PATCH(request, createContext(mockDriveId));

      expect(response.status).toBe(200);
    });
  });

  describe('service integration', () => {
    it('should call updateDrive with name and drivePrompt', async () => {
      vi.mocked(getDriveById).mockResolvedValue(createRawDriveFixture({ id: mockDriveId, name: 'Old' }));
      vi.mocked(getDriveAccess).mockResolvedValue(createAccessFixture({ isOwner: true }));
      vi.mocked(updateDrive).mockResolvedValue(createRawDriveFixture({ id: mockDriveId, name: 'New' }));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'New', drivePrompt: 'Instructions' }),
      });
      await PATCH(request, createContext(mockDriveId));

      expect(updateDrive).toHaveBeenCalledWith(mockDriveId, {
        name: 'New',
        drivePrompt: 'Instructions',
      });
    });
  });

  describe('response contract', () => {
    it('should return updated drive on success', async () => {
      const updatedDrive = createRawDriveFixture({ id: mockDriveId, name: 'Updated Name' });
      vi.mocked(getDriveById).mockResolvedValue(createRawDriveFixture({ id: mockDriveId, name: 'Old' }));
      vi.mocked(getDriveAccess).mockResolvedValue(createAccessFixture({ isOwner: true }));
      vi.mocked(updateDrive).mockResolvedValue(updatedDrive);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Updated Name' }),
      });
      const response = await PATCH(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.name).toBe('Updated Name');
    });
  });

  describe('boundary obligations', () => {
    it('should broadcast drive updated event when name changes', async () => {
      const originalDrive = createRawDriveFixture({ id: mockDriveId, name: 'Old' });
      const updatedDrive = { ...originalDrive, name: 'New', slug: 'new' };
      vi.mocked(getDriveById).mockResolvedValue(originalDrive);
      vi.mocked(getDriveAccess).mockResolvedValue(createAccessFixture({ isOwner: true }));
      vi.mocked(updateDrive).mockResolvedValue(updatedDrive);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'New' }),
      });
      await PATCH(request, createContext(mockDriveId));

      expect(createDriveEventPayload).toHaveBeenCalledWith(
        mockDriveId,
        'updated',
        { name: 'New', slug: 'new' }
      );
      expect(broadcastDriveEvent).toHaveBeenCalled();
    });

    it('should NOT broadcast event when only drivePrompt changes', async () => {
      const drive = createRawDriveFixture({ id: mockDriveId, name: 'Test' });
      vi.mocked(getDriveById).mockResolvedValue(drive);
      vi.mocked(getDriveAccess).mockResolvedValue(createAccessFixture({ isOwner: true }));
      vi.mocked(updateDrive).mockResolvedValue({ ...drive, drivePrompt: 'New prompt' });

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'PATCH',
        body: JSON.stringify({ drivePrompt: 'New prompt' }),
      });
      await PATCH(request, createContext(mockDriveId));

      expect(broadcastDriveEvent).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should return 500 when updateDrive throws', async () => {
      vi.mocked(getDriveById).mockResolvedValue(createRawDriveFixture({ id: mockDriveId, name: 'Test' }));
      vi.mocked(getDriveAccess).mockResolvedValue(createAccessFixture({ isOwner: true }));
      vi.mocked(updateDrive).mockRejectedValue(new Error('Update failed'));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'New' }),
      });
      const response = await PATCH(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to update drive');
    });

    it('should log error when service throws', async () => {
      const error = new Error('Update failure');
      vi.mocked(getDriveById).mockResolvedValue(createRawDriveFixture({ id: mockDriveId, name: 'Test' }));
      vi.mocked(getDriveAccess).mockResolvedValue(createAccessFixture({ isOwner: true }));
      vi.mocked(updateDrive).mockRejectedValue(error);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'New' }),
      });
      await PATCH(request, createContext(mockDriveId));

      expect(loggers.api.error).toHaveBeenCalledWith('Error updating drive:', error);
    });
  });
});

// ============================================================================
// DELETE /api/drives/[driveId] - Contract Tests
// ============================================================================

describe('DELETE /api/drives/[driveId]', () => {
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

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'DELETE',
      });
      const response = await DELETE(request, createContext(mockDriveId));

      expect(response.status).toBe(401);
    });

    it('should require CSRF for delete operations', async () => {
      vi.mocked(getDriveById).mockResolvedValue(createRawDriveFixture({ id: mockDriveId, name: 'Test' }));
      vi.mocked(getDriveAccess).mockResolvedValue(createAccessFixture({ isOwner: true }));
      vi.mocked(trashDrive).mockResolvedValue(null);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'DELETE',
      });
      await DELETE(request, createContext(mockDriveId));

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session', 'mcp'], requireCSRF: true }
      );
    });
  });

  describe('authorization', () => {
    it('should return 404 when drive not found', async () => {
      vi.mocked(getDriveById).mockResolvedValue(null);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'DELETE',
      });
      const response = await DELETE(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Drive not found');
    });

    it('should return 403 when user is not owner or admin', async () => {
      vi.mocked(getDriveById).mockResolvedValue(
        createRawDriveFixture({ id: mockDriveId, name: 'Other Drive', ownerId: 'other_user' })
      );
      vi.mocked(getDriveAccess).mockResolvedValue(
        createAccessFixture({ isOwner: false, isAdmin: false, isMember: true, role: 'MEMBER' })
      );

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'DELETE',
      });
      const response = await DELETE(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Only drive owners and admins can delete drives');
    });

    it('should allow owner to soft-delete drive', async () => {
      vi.mocked(getDriveById).mockResolvedValue(createRawDriveFixture({ id: mockDriveId, name: 'Test' }));
      vi.mocked(getDriveAccess).mockResolvedValue(createAccessFixture({ isOwner: true }));
      vi.mocked(trashDrive).mockResolvedValue(null);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'DELETE',
      });
      const response = await DELETE(request, createContext(mockDriveId));

      expect(response.status).toBe(200);
    });

    it('should allow admin to soft-delete drive', async () => {
      vi.mocked(getDriveById).mockResolvedValue(
        createRawDriveFixture({ id: mockDriveId, name: 'Shared Drive', ownerId: 'other_user' })
      );
      vi.mocked(getDriveAccess).mockResolvedValue(
        createAccessFixture({ isOwner: false, isAdmin: true, isMember: true, role: 'ADMIN' })
      );
      vi.mocked(trashDrive).mockResolvedValue(null);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'DELETE',
      });
      const response = await DELETE(request, createContext(mockDriveId));

      expect(response.status).toBe(200);
    });
  });

  describe('service integration', () => {
    it('should call trashDrive with driveId', async () => {
      vi.mocked(getDriveById).mockResolvedValue(createRawDriveFixture({ id: mockDriveId, name: 'Test' }));
      vi.mocked(getDriveAccess).mockResolvedValue(createAccessFixture({ isOwner: true }));
      vi.mocked(trashDrive).mockResolvedValue(null);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'DELETE',
      });
      await DELETE(request, createContext(mockDriveId));

      expect(trashDrive).toHaveBeenCalledWith(mockDriveId);
    });
  });

  describe('response contract', () => {
    it('should return success=true on successful deletion', async () => {
      vi.mocked(getDriveById).mockResolvedValue(createRawDriveFixture({ id: mockDriveId, name: 'Test' }));
      vi.mocked(getDriveAccess).mockResolvedValue(createAccessFixture({ isOwner: true }));
      vi.mocked(trashDrive).mockResolvedValue(null);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'DELETE',
      });
      const response = await DELETE(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });
  });

  describe('boundary obligations', () => {
    it('should broadcast drive deleted event', async () => {
      const drive = createRawDriveFixture({ id: mockDriveId, name: 'Deleted Drive' });
      vi.mocked(getDriveById).mockResolvedValue(drive);
      vi.mocked(getDriveAccess).mockResolvedValue(createAccessFixture({ isOwner: true }));
      vi.mocked(trashDrive).mockResolvedValue(null);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'DELETE',
      });
      await DELETE(request, createContext(mockDriveId));

      expect(createDriveEventPayload).toHaveBeenCalledWith(
        mockDriveId,
        'deleted',
        { name: 'Deleted Drive', slug: 'deleted-drive' }
      );
      expect(broadcastDriveEvent).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should return 500 when trashDrive throws', async () => {
      vi.mocked(getDriveById).mockResolvedValue(createRawDriveFixture({ id: mockDriveId, name: 'Test' }));
      vi.mocked(getDriveAccess).mockResolvedValue(createAccessFixture({ isOwner: true }));
      vi.mocked(trashDrive).mockRejectedValue(new Error('Delete failed'));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'DELETE',
      });
      const response = await DELETE(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to delete drive');
    });

    it('should log error when service throws', async () => {
      const error = new Error('Delete failure');
      vi.mocked(getDriveById).mockResolvedValue(createRawDriveFixture({ id: mockDriveId, name: 'Test' }));
      vi.mocked(getDriveAccess).mockResolvedValue(createAccessFixture({ isOwner: true }));
      vi.mocked(trashDrive).mockRejectedValue(error);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'DELETE',
      });
      await DELETE(request, createContext(mockDriveId));

      expect(loggers.api.error).toHaveBeenCalledWith('Error deleting drive:', error);
    });
  });
});
