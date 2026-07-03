import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET, PATCH, DELETE } from '../route';
import type { SessionAuthResult, AuthError } from '@/lib/auth';
import type { DriveWithAccess, DriveAccessInfo } from '@pagespace/lib/services/drive-service';

// ============================================================================
// Contract Tests for /api/drives/[driveId]
//
// These tests mock at the SERVICE SEAM level (getDriveById, getDriveAccess, etc.),
// NOT at the ORM/query-builder level. This tests the route handler's contract:
// Request → Response + boundary obligations (broadcast events)
// ============================================================================

// Mock the service seam - this is the ONLY place we mock DB-related logic
vi.mock('@pagespace/lib/services/drive-service', () => ({
    getDriveById: vi.fn(),
    getDriveAccess: vi.fn(),
    getDriveWithAccess: vi.fn(),
    updateDrive: vi.fn(),
    trashDrive: vi.fn(),
    isValidDriveHomePage: vi.fn(),
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

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
  // MCP scope check - returns null (allowed) by default for session auth tests
  checkMCPDriveScope: vi.fn().mockReturnValue(null),
  isMCPAuthResult: vi.fn().mockReturnValue(false),
  isScopedMCPAuth: vi.fn(() => false), // Session/unscoped fixtures by default
  // Session auth falls through to user-level authority; derive it from the
  // test's getDriveAccess fixture so existing fixtures keep driving 403/200.
  isPrincipalDriveOwnerOrAdmin: vi.fn(async (auth: { userId: string }, driveId: string) => {
    const { getDriveAccess } = await import('@pagespace/lib/services/drive-service');
    const access = await getDriveAccess(driveId, auth.userId);
    return Boolean(access && (access.isOwner || access.isAdmin));
  }),
}));

vi.mock('@pagespace/lib/permissions/app-permissions', () => ({
  getAppDriveMembership: vi.fn(),
  getAppDriveAccessLevel: vi.fn(),
}));

vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn().mockResolvedValue({ actorEmail: 'test@example.com', actorDisplayName: 'Test User' }),
  logDriveActivity: vi.fn(),
}));

vi.mock('@pagespace/lib/services/drive-member-service', () => ({
  getDriveRecipientUserIds: vi.fn().mockResolvedValue(['user-123', 'user-456']),
}));

import { getDriveById, getDriveAccess, getDriveWithAccess, updateDrive, trashDrive, isValidDriveHomePage } from '@pagespace/lib/services/drive-service'
import { loggers } from '@pagespace/lib/logging/logger-config';
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
const createRawDriveFixture = (overrides: { id: string; name: string; ownerId?: string; kind?: 'STANDARD' | 'HOME'; homePageId?: string | null }) => ({
  id: overrides.id,
  name: overrides.name,
  slug: overrides.name.toLowerCase().replace(/\s+/g, '-'),
  ownerId: overrides.ownerId ?? 'user_123',
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  isTrashed: false,
  trashedAt: null,
  drivePrompt: null,
  kind: (overrides.kind ?? 'STANDARD') as 'STANDARD' | 'HOME',
  publishSubdomain: null,
  homePageId: overrides.homePageId ?? null,
  publishDefaultOgImageUrl: null,
});

