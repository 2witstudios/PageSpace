import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock @pagespace/db before importing the module under test
vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      organizations: { findFirst: vi.fn() },
      orgMembers: { findFirst: vi.fn(), findMany: vi.fn() },
      userProfiles: { findMany: vi.fn() },
    },
    transaction: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    select: vi.fn(),
  },
  organizations: {
    id: 'organizations.id',
    slug: 'organizations.slug',
    ownerId: 'organizations.ownerId',
  },
  orgMembers: {
    orgId: 'orgMembers.orgId',
    userId: 'orgMembers.userId',
    id: 'orgMembers.id',
  },
  users: { id: 'users.id', email: 'users.email' },
  userProfiles: { userId: 'userProfiles.userId' },
  eq: vi.fn((a, b) => ({ op: 'eq', a, b })),
  and: vi.fn((...args) => ({ op: 'and', args })),
  inArray: vi.fn((a, b) => ({ op: 'inArray', a, b })),
  count: vi.fn(() => 'count()'),
}));

// Mock @paralleldrive/cuid2
vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'mock-cuid'),
}));

import { db, orgMembers, organizations } from '@pagespace/db';
import {
  createOrganization,
  getOrganizationById,
  getOrganizationBySlug,
  updateOrganization,
  deleteOrganization,
  checkOrgAccess,
  listOrgMembers,
  listUserOrganizations,
  removeOrgMember,
  updateOrgMemberRole,
  isOrgMember,
} from '../org-repository';

// ============================================================================
// Test Helpers
// ============================================================================

const createMockOrg = (overrides: Partial<{
  id: string;
  name: string;
  slug: string;
  ownerId: string;
  description: string | null;
  avatarUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}> = {}) => ({
  id: overrides.id ?? 'org-1',
  name: overrides.name ?? 'Test Org',
  slug: overrides.slug ?? 'test-org',
  ownerId: overrides.ownerId ?? 'owner-1',
  description: overrides.description ?? null,
  avatarUrl: overrides.avatarUrl ?? null,
  createdAt: overrides.createdAt ?? new Date('2024-01-01'),
  updatedAt: overrides.updatedAt ?? new Date('2024-01-01'),
});

// ============================================================================
// createOrganization
// ============================================================================

describe('createOrganization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create an organization and owner membership in a transaction', async () => {
    const mockCreatedOrg = createMockOrg({ id: 'mock-cuid', ownerId: 'user-1' });

    // The transaction mock captures the callback and runs it with a mock tx
    const mockTxInsert = vi.fn();
    const mockTxReturning = vi.fn();
    const mockTxValues = vi.fn();

    // First insert call (organization) returns the org with .returning()
    // Second insert call (orgMembers) returns without .returning()
    let insertCallCount = 0;
    mockTxInsert.mockImplementation(() => {
      insertCallCount++;
      if (insertCallCount === 1) {
        // org insert
        return {
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([mockCreatedOrg]),
          }),
        };
      }
      // orgMembers insert
      return {
        values: vi.fn().mockResolvedValue(undefined),
      };
    });

    vi.mocked(db.transaction).mockImplementation(async (cb) => {
      const tx = { insert: mockTxInsert } as any;
      return cb(tx);
    });

    const result = await createOrganization('user-1', {
      name: 'Test Org',
      slug: 'test-org',
      description: 'A test',
    });

    expect(result).toEqual(mockCreatedOrg);
    expect(db.transaction).toHaveBeenCalledOnce();
    // Two insert calls: org + membership
    expect(mockTxInsert).toHaveBeenCalledTimes(2);
  });

  it('should pass correct values when creating the organization', async () => {
    const mockCreatedOrg = createMockOrg({ id: 'mock-cuid' });

    let capturedOrgValues: any;
    let capturedMemberValues: any;
    let insertCallCount = 0;

    vi.mocked(db.transaction).mockImplementation(async (cb) => {
      const tx = {
        insert: vi.fn().mockImplementation((table) => {
          insertCallCount++;
          if (insertCallCount === 1) {
            return {
              values: vi.fn().mockImplementation((vals) => {
                capturedOrgValues = vals;
                return {
                  returning: vi.fn().mockResolvedValue([mockCreatedOrg]),
                };
              }),
            };
          }
          return {
            values: vi.fn().mockImplementation((vals) => {
              capturedMemberValues = vals;
              return Promise.resolve();
            }),
          };
        }),
      } as any;
      return cb(tx);
    });

    await createOrganization('owner-42', {
      name: 'My Org',
      slug: 'my-org',
      description: 'desc',
    });

    expect(capturedOrgValues).toMatchObject({
      id: 'mock-cuid',
      name: 'My Org',
      slug: 'my-org',
      ownerId: 'owner-42',
      description: 'desc',
    });

    expect(capturedMemberValues).toMatchObject({
      orgId: mockCreatedOrg.id,
      userId: 'owner-42',
      role: 'OWNER',
    });
  });
});

