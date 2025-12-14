import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET, POST } from '../route';
import type { WebAuthResult, AuthError } from '@/lib/auth';

// Mock dependencies
vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      driveRoles: {
        findMany: vi.fn(),
      },
      driveMembers: {
        findFirst: vi.fn(),
      },
    },
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
  driveRoles: {},
  driveMembers: {},
  drives: {},
  eq: vi.fn((field: unknown, value: unknown) => ({ field, value, type: 'eq' })),
  and: vi.fn((...args: unknown[]) => ({ args, type: 'and' })),
  asc: vi.fn((field: unknown) => ({ field, type: 'asc' })),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

import { db } from '@pagespace/db';
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
}) => ({
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

// Helper to create mock role
const mockRole = (overrides: {
  id: string;
  name: string;
  driveId: string;
  position?: number;
  isDefault?: boolean;
}) => ({
  id: overrides.id,
  driveId: overrides.driveId,
  name: overrides.name,
  description: null,
  color: '#000000',
  isDefault: overrides.isDefault ?? false,
  permissions: { page_1: { canView: true, canEdit: false, canShare: false } },
  position: overrides.position ?? 0,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
});

// Helper to create mock member
const mockMember = (overrides: {
  userId: string;
  driveId: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
}) => ({
  id: 'mem_' + overrides.userId,
  userId: overrides.userId,
  driveId: overrides.driveId,
  role: overrides.role,
  customRoleId: null,
  invitedBy: null,
  invitedAt: new Date(),
  acceptedAt: new Date(),
  lastAccessedAt: null,
});

// Create mock context
const createContext = (driveId: string) => ({
  params: Promise.resolve({ driveId }),
});

describe('GET /api/drives/[driveId]/roles', () => {
  const mockUserId = 'user_123';
  const mockDriveId = 'drive_abc';

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  const setupSelectMock = (driveResults: unknown[]) => {
    vi.mocked(db.select).mockImplementation(() => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(driveResults),
        }),
      }),
    } as unknown as ReturnType<typeof db.select>));
  };

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles`);
      const response = await GET(request, createContext(mockDriveId));

      expect(response.status).toBe(401);
    });
  });

  describe('authorization', () => {
    it('should return 404 when drive not found', async () => {
      setupSelectMock([]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Drive not found');
    });

    it('should return 403 when user is not owner or member', async () => {
      setupSelectMock([mockDrive({ id: mockDriveId, name: 'Other Drive', ownerId: 'other_user' })]);
      vi.mocked(db.query.driveMembers.findFirst).mockResolvedValue(undefined);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Not a member of this drive');
    });
  });

  describe('happy path', () => {
    it('should return empty roles array for drive with no roles', async () => {
      setupSelectMock([mockDrive({ id: mockDriveId, name: 'Test Drive', ownerId: mockUserId })]);
      vi.mocked(db.query.driveRoles.findMany).mockResolvedValue([]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.roles).toEqual([]);
    });

    it('should return roles ordered by position', async () => {
      setupSelectMock([mockDrive({ id: mockDriveId, name: 'Test Drive', ownerId: mockUserId })]);
      vi.mocked(db.query.driveRoles.findMany).mockResolvedValue([
        mockRole({ id: 'role_1', name: 'Admin', driveId: mockDriveId, position: 0 }),
        mockRole({ id: 'role_2', name: 'Editor', driveId: mockDriveId, position: 1 }),
        mockRole({ id: 'role_3', name: 'Viewer', driveId: mockDriveId, position: 2 }),
      ]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.roles).toHaveLength(3);
      expect(body.roles[0].name).toBe('Admin');
      expect(body.roles[1].name).toBe('Editor');
      expect(body.roles[2].name).toBe('Viewer');
    });

    it('should allow member to view roles', async () => {
      setupSelectMock([mockDrive({ id: mockDriveId, name: 'Shared Drive', ownerId: 'other_user' })]);
      vi.mocked(db.query.driveMembers.findFirst).mockResolvedValue(
        mockMember({ userId: mockUserId, driveId: mockDriveId, role: 'MEMBER' })
      );
      vi.mocked(db.query.driveRoles.findMany).mockResolvedValue([
        mockRole({ id: 'role_1', name: 'Test Role', driveId: mockDriveId }),
      ]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles`);
      const response = await GET(request, createContext(mockDriveId));

      expect(response.status).toBe(200);
    });
  });

  describe('error handling', () => {
    it('should return 500 when database query fails', async () => {
      vi.mocked(db.select).mockImplementation(() => {
        throw new Error('Database error');
      });

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles`);
      const response = await GET(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch roles');
    });
  });
});

describe('POST /api/drives/[driveId]/roles', () => {
  const mockUserId = 'user_123';
  const mockDriveId = 'drive_abc';

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  const setupSelectMock = (driveResults: unknown[], adminResults: unknown[] = []) => {
    let callIndex = 0;
    vi.mocked(db.select).mockImplementation(() => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockImplementation(async () => {
            callIndex++;
            if (callIndex === 1) return driveResults;
            return adminResults;
          }),
        }),
      }),
    } as unknown as ReturnType<typeof db.select>));
  };

  const setupInsertMock = (returnedRole: unknown) => {
    const returningMock = vi.fn().mockResolvedValue([returnedRole]);
    const valuesMock = vi.fn().mockReturnValue({ returning: returningMock });
    vi.mocked(db.insert).mockReturnValue({ values: valuesMock } as unknown as ReturnType<typeof db.insert>);
    return { valuesMock, returningMock };
  };

  const setupUpdateMock = () => {
    const whereMock = vi.fn().mockResolvedValue(undefined);
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as unknown as ReturnType<typeof db.update>);
    return { setMock, whereMock };
  };

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles`, {
        method: 'POST',
        body: JSON.stringify({ name: 'New Role', permissions: {} }),
      });
      const response = await POST(request, createContext(mockDriveId));

      expect(response.status).toBe(401);
    });
  });

  describe('authorization', () => {
    it('should return 404 when drive not found', async () => {
      setupSelectMock([]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles`, {
        method: 'POST',
        body: JSON.stringify({ name: 'New Role', permissions: {} }),
      });
      const response = await POST(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Drive not found');
    });

    it('should return 403 when user is not owner or admin', async () => {
      setupSelectMock(
        [mockDrive({ id: mockDriveId, name: 'Other Drive', ownerId: 'other_user' })],
        [] // No admin membership
      );

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles`, {
        method: 'POST',
        body: JSON.stringify({ name: 'New Role', permissions: {} }),
      });
      const response = await POST(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Only owners and admins can create roles');
    });
  });

  describe('validation', () => {
    beforeEach(() => {
      setupSelectMock([mockDrive({ id: mockDriveId, name: 'Test', ownerId: mockUserId })]);
    });

    it('should reject request without name', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles`, {
        method: 'POST',
        body: JSON.stringify({ permissions: {} }),
      });
      const response = await POST(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Name and permissions are required');
    });

    it('should reject request without permissions', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Test Role' }),
      });
      const response = await POST(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Name and permissions are required');
    });

    it('should reject empty name', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles`, {
        method: 'POST',
        body: JSON.stringify({ name: '   ', permissions: {} }),
      });
      const response = await POST(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Role name must be between 1 and 50 characters');
    });

    it('should reject name longer than 50 characters', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles`, {
        method: 'POST',
        body: JSON.stringify({ name: 'a'.repeat(51), permissions: {} }),
      });
      const response = await POST(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Role name must be between 1 and 50 characters');
    });

    it('should reject invalid permissions structure (array)', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Test', permissions: [] }),
      });
      const response = await POST(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid permissions structure');
    });

    it('should reject invalid permission values', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Test',
          permissions: { page_1: { canView: 'yes', canEdit: false, canShare: false } },
        }),
      });
      const response = await POST(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid permissions structure');
    });
  });

  describe('happy path', () => {
    beforeEach(() => {
      setupSelectMock([mockDrive({ id: mockDriveId, name: 'Test', ownerId: mockUserId })]);
      vi.mocked(db.query.driveRoles.findMany).mockResolvedValue([]);
      setupUpdateMock();
    });

    it('should create role with valid data', async () => {
      const newRole = mockRole({ id: 'role_new', name: 'Editor', driveId: mockDriveId });
      setupInsertMock(newRole);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Editor',
          permissions: { page_1: { canView: true, canEdit: true, canShare: false } },
        }),
      });
      const response = await POST(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(201);
      expect(body.role.name).toBe('Editor');
    });

    it('should set position to 0 when no existing roles', async () => {
      const newRole = mockRole({ id: 'role_new', name: 'First', driveId: mockDriveId, position: 0 });
      const { valuesMock } = setupInsertMock(newRole);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'First',
          permissions: {},
        }),
      });
      await POST(request, createContext(mockDriveId));

      expect(valuesMock).toHaveBeenCalledWith(
        expect.objectContaining({ position: 0 })
      );
    });

    it('should set position after existing roles', async () => {
      vi.mocked(db.query.driveRoles.findMany).mockResolvedValue([
        mockRole({ id: 'role_1', name: 'First', driveId: mockDriveId, position: 0 }),
        mockRole({ id: 'role_2', name: 'Second', driveId: mockDriveId, position: 1 }),
      ]);

      const newRole = mockRole({ id: 'role_new', name: 'Third', driveId: mockDriveId, position: 2 });
      const { valuesMock } = setupInsertMock(newRole);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Third',
          permissions: {},
        }),
      });
      await POST(request, createContext(mockDriveId));

      expect(valuesMock).toHaveBeenCalledWith(
        expect.objectContaining({ position: 2 })
      );
    });

    it('should unset other defaults when creating default role', async () => {
      const { setMock } = setupUpdateMock();
      const newRole = mockRole({ id: 'role_new', name: 'Default', driveId: mockDriveId, isDefault: true });
      setupInsertMock(newRole);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Default',
          isDefault: true,
          permissions: {},
        }),
      });
      await POST(request, createContext(mockDriveId));

      expect(setMock).toHaveBeenCalledWith({ isDefault: false });
    });

    it('should allow admin to create role', async () => {
      setupSelectMock(
        [mockDrive({ id: mockDriveId, name: 'Shared', ownerId: 'other_user' })],
        [mockMember({ userId: mockUserId, driveId: mockDriveId, role: 'ADMIN' })]
      );

      const newRole = mockRole({ id: 'role_new', name: 'New', driveId: mockDriveId });
      setupInsertMock(newRole);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'New',
          permissions: {},
        }),
      });
      const response = await POST(request, createContext(mockDriveId));

      expect(response.status).toBe(201);
    });
  });

  describe('error handling', () => {
    it('should return 409 for duplicate role name', async () => {
      setupSelectMock([mockDrive({ id: mockDriveId, name: 'Test', ownerId: mockUserId })]);
      vi.mocked(db.query.driveRoles.findMany).mockResolvedValue([]);

      const valuesMock = vi.fn().mockReturnValue({
        returning: vi.fn().mockRejectedValue(new Error('unique constraint violation')),
      });
      vi.mocked(db.insert).mockReturnValue({ values: valuesMock } as unknown as ReturnType<typeof db.insert>);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Duplicate', permissions: {} }),
      });
      const response = await POST(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.error).toBe('A role with this name already exists');
    });

    it('should return 500 for other database errors', async () => {
      setupSelectMock([mockDrive({ id: mockDriveId, name: 'Test', ownerId: mockUserId })]);
      vi.mocked(db.query.driveRoles.findMany).mockResolvedValue([]);

      const valuesMock = vi.fn().mockReturnValue({
        returning: vi.fn().mockRejectedValue(new Error('Connection lost')),
      });
      vi.mocked(db.insert).mockReturnValue({ values: valuesMock } as unknown as ReturnType<typeof db.insert>);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Test', permissions: {} }),
      });
      const response = await POST(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to create role');
    });
  });
});
