import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET, POST } from '../route';
import type { SessionAuthResult, AuthError } from '@/lib/auth';
import type { DriveWithAccess } from '@pagespace/lib/services/drive-service';

// ============================================================================
// Contract Tests for /api/drives
//
// These tests mock at the SERVICE SEAM level (listAccessibleDrives, createDrive),
// NOT at the ORM/query-builder level. This tests the route handler's contract:
// Request → Response + boundary obligations (broadcast, tracking)
// ============================================================================

// Mock the service seam - this is the ONLY place we mock DB-related logic
vi.mock('@pagespace/lib/services/drive-service', () => ({
    listAccessibleDrives: vi.fn(),
    createDrive: vi.fn(),
}));
const { orgsFlag } = vi.hoisted(() => ({ orgsFlag: { enabled: false } }));
vi.mock('@pagespace/lib/organizations/orgs-enabled', () => ({
  get ORGS_ENABLED() {
    return orgsFlag.enabled;
  },
}));
vi.mock('@pagespace/lib/services/org-drive-service', () => ({
  createOrgDrive: vi.fn(),
}));
vi.mock('@pagespace/lib/services/org-drive-service-deps', () => ({
  orgDriveServiceDeps: { marker: 'production-deps' },
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

vi.mock('@pagespace/lib/monitoring/activity-tracker', () => ({
  trackDriveOperation: vi.fn(),
}));

vi.mock('@pagespace/lib/utils/api-utils', () => ({
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
  isScopedMCPAuth: vi.fn(() => false), // Session/unscoped fixtures by default
  isScopedOAuthAuth: vi.fn(() => false),
  isManageKeysOnly: vi.fn(() => false),
  checkMCPCreateScope: vi.fn(() => null), // Allow all creates by default
}));

vi.mock('@pagespace/lib/permissions/app-permissions', () => ({
  getAppDriveMembership: vi.fn(),
  getScopedDriveMembership: vi.fn(),
  hasAppDriveMembership: vi.fn(),
  hasScopedDriveMembership: vi.fn(),
}));

import { listAccessibleDrives, createDrive } from '@pagespace/lib/services/drive-service'
import { createOrgDrive } from '@pagespace/lib/services/org-drive-service';
import { orgDriveServiceDeps } from '@pagespace/lib/services/org-drive-service-deps';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { trackDriveOperation } from '@pagespace/lib/monitoring/activity-tracker';
import { broadcastDriveEvent, createDriveEventPayload } from '@/lib/websocket';
import { authenticateRequestWithOptions, isAuthError, checkMCPCreateScope } from '@/lib/auth';

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

const createDriveFixture = (overrides: Partial<DriveWithAccess> & { id: string; name: string }): DriveWithAccess => ({
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
        { allow: ['session', 'mcp', 'oauth'], requireCSRF: false }
      );
    });
  });

  describe('service integration', () => {
    it('should call listAccessibleDrives with userId and default options', async () => {
      const request = new Request('https://example.com/api/drives');
      await GET(request);

      expect(listAccessibleDrives).toHaveBeenCalledWith(mockUserId, { includeTrash: false, tokenScopable: false });
    });

    it('should pass includeTrash=true when query param is set', async () => {
      const request = new Request('https://example.com/api/drives?includeTrash=true');
      await GET(request);

      expect(listAccessibleDrives).toHaveBeenCalledWith(mockUserId, { includeTrash: true, tokenScopable: false });
    });

    it('should pass tokenScopable=true when query param is set', async () => {
      const request = new Request('https://example.com/api/drives?tokenScopable=true');
      await GET(request);

      expect(listAccessibleDrives).toHaveBeenCalledWith(mockUserId, { includeTrash: false, tokenScopable: true });
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
      vi.mocked(listAccessibleDrives).mockRejectedValueOnce(new Error('Database connection lost'));

      const request = new Request('https://example.com/api/drives');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch drives');
    });

    it('should log error when service throws', async () => {
      const error = new Error('Service failure');
      vi.mocked(listAccessibleDrives).mockRejectedValueOnce(error);

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
    orgsFlag.enabled = false;
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
        { allow: ['session', 'mcp'], requireCSRF: true }
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
      expect(body.error).toBe('Cannot create a drive with that name.');
    });

    it('should reject "personal" as drive name (case-insensitive)', async () => {
      const request = new Request('https://example.com/api/drives', {
        method: 'POST',
        body: JSON.stringify({ name: 'personal' }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Cannot create a drive with that name.');
    });

    it('should reject "PERSONAL" as drive name (uppercase)', async () => {
      const request = new Request('https://example.com/api/drives', {
        method: 'POST',
        body: JSON.stringify({ name: 'PERSONAL' }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Cannot create a drive with that name.');
    });

    it('should reject "Home" as drive name', async () => {
      const request = new Request('https://example.com/api/drives', {
        method: 'POST',
        body: JSON.stringify({ name: 'Home' }),
      });

      const response = await POST(request);

      expect(response.status).toBe(400);
    });

    it('should reject "home" as drive name (case-insensitive)', async () => {
      const request = new Request('https://example.com/api/drives', {
        method: 'POST',
        body: JSON.stringify({ name: 'home' }),
      });

      const response = await POST(request);

      expect(response.status).toBe(400);
    });

    it('should reject "HOME" as drive name (uppercase)', async () => {
      const request = new Request('https://example.com/api/drives', {
        method: 'POST',
        body: JSON.stringify({ name: 'HOME' }),
      });

      const response = await POST(request);

      expect(response.status).toBe(400);
    });
  });

  describe('create in an org', () => {
    const orgDriveRow = {
      id: 'drive_eng',
      name: 'Engineering',
      slug: 'engineering',
      ownerId: mockUserId,
      kind: 'STANDARD' as const,
      orgId: 'org-northwind',
      orgVisibility: 'OPEN' as const,
      isTrashed: false,
      trashedAt: null,
      drivePrompt: null,
      createdAt: new Date('2026-09-17T00:00:00.000Z'),
      updatedAt: new Date('2026-09-17T00:00:00.000Z'),
      publishSubdomain: 'engineering',
      homePageId: null,
      publishDefaultOgImageUrl: null,
      notFoundPageId: null,
      publishFaviconUrl: null,
    };

    const post = (body: unknown) =>
      POST(new Request('https://example.com/api/drives', { method: 'POST', body: JSON.stringify(body) }));

    beforeEach(() => {
      orgsFlag.enabled = true;
    });

    it('DRV-3 (partial) a drive created with an orgId goes through createOrgDrive with the production deps and answers 201 as its owner', async () => {
      vi.mocked(createOrgDrive).mockResolvedValue({ ok: true, drive: orgDriveRow });

      const response = await post({ name: 'Engineering', orgId: 'org-northwind' });

      expect(response.status).toBe(201);
      expect(createOrgDrive).toHaveBeenCalledWith(
        mockUserId,
        { name: 'Engineering', orgId: 'org-northwind', orgVisibility: undefined },
        orgDriveServiceDeps
      );
      expect(createDrive).not.toHaveBeenCalled();
      expect(await response.json()).toMatchObject({ id: 'drive_eng', orgId: 'org-northwind', isOwned: true, role: 'OWNER' });
    });

    it('DRV-3 (partial) a refused org create returns the verdict and creates nothing', async () => {
      vi.mocked(createOrgDrive).mockResolvedValue({
        ok: false,
        code: 'NOT_ORG_MEMBER',
        status: 403,
        message: 'You must be a member of the organization to create a drive in it.',
      });

      const response = await post({ name: 'Engineering', orgId: 'org-northwind' });

      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe('NOT_ORG_MEMBER');
      expect(createDrive).not.toHaveBeenCalled();
    });

    it('DRV-4 (partial) a chosen visibility is passed through and an unknown one is a 400', async () => {
      vi.mocked(createOrgDrive).mockResolvedValue({ ok: true, drive: { ...orgDriveRow, orgVisibility: 'PRIVATE' } });

      await post({ name: 'Finance', orgId: 'org-northwind', orgVisibility: 'PRIVATE' });
      expect(createOrgDrive).toHaveBeenCalledWith(
        mockUserId,
        { name: 'Finance', orgId: 'org-northwind', orgVisibility: 'PRIVATE' },
        orgDriveServiceDeps
      );

      expect((await post({ name: 'Finance', orgId: 'org-northwind', orgVisibility: 'SECRET' })).status).toBe(400);
    });

    it('DRV-3 (partial) a bearer-token request cannot create a drive in an org until CLI and MCP parity in Wave G', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
        ...mockWebAuth(mockUserId),
        tokenType: 'mcp',
      } as unknown as SessionAuthResult);

      const response = await post({ name: 'Engineering', orgId: 'org-northwind' });

      expect(response.status).toBe(403);
      expect((await response.json()).error).toBe(
        'Creating a drive in an organization requires a signed-in session; tokens cannot do this yet.'
      );
      expect(createOrgDrive).not.toHaveBeenCalled();
      expect(createDrive).not.toHaveBeenCalled();
    });

    it('an orgId answers 404 and creates nothing while ORGS_ENABLED is false', async () => {
      orgsFlag.enabled = false;

      const response = await post({ name: 'Engineering', orgId: 'org-northwind' });

      expect(response.status).toBe(404);
      expect(createOrgDrive).not.toHaveBeenCalled();
      expect(createDrive).not.toHaveBeenCalled();
    });

    it('a drive created without an orgId stays personal', async () => {
      vi.mocked(createDrive).mockResolvedValue(createDriveFixture({ id: 'drive_personal', name: 'Notes' }));

      await post({ name: 'Notes' });

      expect(createDrive).toHaveBeenCalledWith(mockUserId, { name: 'Notes' });
      expect(createOrgDrive).not.toHaveBeenCalled();
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
      expect(broadcastDriveEvent).toHaveBeenCalledWith(
        expect.objectContaining({ driveId: 'drive_broadcast', event: 'created' }),
        ['user_123']
      );
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
      vi.mocked(createDrive).mockRejectedValueOnce(new Error('Insert failed'));

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
      vi.mocked(createDrive).mockRejectedValueOnce(error);

      const request = new Request('https://example.com/api/drives', {
        method: 'POST',
        body: JSON.stringify({ name: 'Error Drive' }),
      });

      await POST(request);

      expect(loggers.api.error).toHaveBeenCalledWith('Error creating drive:', error);
    });
  });

  describe('MCP scope check', () => {
    it('should return scope error when scoped MCP token tries to create', async () => {
      const scopeErrorResponse = NextResponse.json(
        { error: 'Scoped tokens cannot create drives' },
        { status: 403 }
      );
      vi.mocked(checkMCPCreateScope).mockReturnValue(scopeErrorResponse);

      const request = new Request('https://example.com/api/drives', {
        method: 'POST',
        body: JSON.stringify({ name: 'MCP Drive' }),
      });

      const response = await POST(request);

      expect(response.status).toBe(403);
      expect(createDrive).not.toHaveBeenCalled();
    });
  });
});