// ============================================================================
// getOrganizationById
// ============================================================================

describe('getOrganizationById', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return the organization when found', async () => {
    const mockOrg = createMockOrg();
    vi.mocked(db.query.organizations.findFirst).mockResolvedValue(mockOrg);

    const result = await getOrganizationById('org-1');

    expect(result).toEqual(mockOrg);
    expect(db.query.organizations.findFirst).toHaveBeenCalledWith({
      where: expect.anything(),
    });
  });

  it('should return undefined when not found', async () => {
    vi.mocked(db.query.organizations.findFirst).mockResolvedValue(undefined);

    const result = await getOrganizationById('nonexistent');

    expect(result).toBeUndefined();
  });
});

// ============================================================================
// getOrganizationBySlug
// ============================================================================

describe('getOrganizationBySlug', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return the organization when found by slug', async () => {
    const mockOrg = createMockOrg({ slug: 'my-org' });
    vi.mocked(db.query.organizations.findFirst).mockResolvedValue(mockOrg);

    const result = await getOrganizationBySlug('my-org');

    expect(result).toEqual(mockOrg);
    expect(db.query.organizations.findFirst).toHaveBeenCalledWith({
      where: expect.anything(),
    });
  });

  it('should return undefined when slug not found', async () => {
    vi.mocked(db.query.organizations.findFirst).mockResolvedValue(undefined);

    const result = await getOrganizationBySlug('no-such-org');

    expect(result).toBeUndefined();
  });
});

// ============================================================================
// updateOrganization
// ============================================================================

describe('updateOrganization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should update and return the organization', async () => {
    const updatedOrg = createMockOrg({ name: 'Updated Org' });
    const mockReturning = vi.fn().mockResolvedValue([updatedOrg]);
    const mockWhere = vi.fn().mockReturnValue({ returning: mockReturning });
    const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
    vi.mocked(db.update).mockReturnValue({ set: mockSet } as any);

    const result = await updateOrganization('org-1', { name: 'Updated Org' });

    expect(result).toEqual(updatedOrg);
    expect(db.update).toHaveBeenCalledWith(organizations);
    expect(mockSet).toHaveBeenCalledWith({ name: 'Updated Org' });
  });

  it('should pass partial update fields correctly', async () => {
    const updatedOrg = createMockOrg({ description: 'new desc', avatarUrl: 'https://img.example.com/a.png' });
    const mockReturning = vi.fn().mockResolvedValue([updatedOrg]);
    const mockWhere = vi.fn().mockReturnValue({ returning: mockReturning });
    const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
    vi.mocked(db.update).mockReturnValue({ set: mockSet } as any);

    const input = { description: 'new desc', avatarUrl: 'https://img.example.com/a.png' };
    await updateOrganization('org-1', input);

    expect(mockSet).toHaveBeenCalledWith(input);
  });
});

// ============================================================================
// deleteOrganization
// ============================================================================

describe('deleteOrganization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should delete the organization by id', async () => {
    const mockWhere = vi.fn().mockResolvedValue(undefined);
    vi.mocked(db.delete).mockReturnValue({ where: mockWhere } as any);

    await deleteOrganization('org-1');

    expect(db.delete).toHaveBeenCalledWith(organizations);
    expect(mockWhere).toHaveBeenCalled();
  });
});

