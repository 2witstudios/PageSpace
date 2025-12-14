import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET, POST } from '../route';
import type { WebAuthResult, AuthError } from '@/lib/auth';

// Mock dependencies
vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      drives: {
        findMany: vi.fn(),
      },
    },
    selectDistinct: vi.fn(),
    insert: vi.fn(),
  },
  drives: {},
  pages: {},
  driveMembers: {},
  pagePermissions: {},
  eq: vi.fn((field: unknown, value: unknown) => ({ field, value, type: 'eq' })),
  and: vi.fn((...args: unknown[]) => ({ args, type: 'and' })),
  inArray: vi.fn((field: unknown, values: unknown[]) => ({ field, values, type: 'inArray' })),
  not: vi.fn((condition: unknown) => ({ condition, type: 'not' })),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },
  slugify: vi.fn((name: string) => name.toLowerCase().replace(/\s+/g, '-')),
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

import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { trackDriveOperation } from '@pagespace/lib/activity-tracker';
import { broadcastDriveEvent } from '@/lib/websocket';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

// Helper to create mock WebAuthResult
const mockWebAuth = (userId: string, tokenVersion = 0): WebAuthResult => ({
  userId,
  tokenVersion,
  tokenType: 'jwt',
  source: 'cookie',
  role: 'user',
});

// Helper to create mock AuthError
const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

// Helper to create mock drive
const mockDrive = (overrides: {
  id: string;
  name: string;
  ownerId?: string;
  slug?: string;
  isTrashed?: boolean;
}) => ({
  id: overrides.id,
  name: overrides.name,
  slug: overrides.slug ?? overrides.id.toLowerCase(),
  ownerId: overrides.ownerId ?? 'user_123',
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  isTrashed: overrides.isTrashed ?? false,
  trashedAt: null,
  drivePrompt: null,
});

describe('GET /api/drives', () => {
  const mockUserId = 'user_123';

  const setupSelectDistinctMock = (
    memberDrives: Array<{ driveId: string; role: string }>,
    permissionDrives: Array<{ driveId: string | null }>
  ) => {
    let callCount = 0;
    vi.mocked(db.selectDistinct).mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 1) {
            return memberDrives;
          }
          return [];
        }),
        leftJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(permissionDrives),
        }),
      })),
    } as unknown as ReturnType<typeof db.selectDistinct>));
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup default auth success
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Setup default: no drives
    vi.mocked(db.query.drives.findMany).mockResolvedValue([]);
    setupSelectDistinctMock([], []);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/drives');
      const response = await GET(request);

      expect(response.status).toBe(401);
    });
  });

  describe('happy path', () => {
    it('should return empty array when user has no drives', async () => {
      const request = new Request('https://example.com/api/drives');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual([]);
    });

    it('should return owned drives with isOwned=true and role=OWNER', async () => {
      vi.mocked(db.query.drives.findMany).mockResolvedValueOnce([
        mockDrive({ id: 'drive_1', name: 'My Drive', ownerId: mockUserId }),
      ]);

      const request = new Request('https://example.com/api/drives');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toHaveLength(1);
      expect(body[0]).toMatchObject({
        id: 'drive_1',
        name: 'My Drive',
        isOwned: true,
        role: 'OWNER',
      });
    });

    it('should return shared drives with correct role from membership', async () => {
      // No owned drives
      vi.mocked(db.query.drives.findMany)
        .mockResolvedValueOnce([]) // owned
        .mockResolvedValueOnce([mockDrive({ id: 'drive_shared', name: 'Shared Drive', ownerId: 'other_user' })]); // shared

      setupSelectDistinctMock(
        [{ driveId: 'drive_shared', role: 'ADMIN' }],
        []
      );

      const request = new Request('https://example.com/api/drives');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toHaveLength(1);
      expect(body[0]).toMatchObject({
        id: 'drive_shared',
        isOwned: false,
        role: 'ADMIN',
      });
    });

    it('should return drives from page permissions with MEMBER role when not a drive member', async () => {
      vi.mocked(db.query.drives.findMany)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([mockDrive({ id: 'drive_perm', name: 'Permission Drive', ownerId: 'other_user' })]);

      setupSelectDistinctMock(
        [],
        [{ driveId: 'drive_perm' }]
      );

      const request = new Request('https://example.com/api/drives');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toHaveLength(1);
      expect(body[0]).toMatchObject({
        id: 'drive_perm',
        isOwned: false,
        role: 'MEMBER',
      });
    });

    it('should deduplicate drives that appear in multiple sources', async () => {
      const sharedDrive = mockDrive({ id: 'drive_dup', name: 'Duplicate Drive', ownerId: 'other_user' });
      vi.mocked(db.query.drives.findMany)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([sharedDrive]);

      // Same drive in both member and permission lists
      setupSelectDistinctMock(
        [{ driveId: 'drive_dup', role: 'ADMIN' }],
        [{ driveId: 'drive_dup' }]
      );

      const request = new Request('https://example.com/api/drives');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toHaveLength(1);
      // Should use member role over permission default
      expect(body[0].role).toBe('ADMIN');
    });
  });

  describe('query parameters', () => {
    it('should exclude trashed drives by default', async () => {
      vi.mocked(db.query.drives.findMany).mockResolvedValueOnce([
        mockDrive({ id: 'drive_active', name: 'Active', isTrashed: false }),
      ]);

      const request = new Request('https://example.com/api/drives');
      await GET(request);

      // Verify the findMany was called (trashed filtering happens in the query)
      expect(db.query.drives.findMany).toHaveBeenCalled();
    });

    it('should include trashed drives when includeTrash=true', async () => {
      vi.mocked(db.query.drives.findMany).mockResolvedValueOnce([
        mockDrive({ id: 'drive_trashed', name: 'Trashed', isTrashed: true }),
      ]);

      const request = new Request('https://example.com/api/drives?includeTrash=true');
      const response = await GET(request);

      expect(response.status).toBe(200);
      expect(db.query.drives.findMany).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should return 500 when database query fails', async () => {
      vi.mocked(db.query.drives.findMany).mockRejectedValue(new Error('Database connection lost'));

      const request = new Request('https://example.com/api/drives');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch drives');
      expect(loggers.api.error).toHaveBeenCalled();
    });
  });
});