// Drive with access info fixture
const createDriveWithAccessFixture = (
  overrides: Partial<DriveWithAccess> & { id: string; name: string; isMember?: boolean }
): DriveWithAccess & { isMember: boolean } => ({
  id: overrides.id,
  name: overrides.name,
  slug: overrides.slug ?? overrides.name.toLowerCase().replace(/\s+/g, '-'),
  ownerId: overrides.ownerId ?? 'user_123',
  kind: overrides.kind ?? 'STANDARD',
  createdAt: overrides.createdAt ?? new Date('2024-01-01'),
  updatedAt: overrides.updatedAt ?? new Date('2024-01-01'),
  isTrashed: overrides.isTrashed ?? false,
  trashedAt: overrides.trashedAt ?? null,
  drivePrompt: overrides.drivePrompt ?? null,
  isOwned: overrides.isOwned ?? true,
  role: overrides.role ?? 'OWNER',
  lastAccessedAt: overrides.lastAccessedAt ?? null,
  homePageId: overrides.homePageId ?? null,
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
        { allow: ['session', 'mcp', 'oauth'], requireCSRF: false }
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
      vi.mocked(getDriveWithAccess).mockRejectedValueOnce(new Error('Database error'));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch drive');
    });

    it('should log error when service throws', async () => {
      const error = new Error('Service failure');
      vi.mocked(getDriveWithAccess).mockRejectedValueOnce(error);

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

  describe('publishDefaultOgImageUrl', () => {
    const ownerFixtures = () => {
      vi.mocked(getDriveById).mockResolvedValue(createRawDriveFixture({ id: mockDriveId, name: 'Test' }));
      vi.mocked(getDriveAccess).mockResolvedValue(createAccessFixture({ isOwner: true, role: 'OWNER' }));
    };

    it('persists a valid default OG image URL', async () => {
      ownerFixtures();
      vi.mocked(updateDrive).mockResolvedValue(createRawDriveFixture({ id: mockDriveId, name: 'Test' }));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'PATCH',
        body: JSON.stringify({ publishDefaultOgImageUrl: 'https://img.example/og.png' }),
      });
      const response = await PATCH(request, createContext(mockDriveId));

      expect(response.status).toBe(200);
      expect(updateDrive).toHaveBeenCalledWith(
        mockDriveId,
        expect.objectContaining({ publishDefaultOgImageUrl: 'https://img.example/og.png' })
      );
    });

    it('normalizes an empty string to null (clear)', async () => {
      ownerFixtures();
      vi.mocked(updateDrive).mockResolvedValue(createRawDriveFixture({ id: mockDriveId, name: 'Test' }));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'PATCH',
        body: JSON.stringify({ publishDefaultOgImageUrl: '' }),
      });
      const response = await PATCH(request, createContext(mockDriveId));

      expect(response.status).toBe(200);
      expect(updateDrive).toHaveBeenCalledWith(
        mockDriveId,
        expect.objectContaining({ publishDefaultOgImageUrl: null })
      );
    });

    it('rejects a non-URL default OG image without touching the service', async () => {
      ownerFixtures();

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'PATCH',
        body: JSON.stringify({ publishDefaultOgImageUrl: 'not-a-url' }),
      });
      const response = await PATCH(request, createContext(mockDriveId));

      expect(response.status).toBe(400);
      expect(updateDrive).not.toHaveBeenCalled();
    });
  });

  describe('publishSubdomain', () => {
    const ownerFixtures = () => {
      vi.mocked(getDriveById).mockResolvedValue(createRawDriveFixture({ id: mockDriveId, name: 'Test' }));
      vi.mocked(getDriveAccess).mockResolvedValue(createAccessFixture({ isOwner: true, role: 'OWNER' }));
    };

    it('rejects publishSubdomain with a clear 400 instead of silently dropping it', async () => {
      ownerFixtures();

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'PATCH',
        body: JSON.stringify({ publishSubdomain: 'my-new-subdomain' }),
      });
      const response = await PATCH(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe(
        'publishSubdomain cannot be changed via this endpoint. Use PATCH /api/drives/[driveId]/subdomain instead.'
      );
      expect(updateDrive).not.toHaveBeenCalled();
    });

    it('rejects a mixed body containing publishSubdomain alongside a valid field', async () => {
      ownerFixtures();

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'New Name', publishSubdomain: 'my-new-subdomain' }),
      });
      const response = await PATCH(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe(
        'publishSubdomain cannot be changed via this endpoint. Use PATCH /api/drives/[driveId]/subdomain instead.'
      );
      expect(updateDrive).not.toHaveBeenCalled();
    });
  });

  describe('homePageId', () => {
    const ownerFixtures = () => {
      vi.mocked(getDriveById).mockResolvedValue(createRawDriveFixture({ id: mockDriveId, name: 'Test' }));
      vi.mocked(getDriveAccess).mockResolvedValue(createAccessFixture({ isOwner: true, role: 'OWNER' }));
    };

    it('should persist a valid homePageId and broadcast', async () => {
      ownerFixtures();
      vi.mocked(isValidDriveHomePage).mockResolvedValue(true);
      vi.mocked(updateDrive).mockResolvedValue(
        createRawDriveFixture({ id: mockDriveId, name: 'Test', homePageId: 'page-1' })
      );

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'PATCH',
        body: JSON.stringify({ homePageId: 'page-1' }),
      });
      const response = await PATCH(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(isValidDriveHomePage).toHaveBeenCalledWith(mockDriveId, 'page-1');
      expect(updateDrive).toHaveBeenCalledWith(mockDriveId, expect.objectContaining({ homePageId: 'page-1' }));
      expect(broadcastDriveEvent).toHaveBeenCalledTimes(1);
      expect(body.homePageId).toBe('page-1');
    });

    it('should return 400 and not update when validation rejects the page', async () => {
      ownerFixtures();
      vi.mocked(isValidDriveHomePage).mockResolvedValue(false);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'PATCH',
        body: JSON.stringify({ homePageId: 'page-other-drive' }),
      });
      const response = await PATCH(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Home page must be a non-trashed page in this drive');
      expect(updateDrive).not.toHaveBeenCalled();
    });

    it('should clear with null without validating, and still broadcast', async () => {
      ownerFixtures();
      vi.mocked(updateDrive).mockResolvedValue(
        createRawDriveFixture({ id: mockDriveId, name: 'Test', homePageId: null })
      );

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'PATCH',
        body: JSON.stringify({ homePageId: null }),
      });
      const response = await PATCH(request, createContext(mockDriveId));

      expect(response.status).toBe(200);
      expect(isValidDriveHomePage).not.toHaveBeenCalled();
      expect(updateDrive).toHaveBeenCalledWith(mockDriveId, expect.objectContaining({ homePageId: null }));
      expect(broadcastDriveEvent).toHaveBeenCalledTimes(1);
    });

    it('should return 403 for non-owner/admin without validating or updating', async () => {
      vi.mocked(getDriveById).mockResolvedValue(
        createRawDriveFixture({ id: mockDriveId, name: 'Other Drive', ownerId: 'other_user' })
      );
      vi.mocked(getDriveAccess).mockResolvedValue(
        createAccessFixture({ isOwner: false, isAdmin: false, isMember: true, role: 'MEMBER' })
      );

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'PATCH',
        body: JSON.stringify({ homePageId: 'page-1' }),
      });
      const response = await PATCH(request, createContext(mockDriveId));

      expect(response.status).toBe(403);
      expect(isValidDriveHomePage).not.toHaveBeenCalled();
      expect(updateDrive).not.toHaveBeenCalled();
    });

    it.each([
      ['non-string', 123],
      ['empty string', ''],
    ])('should reject %s homePageId via zod without touching services', async (_label, value) => {
      ownerFixtures();

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'PATCH',
        body: JSON.stringify({ homePageId: value }),
      });
      const response = await PATCH(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid request body');
      expect(isValidDriveHomePage).not.toHaveBeenCalled();
      expect(updateDrive).not.toHaveBeenCalled();
    });

    it('should leave homePageId untouched when the field is absent (regression)', async () => {
      ownerFixtures();
      vi.mocked(updateDrive).mockResolvedValue(createRawDriveFixture({ id: mockDriveId, name: 'X' }));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'X' }),
      });
      const response = await PATCH(request, createContext(mockDriveId));

      expect(response.status).toBe(200);
      expect(isValidDriveHomePage).not.toHaveBeenCalled();
      const updateInput = vi.mocked(updateDrive).mock.calls[0][1];
      expect(updateInput.homePageId).toBeUndefined();
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
      expect(broadcastDriveEvent).toHaveBeenCalledWith(
        { driveId: mockDriveId, event: 'updated', data: { name: 'New', slug: 'new' } },
        ['user-123', 'user-456']
      );
    });

    it('should broadcast drive updated event when only drivePrompt changes', async () => {
      const drive = createRawDriveFixture({ id: mockDriveId, name: 'Test' });
      const updatedDrive = { ...drive, drivePrompt: 'New prompt' };
      vi.mocked(getDriveById).mockResolvedValue(drive);
      vi.mocked(getDriveAccess).mockResolvedValue(createAccessFixture({ isOwner: true }));
      vi.mocked(updateDrive).mockResolvedValue(updatedDrive);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'PATCH',
        body: JSON.stringify({ drivePrompt: 'New prompt' }),
      });
      await PATCH(request, createContext(mockDriveId));

      expect(createDriveEventPayload).toHaveBeenCalledWith(
        mockDriveId,
        'updated',
        { name: 'Test', slug: 'test' }
      );
      expect(broadcastDriveEvent).toHaveBeenCalledWith(
        { driveId: mockDriveId, event: 'updated', data: { name: 'Test', slug: 'test' } },
        ['user-123', 'user-456']
      );
    });
  });

  describe('error handling', () => {
    it('should return 500 when updateDrive throws', async () => {
      vi.mocked(getDriveById).mockResolvedValue(createRawDriveFixture({ id: mockDriveId, name: 'Test' }));
      vi.mocked(getDriveAccess).mockResolvedValue(createAccessFixture({ isOwner: true }));
      vi.mocked(updateDrive).mockRejectedValueOnce(new Error('Update failed'));

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
      vi.mocked(updateDrive).mockRejectedValueOnce(error);

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
      expect(broadcastDriveEvent).toHaveBeenCalledWith(
        { driveId: mockDriveId, event: 'deleted', data: { name: 'Deleted Drive', slug: 'deleted-drive' } },
        ['user-123', 'user-456']
      );
    });
  });

  describe('error handling', () => {
    it('should return 500 when trashDrive throws', async () => {
      vi.mocked(getDriveById).mockResolvedValue(createRawDriveFixture({ id: mockDriveId, name: 'Test' }));
      vi.mocked(getDriveAccess).mockResolvedValue(createAccessFixture({ isOwner: true }));
      vi.mocked(trashDrive).mockRejectedValueOnce(new Error('Delete failed'));

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
      vi.mocked(trashDrive).mockRejectedValueOnce(error);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'DELETE',
      });
      await DELETE(request, createContext(mockDriveId));

      expect(loggers.api.error).toHaveBeenCalledWith('Error deleting drive:', error);
    });
  });
});