// ============================================================================
// checkOrgAccess
// ============================================================================

describe('checkOrgAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return non-member result when organization is not found', async () => {
    vi.mocked(db.query.organizations.findFirst).mockResolvedValue(undefined);

    const result = await checkOrgAccess('nonexistent-org', 'user-1');

    expect(result).toEqual({
      isOwner: false,
      isAdmin: false,
      isMember: false,
      org: null,
      role: null,
    });
  });

  it('should return owner result when user is the org owner', async () => {
    const mockOrg = createMockOrg({ ownerId: 'user-1' });
    vi.mocked(db.query.organizations.findFirst).mockResolvedValue(mockOrg);

    const result = await checkOrgAccess('org-1', 'user-1');

    expect(result).toEqual({
      isOwner: true,
      isAdmin: true,
      isMember: true,
      org: mockOrg,
      role: 'OWNER',
    });
    // Should NOT query orgMembers since owner is determined by ownerId field
    expect(db.query.orgMembers.findFirst).not.toHaveBeenCalled();
  });

  it('should return admin result when user has ADMIN membership', async () => {
    const mockOrg = createMockOrg({ ownerId: 'other-user' });
    vi.mocked(db.query.organizations.findFirst).mockResolvedValue(mockOrg);
    vi.mocked(db.query.orgMembers.findFirst).mockResolvedValue({
      id: 'mem-1',
      orgId: 'org-1',
      userId: 'user-1',
      role: 'ADMIN',
      joinedAt: new Date(),
    });

    const result = await checkOrgAccess('org-1', 'user-1');

    expect(result).toEqual({
      isOwner: false,
      isAdmin: true,
      isMember: true,
      org: mockOrg,
      role: 'ADMIN',
    });
  });

  it('should return member result when user has MEMBER membership', async () => {
    const mockOrg = createMockOrg({ ownerId: 'other-user' });
    vi.mocked(db.query.organizations.findFirst).mockResolvedValue(mockOrg);
    vi.mocked(db.query.orgMembers.findFirst).mockResolvedValue({
      id: 'mem-2',
      orgId: 'org-1',
      userId: 'user-1',
      role: 'MEMBER',
      joinedAt: new Date(),
    });

    const result = await checkOrgAccess('org-1', 'user-1');

    expect(result).toEqual({
      isOwner: false,
      isAdmin: false,
      isMember: true,
      org: mockOrg,
      role: 'MEMBER',
    });
  });

  it('should return non-member result when user has no membership', async () => {
    const mockOrg = createMockOrg({ ownerId: 'other-user' });
    vi.mocked(db.query.organizations.findFirst).mockResolvedValue(mockOrg);
    vi.mocked(db.query.orgMembers.findFirst).mockResolvedValue(undefined);

    const result = await checkOrgAccess('org-1', 'user-1');

    expect(result).toEqual({
      isOwner: false,
      isAdmin: false,
      isMember: false,
      org: mockOrg,
      role: null,
    });
  });
});

// ============================================================================
// listOrgMembers
// ============================================================================

