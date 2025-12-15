import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET, POST } from '../route';
import type { WebAuthResult, AuthError } from '@/lib/auth';
import type { DriveWithAccess } from '@pagespace/lib/server';

// ============================================================================
// Contract Tests for /api/drives
//
// These tests mock at the SERVICE SEAM level (listAccessibleDrives, createDrive),
// NOT at the ORM/query-builder level. This tests the route handler's contract:
// Request → Response + boundary obligations (broadcast, tracking)
// ============================================================================

// Mock the service seam - this is the ONLY place we mock DB-related logic
vi.mock('@pagespace/lib/server', () => ({
  listAccessibleDrives: vi.fn(),
  createDrive: vi.fn(),
  loggers: {
    api: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

vi.mock('@pagespace/lib/activity-tracker', () => ({
  trackDriveOperation: vi.fn(),
}));

vi.mock('@pagespace/lib/api-utils', () => ({
  jsonResponse: vi.fn((data, options = {}) =>
    NextResponse.json(data, { status: options.status || 200 })
  ),
}));

vi.mock('@/lib/websocket', () => ({
  broadcastDriveEvent: vi.fn().mockResolvedValue(undefined),
  createDriveEventPayload: vi.fn((driveId, event, data) => ({ driveId, event, data })),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

import { listAccessibleDrives, createDrive, loggers } from '@pagespace/lib/server';
import { trackDriveOperation } from '@pagespace/lib/activity-tracker';
import { broadcastDriveEvent, createDriveEventPayload } from '@/lib/websocket';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

// ============================================================================
// Test Helpers
// ============================================================================

const mockWebAuth = (userId: string, tokenVersion = 0): WebAuthResult => ({
  userId,
  tokenVersion,
  tokenType: 'jwt',
  source: 'cookie',
  role: 'user',
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const createDriveFixture = (overrides: Partial<DriveWithAccess> & { id: string; name: string }): DriveWithAccess => ({
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
});

// ============================================================================
// GET /api/drives - Contract Tests
// ============================================================================

describe('GET /api/drives', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(listAccessibleDrives).mockResolvedValue([]);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/drives');
      const response = await GET(request);

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe('Unauthorized');
    });

    it('should call authenticateRequestWithOptions with correct auth options', async () => {
      const request = new Request('https://example.com/api/drives');
      await GET(request);

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['jwt', 'mcp'], requireCSRF: false }
      );
    });
  });

  describe('service integration', () => {
    it('should call listAccessibleDrives with userId and default options', async () => {
      const request = new Request('https://example.com/api/drives');
      await GET(request);

      expect(listAccessibleDrives).toHaveBeenCalledWith(mockUserId, { includeTrash: false });
    });

    it('should pass includeTrash=true when query param is set', async () => {
      const request = new Request('https://example.com/api/drives?includeTrash=true');
      await GET(request);

      expect(listAccessibleDrives).toHaveBeenCalledWith(mockUserId, { includeTrash: true });
    });
  });

  describe('response contract', () => {
    it('should return empty array when user has no drives', async () => {
      vi.mocked(listAccessibleDrives).mockResolvedValue([]);

      const request = new Request('https://example.com/api/drives');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual([]);
    });

    it('should return drives array with required fields', async () => {
      const drives = [
        createDriveFixture({ id: 'drive_1', name: 'My Drive', isOwned: true, role: 'OWNER' }),
        createDriveFixture({ id: 'drive_2', name: 'Shared Drive', isOwned: false, role: 'ADMIN', ownerId: 'other_user' }),
      ];
      vi.mocked(listAccessibleDrives).mockResolvedValue(drives);

      const request = new Request('https://example.com/api/drives');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toHaveLength(2);

      // Verify owned drive contract
      expect(body[0]).toMatchObject({
        id: 'drive_1',
        name: 'My Drive',
        slug: 'my-drive',
        isOwned: true,
        role: 'OWNER',
      });

      // Verify shared drive contract
      expect(body[1]).toMatchObject({
        id: 'drive_2',
        name: 'Shared Drive',
        isOwned: false,
        role: 'ADMIN',
      });
    });

    it('should include all drive fields in response', async () => {
      const drive = createDriveFixture({
        id: 'drive_full',
        name: 'Full Drive',
        slug: 'full-drive',
        drivePrompt: 'Custom prompt',
        isTrashed: false,
      });
      vi.mocked(listAccessibleDrives).mockResolvedValue([drive]);

      const request = new Request('https://example.com/api/drives');
      const response = await GET(request);
      const body = await response.json();

      expect(body[0]).toHaveProperty('id');
      expect(body[0]).toHaveProperty('name');
      expect(body[0]).toHaveProperty('slug');
      expect(body[0]).toHaveProperty('ownerId');
      expect(body[0]).toHaveProperty('isTrashed');
      expect(body[0]).toHaveProperty('drivePrompt');
      expect(body[0]).toHaveProperty('isOwned');
      expect(body[0]).toHaveProperty('role');
    });
  });

  describe('error handling', () => {
    it('should return 500 when service throws', async () => {
      vi.mocked(listAccessibleDrives).mockRejectedValue(new Error('Database connection lost'));

      const request = new Request('https://example.com/api/drives');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch drives');
    });

    it('should log error when service throws', async () => {
      const error = new Error('Service failure');
      vi.mocked(listAccessibleDrives).mockRejectedValue(error);

      const request = new Request('https://example.com/api/drives');
      await GET(request);

      expect(loggers.api.error).toHaveBeenCalledWith('Error fetching drives:', error);
    });
  });
});

// ============================================================================
// POST /api/drives - Contract Tests
// ============================================================================

describe('POST /api/drives', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/drives', {
        method: 'POST',
        body: JSON.stringify({ name: 'New Drive' }),
      });
      const response = await POST(request);

      expect(response.status).toBe(401);
    });

    it('should require CSRF for write operations', async () => {
      const request = new Request('https://example.com/api/drives', {
        method: 'POST',
        body: JSON.stringify({ name: 'New Drive' }),
      });
      await POST(request);

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['jwt', 'mcp'], requireCSRF: true }
      );
    });
  });

  describe('validation', () => {
    it('should reject request without name', async () => {
      const request = new Request('https://example.com/api/drives', {
        method: 'POST',
        body: JSON.stringify({}),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Missing name');
    });

    it('should reject empty name', async () => {
      const request = new Request('https://example.com/api/drives', {
        method: 'POST',
        body: JSON.stringify({ name: '' }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Missing name');
    });

    it('should reject "Personal" as drive name (exact match)', async () => {
      const request = new Request('https://example.com/api/drives', {
        method: 'POST',
        body: JSON.stringify({ name: 'Personal' }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Cannot create a drive named "Personal".');
    });

    it('should reject "personal" as drive name (case-insensitive)', async () => {
      const request = new Request('https://example.com/api/drives', {
        method: 'POST',
        body: JSON.stringify({ name: 'personal' }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Cannot create a drive named "Personal".');
    });

    it('should reject "PERSONAL" as drive name (uppercase)', async () => {
      const request = new Request('https://example.com/api/drives', {
        method: 'POST',
        body: JSON.stringify({ name: 'PERSONAL' }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Cannot create a drive named "Personal".');
    });
  });

  describe('service integration', () => {
    it('should call createDrive with userId and name', async () => {
      const newDrive = createDriveFixture({ id: 'drive_new', name: 'New Project' });
      vi.mocked(createDrive).mockResolvedValue(newDrive);

      const request = new Request('https://example.com/api/drives', {
        method: 'POST',
        body: JSON.stringify({ name: 'New Project' }),
      });
      await POST(request);

      expect(createDrive).toHaveBeenCalledWith(mockUserId, { name: 'New Project' });
    });
  });

  describe('response contract', () => {
    it('should return 201 on successful creation', async () => {
      const newDrive = createDriveFixture({ id: 'drive_new', name: 'New Drive' });
      vi.mocked(createDrive).mockResolvedValue(newDrive);

      const request = new Request('https://example.com/api/drives', {
        method: 'POST',
        body: JSON.stringify({ name: 'New Drive' }),
      });

      const response = await POST(request);
      expect(response.status).toBe(201);
    });

    it('should return created drive with required fields', async () => {
      const newDrive = createDriveFixture({
        id: 'drive_created',
        name: 'Created Drive',
        slug: 'created-drive',
        isOwned: true,
        role: 'OWNER',
      });
      vi.mocked(createDrive).mockResolvedValue(newDrive);

      const request = new Request('https://example.com/api/drives', {
        method: 'POST',
        body: JSON.stringify({ name: 'Created Drive' }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(body).toMatchObject({
        id: 'drive_created',
        name: 'Created Drive',
        slug: 'created-drive',
        isOwned: true,
        role: 'OWNER',
      });
    });
  });

  describe('boundary obligations', () => {
    it('should broadcast drive created event', async () => {
      const newDrive = createDriveFixture({
        id: 'drive_broadcast',
        name: 'Broadcast Drive',
        slug: 'broadcast-drive',
      });
      vi.mocked(createDrive).mockResolvedValue(newDrive);

      const request = new Request('https://example.com/api/drives', {
        method: 'POST',
        body: JSON.stringify({ name: 'Broadcast Drive' }),
      });

      await POST(request);

      expect(createDriveEventPayload).toHaveBeenCalledWith(
        'drive_broadcast',
        'created',
        { name: 'Broadcast Drive', slug: 'broadcast-drive' }
      );
      expect(broadcastDriveEvent).toHaveBeenCalled();
    });

    it('should track drive creation for analytics', async () => {
      const newDrive = createDriveFixture({
        id: 'drive_tracked',
        name: 'Tracked Drive',
        slug: 'tracked-drive',
      });
      vi.mocked(createDrive).mockResolvedValue(newDrive);

      const request = new Request('https://example.com/api/drives', {
        method: 'POST',
        body: JSON.stringify({ name: 'Tracked Drive' }),
      });

      await POST(request);

      expect(trackDriveOperation).toHaveBeenCalledWith(
        mockUserId,
        'create',
        'drive_tracked',
        { name: 'Tracked Drive', slug: 'tracked-drive' }
      );
    });
  });

  describe('error handling', () => {
    it('should return 500 when service throws', async () => {
      vi.mocked(createDrive).mockRejectedValue(new Error('Insert failed'));

      const request = new Request('https://example.com/api/drives', {
        method: 'POST',
        body: JSON.stringify({ name: 'Failing Drive' }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to create drive');
    });

    it('should log error when service throws', async () => {
      const error = new Error('Creation failed');
      vi.mocked(createDrive).mockRejectedValue(error);

      const request = new Request('https://example.com/api/drives', {
        method: 'POST',
        body: JSON.stringify({ name: 'Error Drive' }),
      });

      await POST(request);

      expect(loggers.api.error).toHaveBeenCalledWith('Error creating drive:', error);
    });
  });
});