// ============================================================================
// Home Drive Guards
// ============================================================================

describe('PATCH /api/drives/[driveId] — Home drive guards', () => {
  const mockUserId = 'user_123';
  const mockDriveId = 'drive_home';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  it('returns 403 when trying to rename a Home drive', async () => {
    vi.mocked(getDriveById).mockResolvedValue(
      createRawDriveFixture({ id: mockDriveId, name: 'Home', ownerId: mockUserId, kind: 'HOME' })
    );
    vi.mocked(getDriveAccess).mockResolvedValue(createAccessFixture({ isOwner: true, role: 'OWNER' }));

    const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Renamed' }),
    });
    const response = await PATCH(request, createContext(mockDriveId));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toBe('Your Home drive cannot be renamed.');
    expect(updateDrive).not.toHaveBeenCalled();
  });

  it('returns 200 when updating only drivePrompt on a Home drive', async () => {
    vi.mocked(getDriveById).mockResolvedValue(
      createRawDriveFixture({ id: mockDriveId, name: 'Home', ownerId: mockUserId, kind: 'HOME' })
    );
    vi.mocked(getDriveAccess).mockResolvedValue(createAccessFixture({ isOwner: true, role: 'OWNER' }));
    vi.mocked(updateDrive).mockResolvedValue(
      createRawDriveFixture({ id: mockDriveId, name: 'Home', kind: 'HOME' })
    );

    const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
      method: 'PATCH',
      body: JSON.stringify({ drivePrompt: 'New context' }),
    });
    const response = await PATCH(request, createContext(mockDriveId));

    expect(response.status).toBe(200);
    expect(updateDrive).toHaveBeenCalledWith(mockDriveId, { name: undefined, drivePrompt: 'New context' });
  });

  it('returns 400 when trying to rename any drive to a reserved name', async () => {
    for (const reservedName of ['Home', 'home', 'Personal', 'personal']) {
      vi.clearAllMocks();
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
      vi.mocked(isAuthError).mockReturnValue(false);
      vi.mocked(getDriveById).mockResolvedValue(
        createRawDriveFixture({ id: mockDriveId, name: 'My Work', ownerId: mockUserId })
      );
      vi.mocked(getDriveAccess).mockResolvedValue(createAccessFixture({ isOwner: true, role: 'OWNER' }));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: reservedName }),
      });
      const response = await PATCH(request, createContext(mockDriveId));
      expect(response.status).toBe(400);
      expect(updateDrive).not.toHaveBeenCalled();
    }
  });
});

describe('DELETE /api/drives/[driveId] — Home drive guard', () => {
  const mockUserId = 'user_123';
  const mockDriveId = 'drive_home';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  it('returns 403 when trying to trash a Home drive', async () => {
    vi.mocked(getDriveById).mockResolvedValue(
      createRawDriveFixture({ id: mockDriveId, name: 'Home', ownerId: mockUserId, kind: 'HOME' })
    );
    vi.mocked(getDriveAccess).mockResolvedValue(createAccessFixture({ isOwner: true, role: 'OWNER' }));

    const request = new Request(`https://example.com/api/drives/${mockDriveId}`, {
      method: 'DELETE',
    });
    const response = await DELETE(request, createContext(mockDriveId));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toBe('Your Home drive cannot be moved to trash or deleted.');
    expect(trashDrive).not.toHaveBeenCalled();
  });
});