describe('listOrgMembers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return members with user details and merged profiles', async () => {
    const joinedAt = new Date('2024-06-01');
    const mockMembers = [
      {
        id: 'mem-1',
        orgId: 'org-1',
        userId: 'user-1',
        role: 'OWNER',
        joinedAt,
        user: { id: 'user-1', email: 'alice@test.com', name: 'Alice' },
      },
      {
        id: 'mem-2',
        orgId: 'org-1',
        userId: 'user-2',
        role: 'MEMBER',
        joinedAt,
        user: { id: 'user-2', email: 'bob@test.com', name: 'Bob' },
      },
    ];

    const mockProfiles = [
      { userId: 'user-1', displayName: 'Alice Display', avatarUrl: 'https://img.example.com/alice.png' },
    ];

    vi.mocked(db.query.orgMembers.findMany).mockResolvedValue(mockMembers as any);
    vi.mocked(db.query.userProfiles.findMany).mockResolvedValue(mockProfiles as any);

    const result = await listOrgMembers('org-1');

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      id: 'mem-1',
      userId: 'user-1',
      role: 'OWNER',
      joinedAt,
      user: { id: 'user-1', email: 'alice@test.com', name: 'Alice' },
      profile: { userId: 'user-1', displayName: 'Alice Display', avatarUrl: 'https://img.example.com/alice.png' },
    });
    // user-2 has no profile, should be null
    expect(result[1]).toEqual({
      id: 'mem-2',
      userId: 'user-2',
      role: 'MEMBER',
      joinedAt,
      user: { id: 'user-2', email: 'bob@test.com', name: 'Bob' },
      profile: null,
    });
  });

  it('should return empty array when org has no members', async () => {
    vi.mocked(db.query.orgMembers.findMany).mockResolvedValue([]);

    const result = await listOrgMembers('org-empty');

    expect(result).toEqual([]);
    // Should not query profiles when no members
    expect(db.query.userProfiles.findMany).not.toHaveBeenCalled();
  });

  it('should handle members where all have profiles', async () => {
    const joinedAt = new Date('2024-06-01');
    const mockMembers = [
      {
        id: 'mem-1',
        orgId: 'org-1',
        userId: 'user-1',
        role: 'ADMIN',
        joinedAt,
        user: { id: 'user-1', email: 'a@test.com', name: 'A' },
      },
    ];
    const mockProfiles = [
      { userId: 'user-1', displayName: 'A Display', avatarUrl: null },
    ];

    vi.mocked(db.query.orgMembers.findMany).mockResolvedValue(mockMembers as any);
    vi.mocked(db.query.userProfiles.findMany).mockResolvedValue(mockProfiles as any);

    const result = await listOrgMembers('org-1');

    expect(result[0]!.profile).toEqual({ userId: 'user-1', displayName: 'A Display', avatarUrl: null });
  });
});

// ============================================================================
// listUserOrganizations
// ============================================================================

describe('listUserOrganizations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return organizations with roles and member counts', async () => {
    const createdAt = new Date('2024-01-01');
    const updatedAt = new Date('2024-06-01');

    const mockMemberships = [
      {
        orgId: 'org-1',
        userId: 'user-1',
        role: 'OWNER',
        organization: {
          id: 'org-1',
          name: 'Org One',
          slug: 'org-one',
          description: 'First org',
          avatarUrl: null,
          ownerId: 'user-1',
          createdAt,
          updatedAt,
        },
      },
      {
        orgId: 'org-2',
        userId: 'user-1',
        role: 'MEMBER',
        organization: {
          id: 'org-2',
          name: 'Org Two',
          slug: 'org-two',
          description: null,
          avatarUrl: 'https://img.example.com/org2.png',
          ownerId: 'other-user',
          createdAt,
          updatedAt,
        },
      },
    ];

    const mockCountRows = [
      { orgId: 'org-1', memberCount: 5 },
      { orgId: 'org-2', memberCount: 12 },
    ];

    vi.mocked(db.query.orgMembers.findMany).mockResolvedValue(mockMemberships as any);

    // Chain: db.select().from().where().groupBy()
    const mockGroupBy = vi.fn().mockResolvedValue(mockCountRows);
    const mockWhere = vi.fn().mockReturnValue({ groupBy: mockGroupBy });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    vi.mocked(db.select).mockReturnValue({ from: mockFrom } as any);

    const result = await listUserOrganizations('user-1');

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      id: 'org-1',
      name: 'Org One',
      slug: 'org-one',
      description: 'First org',
      avatarUrl: null,
      ownerId: 'user-1',
      createdAt,
      updatedAt,
      role: 'OWNER',
      memberCount: 5,
    });
    expect(result[1]).toEqual({
      id: 'org-2',
      name: 'Org Two',
      slug: 'org-two',
      description: null,
      avatarUrl: 'https://img.example.com/org2.png',
      ownerId: 'other-user',
      createdAt,
      updatedAt,
      role: 'MEMBER',
      memberCount: 12,
    });
  });

  it('should return empty array when user has no memberships', async () => {
    vi.mocked(db.query.orgMembers.findMany).mockResolvedValue([]);

    const result = await listUserOrganizations('user-no-orgs');

    expect(result).toEqual([]);
    // Should not query counts when no memberships
    expect(db.select).not.toHaveBeenCalled();
  });

  it('should default memberCount to 0 when count row is missing', async () => {
    const mockMemberships = [
      {
        orgId: 'org-99',
        userId: 'user-1',
        role: 'MEMBER',
        organization: {
          id: 'org-99',
          name: 'Ghost Org',
          slug: 'ghost-org',
          description: null,
          avatarUrl: null,
          ownerId: 'someone',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
    ];

    vi.mocked(db.query.orgMembers.findMany).mockResolvedValue(mockMemberships as any);

    // Return empty count rows -- no matching count for org-99
    const mockGroupBy = vi.fn().mockResolvedValue([]);
    const mockWhere = vi.fn().mockReturnValue({ groupBy: mockGroupBy });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    vi.mocked(db.select).mockReturnValue({ from: mockFrom } as any);

    const result = await listUserOrganizations('user-1');

    expect(result[0]!.memberCount).toBe(0);
  });
});

