import { describe, it, expect, beforeEach, vi } from 'vitest';

// ============================================================================
// Unit Tests for DriveService (Service Seam)
//
// These tests verify the business logic of the drive service functions.
// We mock the database layer to isolate the service logic.
// ============================================================================

// Mock the db module
vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      drives: {
        findMany: vi.fn(),
        findFirst: vi.fn(),
      },
    },
    selectDistinct: vi.fn(),
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
  drives: { id: 'drives.id', ownerId: 'drives.ownerId', isTrashed: 'drives.isTrashed' },
  driveMembers: { driveId: 'driveMembers.driveId', userId: 'driveMembers.userId', role: 'driveMembers.role' },
  pages: { driveId: 'pages.driveId', id: 'pages.id' },
  pagePermissions: { pageId: 'pagePermissions.pageId', userId: 'pagePermissions.userId', canView: 'pagePermissions.canView' },
  eq: vi.fn((a, b) => ({ op: 'eq', a, b })),
  and: vi.fn((...args) => ({ op: 'and', args })),
  not: vi.fn((a) => ({ op: 'not', a })),
  inArray: vi.fn((a, b) => ({ op: 'inArray', a, b })),
}));

import { db } from '@pagespace/db';
import {
  listAccessibleDrives,
  createDrive,
  getDriveById,
  getDriveAccess,
  getDriveWithAccess,
  updateDrive,
  trashDrive,
  restoreDrive,
} from '../drive-service';

// ============================================================================
// Test Helpers
// ============================================================================

const createMockDrive = (overrides: { id: string; name: string; ownerId?: string; isTrashed?: boolean }) => ({
  id: overrides.id,
  name: overrides.name,
  slug: overrides.name.toLowerCase().replace(/\s+/g, '-'),
  ownerId: overrides.ownerId ?? 'owner_123',
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  isTrashed: overrides.isTrashed ?? false,
  trashedAt: null,
  drivePrompt: null,
});

// ============================================================================
// listAccessibleDrives
// ============================================================================

describe('listAccessibleDrives', () => {
  beforeEach(() => {
    vi.resetAllMocks(); // Reset mock implementations including mockResolvedValueOnce queue
  });

  const setupMocks = (
    ownedDrives: ReturnType<typeof createMockDrive>[],
    memberDrives: Array<{ driveId: string; role: string }>,
    permissionDrives: Array<{ driveId: string | null }>,
    sharedDrivesData: ReturnType<typeof createMockDrive>[]
  ) => {
    // Mock owned drives query (first call) and shared drives query (second call)
    // Only use mockResolvedValueOnce to ensure correct sequence
    vi.mocked(db.query.drives.findMany)
      .mockResolvedValueOnce(ownedDrives)
      .mockResolvedValueOnce(sharedDrivesData);

    // Mock member drives selectDistinct - returns member list first, then permission list
    vi.mocked(db.selectDistinct).mockImplementation(() => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(memberDrives),
        leftJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(permissionDrives),
        }),
      }),
    } as unknown as ReturnType<typeof db.selectDistinct>));
  };

  it('should return empty array when user has no drives', async () => {
    setupMocks([], [], [], []);

    const result = await listAccessibleDrives('user_123');

    expect(result).toEqual([]);
  });

  it('should return owned drives with isOwned=true and role=OWNER', async () => {
    const ownedDrive = createMockDrive({ id: 'drive_1', name: 'My Drive', ownerId: 'user_123' });
    setupMocks([ownedDrive], [], [], []);

    const result = await listAccessibleDrives('user_123');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'drive_1',
      name: 'My Drive',
      isOwned: true,
      role: 'OWNER',
    });
  });

  it('should return shared drives with correct role from membership', async () => {
    const sharedDrive = createMockDrive({ id: 'drive_shared', name: 'Shared Drive', ownerId: 'other_user' });
    setupMocks(
      [],
      [{ driveId: 'drive_shared', role: 'ADMIN' }],
      [],
      [sharedDrive]
    );

    const result = await listAccessibleDrives('user_123');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'drive_shared',
      isOwned: false,
      role: 'ADMIN',
    });
  });

  it('should return drives from page permissions with MEMBER role when not a drive member', async () => {
    const permDrive = createMockDrive({ id: 'drive_perm', name: 'Permission Drive', ownerId: 'other_user' });
    setupMocks(
      [],
      [],
      [{ driveId: 'drive_perm' }],
      [permDrive]
    );

    const result = await listAccessibleDrives('user_123');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'drive_perm',
      isOwned: false,
      role: 'MEMBER',
    });
  });

  it('should prefer membership role over page permission default', async () => {
    const drive = createMockDrive({ id: 'drive_both', name: 'Both Sources', ownerId: 'other_user' });
    setupMocks(
      [],
      [{ driveId: 'drive_both', role: 'ADMIN' }],
      [{ driveId: 'drive_both' }], // Same drive in both sources
      [drive]
    );

    const result = await listAccessibleDrives('user_123');

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('ADMIN'); // Membership role takes precedence
  });

  it('should deduplicate drives from multiple sources', async () => {
    const drive = createMockDrive({ id: 'drive_dup', name: 'Duplicate', ownerId: 'other_user' });
    setupMocks(
      [],
      [{ driveId: 'drive_dup', role: 'MEMBER' }],
      [{ driveId: 'drive_dup' }],
      [drive]
    );

    const result = await listAccessibleDrives('user_123');

    // Should only return one instance of the drive
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('drive_dup');
  });
});

