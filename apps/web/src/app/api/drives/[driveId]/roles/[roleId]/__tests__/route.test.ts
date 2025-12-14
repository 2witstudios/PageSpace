import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET, PATCH, DELETE } from '../route';
import type { WebAuthResult, AuthError } from '@/lib/auth';

// Mock dependencies
vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      driveRoles: {
        findFirst: vi.fn(),
      },
      driveMembers: {
        findFirst: vi.fn(),
      },
    },
    select: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  driveRoles: {},
  driveMembers: {},
  drives: {},
  eq: vi.fn((field: unknown, value: unknown) => ({ field, value, type: 'eq' })),
  and: vi.fn((...args: unknown[]) => ({ args, type: 'and' })),
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
const createContext = (driveId: string, roleId: string) => ({
  params: Promise.resolve({ driveId, roleId }),
});

describe('GET /api/drives/[driveId]/roles/[roleId]', () => {
  const mockUserId = 'user_123';
  const mockDriveId = 'drive_abc';
  const mockRoleId = 'role_xyz';

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

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`);
      const response = await GET(request, createContext(mockDriveId, mockRoleId));

      expect(response.status).toBe(401);
    });
  });

  describe('authorization', () => {
    it('should return 404 when drive not found', async () => {
      setupSelectMock([]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`);
      const response = await GET(request, createContext(mockDriveId, mockRoleId));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Drive not found');
    });

    it('should return 403 when user is not owner or member', async () => {
      setupSelectMock([mockDrive({ id: mockDriveId, name: 'Other Drive', ownerId: 'other_user' })]);
      vi.mocked(db.query.driveMembers.findFirst).mockResolvedValue(undefined);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`);
      const response = await GET(request, createContext(mockDriveId, mockRoleId));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Not a member of this drive');
    });
  });

  describe('happy path', () => {
    it('should return 404 when role not found', async () => {
      setupSelectMock([mockDrive({ id: mockDriveId, name: 'Test Drive', ownerId: mockUserId })]);
      vi.mocked(db.query.driveRoles.findFirst).mockResolvedValue(undefined);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`);
      const response = await GET(request, createContext(mockDriveId, mockRoleId));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Role not found');
    });

    it('should return role when user is owner', async () => {
      const role = mockRole({ id: mockRoleId, name: 'Editor', driveId: mockDriveId });
      setupSelectMock([mockDrive({ id: mockDriveId, name: 'Test Drive', ownerId: mockUserId })]);
      vi.mocked(db.query.driveRoles.findFirst).mockResolvedValue(role);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`);
      const response = await GET(request, createContext(mockDriveId, mockRoleId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.role).toMatchObject({
        id: mockRoleId,
        name: 'Editor',
      });
    });

    it('should return role when user is member', async () => {
      const role = mockRole({ id: mockRoleId, name: 'Viewer', driveId: mockDriveId });
      setupSelectMock([mockDrive({ id: mockDriveId, name: 'Shared Drive', ownerId: 'other_user' })]);
      vi.mocked(db.query.driveMembers.findFirst).mockResolvedValue(
        mockMember({ userId: mockUserId, driveId: mockDriveId, role: 'MEMBER' })
      );
      vi.mocked(db.query.driveRoles.findFirst).mockResolvedValue(role);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`);
      const response = await GET(request, createContext(mockDriveId, mockRoleId));

      expect(response.status).toBe(200);
    });
  });

  describe('error handling', () => {
    it('should return 500 when database query fails', async () => {
      vi.mocked(db.select).mockImplementation(() => {
        throw new Error('Database error');
      });

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`);
      const response = await GET(request, createContext(mockDriveId, mockRoleId));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch role');
    });
  });
});

describe('PATCH /api/drives/[driveId]/roles/[roleId]', () => {
  const mockUserId = 'user_123';
  const mockDriveId = 'drive_abc';
  const mockRoleId = 'role_xyz';

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

  const setupUpdateMock = (returnedRole?: unknown) => {
    const returningMock = vi.fn().mockResolvedValue(returnedRole ? [returnedRole] : []);
    const whereMock = vi.fn().mockReturnValue({ returning: returningMock });
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as unknown as ReturnType<typeof db.update>);
    return { setMock, whereMock, returningMock };
  };

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Updated' }),
      });
      const response = await PATCH(request, createContext(mockDriveId, mockRoleId));

      expect(response.status).toBe(401);
    });
  });

  describe('authorization', () => {
    it('should return 404 when drive not found', async () => {
      setupSelectMock([]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Updated' }),
      });
      const response = await PATCH(request, createContext(mockDriveId, mockRoleId));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Drive not found');
    });

    it('should return 403 when user is not owner or admin', async () => {
      setupSelectMock(
        [mockDrive({ id: mockDriveId, name: 'Other Drive', ownerId: 'other_user' })],
        []
      );

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Updated' }),
      });
      const response = await PATCH(request, createContext(mockDriveId, mockRoleId));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Only owners and admins can update roles');
    });
  });

  describe('validation', () => {
    beforeEach(() => {
      setupSelectMock([mockDrive({ id: mockDriveId, name: 'Test', ownerId: mockUserId })]);
      vi.mocked(db.query.driveRoles.findFirst).mockResolvedValue(
        mockRole({ id: mockRoleId, name: 'Original', driveId: mockDriveId })
      );
    });

    it('should reject empty name', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: '   ' }),
      });
      const response = await PATCH(request, createContext(mockDriveId, mockRoleId));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Role name must be between 1 and 50 characters');
    });

    it('should reject name longer than 50 characters', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'a'.repeat(51) }),
      });
      const response = await PATCH(request, createContext(mockDriveId, mockRoleId));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Role name must be between 1 and 50 characters');
    });

    it('should reject invalid permissions structure', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`, {
        method: 'PATCH',
        body: JSON.stringify({ permissions: 'invalid' }),
      });
      const response = await PATCH(request, createContext(mockDriveId, mockRoleId));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid permissions structure');
    });
  });

  describe('happy path', () => {
    it('should return 404 when role not found', async () => {
      setupSelectMock([mockDrive({ id: mockDriveId, name: 'Test', ownerId: mockUserId })]);
      vi.mocked(db.query.driveRoles.findFirst).mockResolvedValue(undefined);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Updated' }),
      });
      const response = await PATCH(request, createContext(mockDriveId, mockRoleId));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Role not found');
    });

    it('should update role name', async () => {
      setupSelectMock([mockDrive({ id: mockDriveId, name: 'Test', ownerId: mockUserId })]);
      vi.mocked(db.query.driveRoles.findFirst).mockResolvedValue(
        mockRole({ id: mockRoleId, name: 'Original', driveId: mockDriveId })
      );

      const updatedRole = mockRole({ id: mockRoleId, name: 'Updated', driveId: mockDriveId });
      setupUpdateMock(updatedRole);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Updated' }),
      });
      const response = await PATCH(request, createContext(mockDriveId, mockRoleId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.role.name).toBe('Updated');
    });

    it('should unset other defaults when setting isDefault=true', async () => {
      setupSelectMock([mockDrive({ id: mockDriveId, name: 'Test', ownerId: mockUserId })]);
      vi.mocked(db.query.driveRoles.findFirst).mockResolvedValue(
        mockRole({ id: mockRoleId, name: 'Original', driveId: mockDriveId, isDefault: false })
      );

      const updatedRole = mockRole({ id: mockRoleId, name: 'Original', driveId: mockDriveId, isDefault: true });
      const { setMock } = setupUpdateMock(updatedRole);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`, {
        method: 'PATCH',
        body: JSON.stringify({ isDefault: true }),
      });
      await PATCH(request, createContext(mockDriveId, mockRoleId));

      // First call should unset other defaults
      expect(setMock).toHaveBeenNthCalledWith(1, { isDefault: false });
    });

    it('should allow admin to update role', async () => {
      setupSelectMock(
        [mockDrive({ id: mockDriveId, name: 'Shared', ownerId: 'other_user' })],
        [mockMember({ userId: mockUserId, driveId: mockDriveId, role: 'ADMIN' })]
      );
      vi.mocked(db.query.driveRoles.findFirst).mockResolvedValue(
        mockRole({ id: mockRoleId, name: 'Original', driveId: mockDriveId })
      );

      const updatedRole = mockRole({ id: mockRoleId, name: 'Updated', driveId: mockDriveId });
      setupUpdateMock(updatedRole);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Updated' }),
      });
      const response = await PATCH(request, createContext(mockDriveId, mockRoleId));

      expect(response.status).toBe(200);
    });
  });

  describe('error handling', () => {
    it('should return 409 for duplicate name', async () => {
      setupSelectMock([mockDrive({ id: mockDriveId, name: 'Test', ownerId: mockUserId })]);
      vi.mocked(db.query.driveRoles.findFirst).mockResolvedValue(
        mockRole({ id: mockRoleId, name: 'Original', driveId: mockDriveId })
      );

      const setMock = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockRejectedValue(new Error('unique constraint')),
        }),
      });
      vi.mocked(db.update).mockReturnValue({ set: setMock } as unknown as ReturnType<typeof db.update>);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Duplicate' }),
      });
      const response = await PATCH(request, createContext(mockDriveId, mockRoleId));
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.error).toBe('A role with this name already exists');
    });

    it('should return 500 for other errors', async () => {
      setupSelectMock([mockDrive({ id: mockDriveId, name: 'Test', ownerId: mockUserId })]);
      vi.mocked(db.query.driveRoles.findFirst).mockResolvedValue(
        mockRole({ id: mockRoleId, name: 'Original', driveId: mockDriveId })
      );

      const setMock = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockRejectedValue(new Error('Connection lost')),
        }),
      });
      vi.mocked(db.update).mockReturnValue({ set: setMock } as unknown as ReturnType<typeof db.update>);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Updated' }),
      });
      const response = await PATCH(request, createContext(mockDriveId, mockRoleId));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to update role');
    });
  });
});

describe('DELETE /api/drives/[driveId]/roles/[roleId]', () => {
  const mockUserId = 'user_123';
  const mockDriveId = 'drive_abc';
  const mockRoleId = 'role_xyz';

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

  const setupDeleteMock = () => {
    const whereMock = vi.fn().mockResolvedValue(undefined);
    vi.mocked(db.delete).mockReturnValue({ where: whereMock } as unknown as ReturnType<typeof db.delete>);
    return { whereMock };
  };

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`, {
        method: 'DELETE',
      });
      const response = await DELETE(request, createContext(mockDriveId, mockRoleId));

      expect(response.status).toBe(401);
    });
  });

  describe('authorization', () => {
    it('should return 404 when drive not found', async () => {
      setupSelectMock([]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`, {
        method: 'DELETE',
      });
      const response = await DELETE(request, createContext(mockDriveId, mockRoleId));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Drive not found');
    });

    it('should return 403 when user is not owner or admin', async () => {
      setupSelectMock(
        [mockDrive({ id: mockDriveId, name: 'Other Drive', ownerId: 'other_user' })],
        []
      );

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`, {
        method: 'DELETE',
      });
      const response = await DELETE(request, createContext(mockDriveId, mockRoleId));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Only owners and admins can delete roles');
    });
  });

  describe('happy path', () => {
    it('should return 404 when role not found', async () => {
      setupSelectMock([mockDrive({ id: mockDriveId, name: 'Test', ownerId: mockUserId })]);
      vi.mocked(db.query.driveRoles.findFirst).mockResolvedValue(undefined);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`, {
        method: 'DELETE',
      });
      const response = await DELETE(request, createContext(mockDriveId, mockRoleId));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Role not found');
    });

    it('should delete role successfully', async () => {
      setupSelectMock([mockDrive({ id: mockDriveId, name: 'Test', ownerId: mockUserId })]);
      vi.mocked(db.query.driveRoles.findFirst).mockResolvedValue(
        mockRole({ id: mockRoleId, name: 'ToDelete', driveId: mockDriveId })
      );
      const { whereMock } = setupDeleteMock();

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`, {
        method: 'DELETE',
      });
      const response = await DELETE(request, createContext(mockDriveId, mockRoleId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(whereMock).toHaveBeenCalled();
    });

    it('should allow admin to delete role', async () => {
      setupSelectMock(
        [mockDrive({ id: mockDriveId, name: 'Shared', ownerId: 'other_user' })],
        [mockMember({ userId: mockUserId, driveId: mockDriveId, role: 'ADMIN' })]
      );
      vi.mocked(db.query.driveRoles.findFirst).mockResolvedValue(
        mockRole({ id: mockRoleId, name: 'ToDelete', driveId: mockDriveId })
      );
      setupDeleteMock();

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`, {
        method: 'DELETE',
      });
      const response = await DELETE(request, createContext(mockDriveId, mockRoleId));

      expect(response.status).toBe(200);
    });
  });

  describe('error handling', () => {
    it('should return 500 when delete fails', async () => {
      setupSelectMock([mockDrive({ id: mockDriveId, name: 'Test', ownerId: mockUserId })]);
      vi.mocked(db.query.driveRoles.findFirst).mockResolvedValue(
        mockRole({ id: mockRoleId, name: 'ToDelete', driveId: mockDriveId })
      );

      vi.mocked(db.delete).mockReturnValue({
        where: vi.fn().mockRejectedValue(new Error('Delete failed')),
      } as unknown as ReturnType<typeof db.delete>);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/${mockRoleId}`, {
        method: 'DELETE',
      });
      const response = await DELETE(request, createContext(mockDriveId, mockRoleId));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to delete role');
    });
  });
});