// ============================================================================
// removeOrgMember
// ============================================================================

describe('removeOrgMember', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should delete the membership for the given org and user', async () => {
    const mockWhere = vi.fn().mockResolvedValue(undefined);
    vi.mocked(db.delete).mockReturnValue({ where: mockWhere } as any);

    await removeOrgMember('org-1', 'user-1');

    expect(db.delete).toHaveBeenCalledWith(orgMembers);
    expect(mockWhere).toHaveBeenCalled();
  });
});

// ============================================================================
// updateOrgMemberRole
// ============================================================================

describe('updateOrgMemberRole', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should update the role and return the updated membership', async () => {
    const updatedMember = {
      id: 'mem-1',
      orgId: 'org-1',
      userId: 'user-1',
      role: 'ADMIN',
      joinedAt: new Date(),
    };

    const mockReturning = vi.fn().mockResolvedValue([updatedMember]);
    const mockWhere = vi.fn().mockReturnValue({ returning: mockReturning });
    const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
    vi.mocked(db.update).mockReturnValue({ set: mockSet } as any);

    const result = await updateOrgMemberRole('org-1', 'user-1', 'ADMIN');

    expect(result).toEqual(updatedMember);
    expect(db.update).toHaveBeenCalledWith(orgMembers);
    expect(mockSet).toHaveBeenCalledWith({ role: 'ADMIN' });
  });

  it('should handle role change to MEMBER', async () => {
    const updatedMember = {
      id: 'mem-1',
      orgId: 'org-1',
      userId: 'user-2',
      role: 'MEMBER',
      joinedAt: new Date(),
    };

    const mockReturning = vi.fn().mockResolvedValue([updatedMember]);
    const mockWhere = vi.fn().mockReturnValue({ returning: mockReturning });
    const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
    vi.mocked(db.update).mockReturnValue({ set: mockSet } as any);

    const result = await updateOrgMemberRole('org-1', 'user-2', 'MEMBER');

    expect(result).toEqual(updatedMember);
    expect(mockSet).toHaveBeenCalledWith({ role: 'MEMBER' });
  });
});

// ============================================================================
// isOrgMember
// ============================================================================

describe('isOrgMember', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return true when the user is a member', async () => {
    vi.mocked(db.query.orgMembers.findFirst).mockResolvedValue({ id: 'mem-1' } as any);

    const result = await isOrgMember('org-1', 'user-1');

    expect(result).toBe(true);
  });

  it('should return false when the user is not a member', async () => {
    vi.mocked(db.query.orgMembers.findFirst).mockResolvedValue(undefined);

    const result = await isOrgMember('org-1', 'user-999');

    expect(result).toBe(false);
  });

  it('should query with the correct org and user ids', async () => {
    vi.mocked(db.query.orgMembers.findFirst).mockResolvedValue(undefined);

    await isOrgMember('org-42', 'user-7');

    expect(db.query.orgMembers.findFirst).toHaveBeenCalledWith({
      where: expect.anything(),
      columns: { id: true },
    });
  });
});