// ============================================================================
// createDrive
// ============================================================================

describe('createDrive', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should create drive with generated slug', async () => {
    const newDrive = createMockDrive({ id: 'drive_new', name: 'New Project', ownerId: 'user_123' });
    const returningMock = vi.fn().mockResolvedValue([newDrive]);
    const valuesMock = vi.fn().mockReturnValue({ returning: returningMock });
    vi.mocked(db.insert).mockReturnValue({ values: valuesMock } as unknown as ReturnType<typeof db.insert>);

    const result = await createDrive('user_123', { name: 'New Project' });

    expect(valuesMock).toHaveBeenCalled();
    expect(result.isOwned).toBe(true);
    expect(result.role).toBe('OWNER');
  });

  it('should return drive with isOwned=true and role=OWNER', async () => {
    const newDrive = createMockDrive({ id: 'drive_123', name: 'Test', ownerId: 'user_123' });
    const returningMock = vi.fn().mockResolvedValue([newDrive]);
    const valuesMock = vi.fn().mockReturnValue({ returning: returningMock });
    vi.mocked(db.insert).mockReturnValue({ values: valuesMock } as unknown as ReturnType<typeof db.insert>);

    const result = await createDrive('user_123', { name: 'Test' });

    expect(result.isOwned).toBe(true);
    expect(result.role).toBe('OWNER');
  });
});

// ============================================================================
// getDriveById
// ============================================================================

describe('getDriveById', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should return drive when found', async () => {
    const drive = createMockDrive({ id: 'drive_123', name: 'Test' });
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(drive);

    const result = await getDriveById('drive_123');

    expect(result).toEqual(drive);
  });

  it('should return null when drive not found', async () => {
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(undefined);

    const result = await getDriveById('nonexistent');

    expect(result).toBeNull();
  });
});

// ============================================================================
// getDriveAccess
// ============================================================================

describe('getDriveAccess', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should return owner access when user is drive owner', async () => {
    const drive = createMockDrive({ id: 'drive_123', name: 'Test', ownerId: 'user_123' });
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(drive);

    const result = await getDriveAccess('drive_123', 'user_123');

    expect(result).toEqual({
      isOwner: true,
      isAdmin: true,
      isMember: true,
      role: 'OWNER',
    });
  });

  it('should return admin access when user is admin member', async () => {
    const drive = createMockDrive({ id: 'drive_123', name: 'Test', ownerId: 'other_user' });
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(drive);

    const limitMock = vi.fn().mockResolvedValue([{ role: 'ADMIN' }]);
    const whereMock = vi.fn().mockReturnValue({ limit: limitMock });
    const fromMock = vi.fn().mockReturnValue({ where: whereMock });
    vi.mocked(db.select).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof db.select>);

    const result = await getDriveAccess('drive_123', 'user_123');

    expect(result).toEqual({
      isOwner: false,
      isAdmin: true,
      isMember: true,
      role: 'ADMIN',
    });
  });

  it('should return member access when user is regular member', async () => {
    const drive = createMockDrive({ id: 'drive_123', name: 'Test', ownerId: 'other_user' });
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(drive);

    const limitMock = vi.fn().mockResolvedValue([{ role: 'MEMBER' }]);
    const whereMock = vi.fn().mockReturnValue({ limit: limitMock });
    const fromMock = vi.fn().mockReturnValue({ where: whereMock });
    vi.mocked(db.select).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof db.select>);

    const result = await getDriveAccess('drive_123', 'user_123');

    expect(result).toEqual({
      isOwner: false,
      isAdmin: false,
      isMember: true,
      role: 'MEMBER',
    });
  });

  it('should return no access when user is not owner or member', async () => {
    const drive = createMockDrive({ id: 'drive_123', name: 'Test', ownerId: 'other_user' });
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(drive);

    const limitMock = vi.fn().mockResolvedValue([]);
    const whereMock = vi.fn().mockReturnValue({ limit: limitMock });
    const fromMock = vi.fn().mockReturnValue({ where: whereMock });
    vi.mocked(db.select).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof db.select>);

    const result = await getDriveAccess('drive_123', 'user_123');

    expect(result).toEqual({
      isOwner: false,
      isAdmin: false,
      isMember: false,
      role: null,
    });
  });

  it('should return no access when drive not found', async () => {
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(undefined);

    const result = await getDriveAccess('nonexistent', 'user_123');

    expect(result).toEqual({
      isOwner: false,
      isAdmin: false,
      isMember: false,
      role: null,
    });
  });
});

