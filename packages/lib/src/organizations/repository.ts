/**
 * Org persistence (Organizations & Wallets, Wave B3). IO only: every rule is
 * decided by a pure function in authorize.ts, membership.ts, invitations.ts or
 * deletion.ts, and this module stores the result.
 *
 * Invariant this module is the first writer of: organizations.ownerId and the
 * single OWNER org_members row always name the same user. Creation and ownership
 * transfer write both in ONE transaction.
 */
import { db } from '@pagespace/db/db';
import { and, asc, count, eq, isNull, sql } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import {
  organizations,
  orgInvitations,
  orgMembers,
  type Organization,
  type OrgRole,
} from '@pagespace/db/schema/organizations';
import { decryptUserRows, userEmailMatch } from '../auth/user-repository';
import { decideOrgOwnerCandidate, loadOrgPrincipalKind } from './owner-candidate';

const UNIQUE_VIOLATION = '23505';

/** drizzle 0.45 wraps driver errors; the Postgres SQLSTATE lives on `.cause`. */
export function pgErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export const isUniqueViolation = (error: unknown): boolean => pgErrorCode(error) === UNIQUE_VIOLATION;

export async function findMembershipRole(orgId: string, userId: string): Promise<OrgRole | null> {
  const [row] = await db
    .select({ role: orgMembers.role })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
    .limit(1);
  return row?.role ?? null;
}

export async function findOrganizationById(orgId: string): Promise<Organization | null> {
  const [row] = await db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
  return row ?? null;
}

export interface OrgSummaryForUser {
  id: string;
  name: string;
  slug: string;
  avatarUrl: string | null;
  role: OrgRole;
}

/** Every org the user belongs to, with their role (ORG-2: a user may belong to many). */
export async function listOrganizationsForUser(userId: string): Promise<OrgSummaryForUser[]> {
  return db
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      avatarUrl: organizations.avatarUrl,
      role: orgMembers.role,
    })
    .from(orgMembers)
    .innerJoin(organizations, eq(organizations.id, orgMembers.orgId))
    .where(eq(orgMembers.userId, userId))
    .orderBy(asc(organizations.name))
    .limit(500);
}

export interface OrgMemberDetail {
  userId: string;
  role: OrgRole;
  joinedAt: Date;
  name: string;
  email: string;
  image: string | null;
}

export async function listOrgMembers(orgId: string): Promise<OrgMemberDetail[]> {
  const rows = await db
    .select({
      userId: orgMembers.userId,
      role: orgMembers.role,
      joinedAt: orgMembers.joinedAt,
      name: users.name,
      email: users.email,
      image: users.image,
    })
    .from(orgMembers)
    .innerJoin(users, eq(users.id, orgMembers.userId))
    .where(eq(orgMembers.orgId, orgId))
    .orderBy(asc(orgMembers.joinedAt))
    .limit(5000);
  return decryptUserRows(rows);
}

/** Whether a user holding this email address is already a member of the org. */
export async function isEmailAMember(
  orgId: string,
  email: string,
  executor: Pick<typeof db, 'select'> = db,
): Promise<boolean> {
  const [row] = await executor
    .select({ userId: orgMembers.userId })
    .from(orgMembers)
    .innerJoin(users, eq(users.id, orgMembers.userId))
    .where(and(eq(orgMembers.orgId, orgId), userEmailMatch(email)))
    .limit(1);
  return row !== undefined;
}

/**
 * Seats held by the org (SEAT-3 input): accepted members plus LIVE pending
 * invites. An expired invite never holds a seat. Guests, agents and apps are not
 * org_members rows, so they never count. The Stripe quantity is Wave C.
 */
export async function countOrgSeats(orgId: string): Promise<number> {
  const [members] = await db.select({ n: count() }).from(orgMembers).where(eq(orgMembers.orgId, orgId));
  const [invites] = await db
    .select({ n: count() })
    .from(orgInvitations)
    .where(
      and(
        eq(orgInvitations.orgId, orgId),
        isNull(orgInvitations.acceptedAt),
        sql`${orgInvitations.expiresAt} > (now() at time zone 'utc')`,
      ),
    );
  return Number(members?.n ?? 0) + Number(invites?.n ?? 0);
}

export type CreateOrganizationResult =
  | { ok: true; organization: Organization }
  | { ok: false; reason: 'slug_taken' | 'owner_not_human' | 'owner_not_found' };

/**
 * ORG-1: the org row and its OWNER membership are written together or not at all,
 * and only for a person (an agent never becomes an Owner).
 */
export async function createOrganization(input: {
  name: string;
  slug: string;
  avatarUrl?: string | null;
  ownerId: string;
}): Promise<CreateOrganizationResult> {
  try {
    const result = await db.transaction(async (tx): Promise<CreateOrganizationResult> => {
      const candidate = decideOrgOwnerCandidate(await loadOrgPrincipalKind(tx, input.ownerId));
      if (!candidate.ok) return { ok: false, reason: candidate.reason };
      const [org] = await tx
        .insert(organizations)
        .values({ name: input.name, slug: input.slug, avatarUrl: input.avatarUrl ?? null, ownerId: input.ownerId })
        .returning();
      await tx.insert(orgMembers).values({ orgId: org.id, userId: input.ownerId, role: 'OWNER' });
      return { ok: true, organization: org };
    });
    return result;
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, reason: 'slug_taken' };
    throw error;
  }
}

export type UpdateOrganizationResult =
  | { ok: true; organization: Organization }
  | { ok: false; reason: 'not_found' | 'slug_taken' };

export async function updateOrganization(
  orgId: string,
  patch: { name?: string; slug?: string; avatarUrl?: string | null },
): Promise<UpdateOrganizationResult> {
  try {
    const [organization] = await db.update(organizations).set(patch).where(eq(organizations.id, orgId)).returning();
    return organization ? { ok: true, organization } : { ok: false, reason: 'not_found' };
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, reason: 'slug_taken' };
    throw error;
  }
}
