import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { PATCH } from '../route';
import type { WebAuthResult, AuthError } from '@/lib/auth';

// Mock dependencies
vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      driveRoles: {
        findMany: vi.fn(),
      },
    },
    select: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
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

describe('PATCH /api/drives/[driveId]/roles/reorder', () => {
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

  const setupTransactionMock = () => {
    const txUpdateMock = vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    });
    vi.mocked(db.transaction).mockImplementation(async (callback) => {
      await callback({ update: txUpdateMock } as never);
    });
    return { txUpdateMock };
  };

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/reorder`, {
        method: 'PATCH',
        body: JSON.stringify({ roleIds: ['role_1', 'role_2'] }),
      });
      const response = await PATCH(request, createContext(mockDriveId));

      expect(response.status).toBe(401);
    });
  });

  describe('authorization', () => {
    it('should return 404 when drive not found', async () => {
      setupSelectMock([]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/reorder`, {
        method: 'PATCH',
        body: JSON.stringify({ roleIds: ['role_1', 'role_2'] }),
      });
      const response = await PATCH(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Drive not found');
    });

    it('should return 403 when user is not owner or admin', async () => {
      setupSelectMock(
        [mockDrive({ id: mockDriveId, name: 'Other Drive', ownerId: 'other_user' })],
        []
      );

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/reorder`, {
        method: 'PATCH',
        body: JSON.stringify({ roleIds: ['role_1', 'role_2'] }),
      });
      const response = await PATCH(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Only owners and admins can reorder roles');
    });
  });

  describe('validation', () => {
    beforeEach(() => {
      setupSelectMock([mockDrive({ id: mockDriveId, name: 'Test', ownerId: mockUserId })]);
    });

    it('should reject when roleIds is not an array', async () => {
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/reorder`, {
        method: 'PATCH',
        body: JSON.stringify({ roleIds: 'not-an-array' }),
      });
      const response = await PATCH(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('roleIds must be an array');
    });

    it('should reject when roleIds contains invalid IDs', async () => {
      vi.mocked(db.query.driveRoles.findMany).mockResolvedValue([
        { id: 'role_1' },
        { id: 'role_2' },
      ]);

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/reorder`, {
        method: 'PATCH',
        body: JSON.stringify({ roleIds: ['role_1', 'role_invalid'] }),
      });
      const response = await PATCH(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid role IDs');
    });
  });

  describe('happy path', () => {
    it('should reorder roles successfully', async () => {
      setupSelectMock([mockDrive({ id: mockDriveId, name: 'Test', ownerId: mockUserId })]);
      vi.mocked(db.query.driveRoles.findMany).mockResolvedValue([
        { id: 'role_1' },
        { id: 'role_2' },
        { id: 'role_3' },
      ]);
      const { txUpdateMock } = setupTransactionMock();

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/reorder`, {
        method: 'PATCH',
        body: JSON.stringify({ roleIds: ['role_3', 'role_1', 'role_2'] }),
      });
      const response = await PATCH(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      // Transaction should update positions for each role
      expect(txUpdateMock).toHaveBeenCalledTimes(3);
    });

    it('should allow admin to reorder roles', async () => {
      setupSelectMock(
        [mockDrive({ id: mockDriveId, name: 'Shared', ownerId: 'other_user' })],
        [mockMember({ userId: mockUserId, driveId: mockDriveId, role: 'ADMIN' })]
      );
      vi.mocked(db.query.driveRoles.findMany).mockResolvedValue([
        { id: 'role_1' },
        { id: 'role_2' },
      ]);
      setupTransactionMock();

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/reorder`, {
        method: 'PATCH',
        body: JSON.stringify({ roleIds: ['role_2', 'role_1'] }),
      });
      const response = await PATCH(request, createContext(mockDriveId));

      expect(response.status).toBe(200);
    });

    it('should handle empty roleIds array', async () => {
      setupSelectMock([mockDrive({ id: mockDriveId, name: 'Test', ownerId: mockUserId })]);
      vi.mocked(db.query.driveRoles.findMany).mockResolvedValue([]);
      setupTransactionMock();

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/reorder`, {
        method: 'PATCH',
        body: JSON.stringify({ roleIds: [] }),
      });
      const response = await PATCH(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });

    it('should handle partial roleIds (subset of all roles)', async () => {
      setupSelectMock([mockDrive({ id: mockDriveId, name: 'Test', ownerId: mockUserId })]);
      vi.mocked(db.query.driveRoles.findMany).mockResolvedValue([
        { id: 'role_1' },
        { id: 'role_2' },
        { id: 'role_3' },
      ]);
      setupTransactionMock();

      // Only reorder some roles
      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/reorder`, {
        method: 'PATCH',
        body: JSON.stringify({ roleIds: ['role_1', 'role_3'] }), // role_2 not included
      });
      const response = await PATCH(request, createContext(mockDriveId));

      expect(response.status).toBe(200);
    });
  });

  describe('error handling', () => {
    it('should return 500 when transaction fails', async () => {
      setupSelectMock([mockDrive({ id: mockDriveId, name: 'Test', ownerId: mockUserId })]);
      vi.mocked(db.query.driveRoles.findMany).mockResolvedValue([{ id: 'role_1' }]);
      vi.mocked(db.transaction).mockRejectedValue(new Error('Transaction failed'));

      const request = new Request(`https://example.com/api/drives/${mockDriveId}/roles/reorder`, {
        method: 'PATCH',
        body: JSON.stringify({ roleIds: ['role_1'] }),
      });
      const response = await PATCH(request, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to reorder roles');
    });
  });
});
