import {
  db,
  eq,
  and,
  organizations,
  orgMembers,
  users,
  userProfiles,
} from '@pagespace/db';
import { createId } from '@paralleldrive/cuid2';

// ============================================================================
// Types
// ============================================================================

export interface CreateOrgInput {
  name: string;
  slug: string;
  description?: string;
}

export interface UpdateOrgInput {
  name?: string;
  slug?: string;
  description?: string;
  avatarUrl?: string | null;
}

export interface OrgWithRole {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  avatarUrl: string | null;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  memberCount: number;
}

export interface OrgAccessResult {
  isOwner: boolean;
  isAdmin: boolean;
  isMember: boolean;
  org: typeof organizations.$inferSelect | null;
  role: 'OWNER' | 'ADMIN' | 'MEMBER' | null;
}

export interface OrgMemberWithDetails {
  id: string;
  userId: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  joinedAt: Date;
  user: {
    id: string;
    email: string;
    name: string;
  } | null;
  profile: {
    displayName: string | null;
    avatarUrl: string | null;
  } | null;
}

// ============================================================================
// Organization CRUD
// ============================================================================

export async function createOrganization(ownerId: string, input: CreateOrgInput) {
  const orgId = createId();

  const [org] = await db.insert(organizations).values({
    id: orgId,
    name: input.name,
    slug: input.slug,
    ownerId,
    description: input.description,
    updatedAt: new Date(),
  }).returning();

  // Add owner as OWNER member
  await db.insert(orgMembers).values({
    orgId: org.id,
    userId: ownerId,
    role: 'OWNER',
  });

  return org;
}

export async function getOrganizationById(orgId: string) {
  return db.query.organizations.findFirst({
    where: eq(organizations.id, orgId),
  });
}

export async function getOrganizationBySlug(slug: string) {
  return db.query.organizations.findFirst({
    where: eq(organizations.slug, slug),
  });
}

export async function updateOrganization(orgId: string, input: UpdateOrgInput) {
  const [updated] = await db.update(organizations)
    .set(input)
    .where(eq(organizations.id, orgId))
    .returning();
  return updated;
}

export async function deleteOrganization(orgId: string) {
  await db.delete(organizations).where(eq(organizations.id, orgId));
}

// ============================================================================
// Organization Access
// ============================================================================

export async function checkOrgAccess(orgId: string, userId: string): Promise<OrgAccessResult> {
  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, orgId),
  });

  if (!org) {
    return { isOwner: false, isAdmin: false, isMember: false, org: null, role: null };
  }

  const isOwner = org.ownerId === userId;
  if (isOwner) {
    return { isOwner: true, isAdmin: true, isMember: true, org, role: 'OWNER' };
  }

  const membership = await db.query.orgMembers.findFirst({
    where: and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)),
  });

  if (!membership) {
    return { isOwner: false, isAdmin: false, isMember: false, org, role: null };
  }

  return {
    isOwner: false,
    isAdmin: membership.role === 'ADMIN',
    isMember: true,
    org,
    role: membership.role,
  };
}

// ============================================================================
// Organization Members
// ============================================================================

export async function listOrgMembers(orgId: string): Promise<OrgMemberWithDetails[]> {
  const members = await db.query.orgMembers.findMany({
    where: eq(orgMembers.orgId, orgId),
    with: {
      user: {
        columns: { id: true, email: true, name: true },
      },
    },
  });

  // Fetch profiles for all member userIds
  const userIds = members.map(m => m.userId);
  const profiles = userIds.length > 0
    ? await db.query.userProfiles.findMany({
        where: (table, { inArray }) => inArray(table.userId, userIds),
        columns: { userId: true, displayName: true, avatarUrl: true },
      })
    : [];

  const profileMap = new Map(profiles.map(p => [p.userId, p]));

  return members.map(m => ({
    id: m.id,
    userId: m.userId,
    role: m.role,
    joinedAt: m.joinedAt,
    user: m.user,
    profile: profileMap.get(m.userId) ?? null,
  }));
}

export async function listUserOrganizations(userId: string): Promise<OrgWithRole[]> {
  const memberships = await db.query.orgMembers.findMany({
    where: eq(orgMembers.userId, userId),
    with: {
      organization: true,
    },
  });

  // Get member counts for each org
  const orgIds = memberships.map(m => m.orgId);
  const countResults = orgIds.length > 0
    ? await Promise.all(orgIds.map(async (orgId) => {
        const members = await db.query.orgMembers.findMany({
          where: eq(orgMembers.orgId, orgId),
          columns: { id: true },
        });
        return { orgId, count: members.length };
      }))
    : [];

  const countMap = new Map(countResults.map(r => [r.orgId, r.count]));

  return memberships.map(m => ({
    id: m.organization.id,
    name: m.organization.name,
    slug: m.organization.slug,
    description: m.organization.description,
    avatarUrl: m.organization.avatarUrl,
    ownerId: m.organization.ownerId,
    createdAt: m.organization.createdAt,
    updatedAt: m.organization.updatedAt,
    role: m.role,
    memberCount: countMap.get(m.orgId) ?? 0,
  }));
}

export async function removeOrgMember(orgId: string, userId: string) {
  await db.delete(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)));
}

export async function updateOrgMemberRole(
  orgId: string,
  userId: string,
  role: 'ADMIN' | 'MEMBER'
) {
  const [updated] = await db.update(orgMembers)
    .set({ role })
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
    .returning();
  return updated;
}

export async function isOrgMember(orgId: string, userId: string): Promise<boolean> {
  const member = await db.query.orgMembers.findFirst({
    where: and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)),
    columns: { id: true },
  });
  return !!member;
}