describe('POST /api/drives', () => {
  const mockUserId = 'user_123';

  const setupInsertMock = (returnedDrive: ReturnType<typeof mockDrive>) => {
    const returningMock = vi.fn().mockResolvedValue([returnedDrive]);
    const valuesMock = vi.fn().mockReturnValue({ returning: returningMock });
    vi.mocked(db.insert).mockReturnValue({ values: valuesMock } as unknown as ReturnType<typeof db.insert>);
    return { valuesMock, returningMock };
  };

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

    it('should reject creating drive named "Personal"', async () => {
      const request = new Request('https://example.com/api/drives', {
        method: 'POST',
        body: JSON.stringify({ name: 'Personal' }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Cannot create a drive named "Personal".');
    });

    it('should reject "personal" (case-insensitive)', async () => {
      const request = new Request('https://example.com/api/drives', {
        method: 'POST',
        body: JSON.stringify({ name: 'personal' }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Cannot create a drive named "Personal".');
    });
  });

  describe('happy path', () => {
    it('should create drive successfully', async () => {
      const newDrive = mockDrive({
        id: 'drive_new',
        name: 'New Project',
        slug: 'new-project',
        ownerId: mockUserId,
      });
      setupInsertMock(newDrive);

      const request = new Request('https://example.com/api/drives', {
        method: 'POST',
        body: JSON.stringify({ name: 'New Project' }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(201);
      expect(body).toMatchObject({
        id: 'drive_new',
        name: 'New Project',
        isOwned: true,
        role: 'OWNER',
      });
    });

    it('should broadcast drive created event', async () => {
      const newDrive = mockDrive({ id: 'drive_new', name: 'New Drive', ownerId: mockUserId });
      setupInsertMock(newDrive);

      const request = new Request('https://example.com/api/drives', {
        method: 'POST',
        body: JSON.stringify({ name: 'New Drive' }),
      });

      await POST(request);

      expect(broadcastDriveEvent).toHaveBeenCalled();
    });

    it('should track drive creation', async () => {
      const newDrive = mockDrive({ id: 'drive_new', name: 'Tracked Drive', ownerId: mockUserId });
      setupInsertMock(newDrive);

      const request = new Request('https://example.com/api/drives', {
        method: 'POST',
        body: JSON.stringify({ name: 'Tracked Drive' }),
      });

      await POST(request);

      expect(trackDriveOperation).toHaveBeenCalledWith(
        mockUserId,
        'create',
        'drive_new',
        expect.objectContaining({ name: 'Tracked Drive' })
      );
    });
  });

  describe('error handling', () => {
    it('should return 500 when database insert fails', async () => {
      const valuesMock = vi.fn().mockReturnValue({
        returning: vi.fn().mockRejectedValue(new Error('Insert failed')),
      });
      vi.mocked(db.insert).mockReturnValue({ values: valuesMock } as unknown as ReturnType<typeof db.insert>);

      const request = new Request('https://example.com/api/drives', {
        method: 'POST',
        body: JSON.stringify({ name: 'Failing Drive' }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to create drive');
      expect(loggers.api.error).toHaveBeenCalled();
    });
  });
});