// ============================================================================
// getDriveWithAccess
// ============================================================================

describe('getDriveWithAccess', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should return drive with access info for owner', async () => {
    const drive = createMockDrive({ id: 'drive_123', name: 'Test', ownerId: 'user_123' });
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(drive);

    const result = await getDriveWithAccess('drive_123', 'user_123');

    expect(result).toMatchObject({
      id: 'drive_123',
      name: 'Test',
      isOwned: true,
      isMember: true,
      role: 'OWNER',
    });
  });

  it('should return null when user has no access', async () => {
    const drive = createMockDrive({ id: 'drive_123', name: 'Test', ownerId: 'other_user' });
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(drive);

    const limitMock = vi.fn().mockResolvedValue([]);
    const whereMock = vi.fn().mockReturnValue({ limit: limitMock });
    const fromMock = vi.fn().mockReturnValue({ where: whereMock });
    vi.mocked(db.select).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof db.select>);

    const result = await getDriveWithAccess('drive_123', 'user_123');

    expect(result).toBeNull();
  });

  it('should return null when drive not found', async () => {
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(undefined);

    const result = await getDriveWithAccess('nonexistent', 'user_123');

    expect(result).toBeNull();
  });
});

// ============================================================================
// updateDrive
// ============================================================================

describe('updateDrive', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should update drive name and regenerate slug', async () => {
    const updatedDrive = createMockDrive({ id: 'drive_123', name: 'Updated Name' });
    const returningMock = vi.fn().mockResolvedValue([updatedDrive]);
    const whereMock = vi.fn().mockReturnValue({ returning: returningMock });
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as unknown as ReturnType<typeof db.update>);

    const result = await updateDrive('drive_123', { name: 'Updated Name' });

    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Updated Name',
      slug: 'updated-name',
    }));
    expect(result).toEqual(updatedDrive);
  });

  it('should update drivePrompt without changing slug', async () => {
    const updatedDrive = createMockDrive({ id: 'drive_123', name: 'Test' });
    const returningMock = vi.fn().mockResolvedValue([updatedDrive]);
    const whereMock = vi.fn().mockReturnValue({ returning: returningMock });
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as unknown as ReturnType<typeof db.update>);

    await updateDrive('drive_123', { drivePrompt: 'New prompt' });

    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({
      drivePrompt: 'New prompt',
    }));
    expect(setMock).not.toHaveBeenCalledWith(expect.objectContaining({
      slug: expect.anything(),
    }));
  });

  it('should return null when update returns nothing', async () => {
    const returningMock = vi.fn().mockResolvedValue([]);
    const whereMock = vi.fn().mockReturnValue({ returning: returningMock });
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as unknown as ReturnType<typeof db.update>);

    const result = await updateDrive('nonexistent', { name: 'Test' });

    expect(result).toBeNull();
  });
});

// ============================================================================
// trashDrive
// ============================================================================

describe('trashDrive', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should set isTrashed=true and trashedAt', async () => {
    const trashedDrive = { ...createMockDrive({ id: 'drive_123', name: 'Test' }), isTrashed: true };
    const returningMock = vi.fn().mockResolvedValue([trashedDrive]);
    const whereMock = vi.fn().mockReturnValue({ returning: returningMock });
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as unknown as ReturnType<typeof db.update>);

    const result = await trashDrive('drive_123');

    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({
      isTrashed: true,
      trashedAt: expect.any(Date),
    }));
    expect(result?.isTrashed).toBe(true);
  });
});

// ============================================================================
// restoreDrive
// ============================================================================

describe('restoreDrive', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should set isTrashed=false and trashedAt=null', async () => {
    const restoredDrive = createMockDrive({ id: 'drive_123', name: 'Test', isTrashed: false });
    const returningMock = vi.fn().mockResolvedValue([restoredDrive]);
    const whereMock = vi.fn().mockReturnValue({ returning: returningMock });
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as unknown as ReturnType<typeof db.update>);

    const result = await restoreDrive('drive_123');

    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({
      isTrashed: false,
      trashedAt: null,
    }));
    expect(result?.isTrashed).toBe(false);
  });
});
