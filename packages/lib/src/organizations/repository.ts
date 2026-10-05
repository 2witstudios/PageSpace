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
import { and, asc, count, eq, inArray, isNull, sql } from '@pagespace/db/operators';
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
import { recordOrgAuditEventAfterCommit } from '../audit/org-audit';

const UNIQUE_VIOLATION = '23505';

/**
 * An organization as the rest of the app sees it: every column EXCEPT `policies`. Policies are read only through
 * policy-reader.ts (Spec POL-1), so the record a route gets from here cannot carry them, and the seam guard
 * (policy-seam.test.ts) fails any whole-row read of the table that would.
 */
export type OrgRecord = Omit<Organization, 'policies'>;

const ORG_RECORD = {
  id: organizations.id,
  name: organizations.name,
  slug: organizations.slug,
  avatarUrl: organizations.avatarUrl,
  ownerId: organizations.ownerId,
  stripeCustomerId: organizations.stripeCustomerId,
  stripeSubscriptionId: organizations.stripeSubscriptionId,
  seatAutoAdd: organizations.seatAutoAdd,
  createdAt: organizations.createdAt,
  updatedAt: organizations.updatedAt,
} satisfies Record<keyof OrgRecord, unknown>;

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

const DEADLOCK_DETECTED = '40P01';

/**
 * Run a whole transaction again when Postgres picks it as a deadlock victim. Only for work that
 * rolls back completely and may simply be run again; any other error is rethrown at once.
 */
export async function retryOnDeadlock<T>(work: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (attempt >= attempts || pgErrorCode(error) !== DEADLOCK_DETECTED) throw error;
    }
  }
}

/**
 * The org whose own Stripe customer this is (SEAT-1: one per org, never a person's), or
 * null. The Stripe webhook's org routing reads it here, so no API route reads the org table.
 */
export async function findOrgIdByStripeCustomerId(customerId: string): Promise<string | null> {
  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.stripeCustomerId, customerId))
    .limit(1);
  return org?.id ?? null;
}

export async function findMembershipRole(orgId: string, userId: string): Promise<OrgRole | null> {
  const [row] = await db
    .select({ role: orgMembers.role })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
    .limit(1);
  return row?.role ?? null;
}

export async function findOrganizationById(orgId: string): Promise<OrgRecord | null> {
  const [row] = await db.select(ORG_RECORD).from(organizations).where(eq(organizations.id, orgId)).limit(1);
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
 * The parts of the seat count (SEAT-3): accepted members and LIVE pending invites. An
 * expired invite never holds a seat. Guests, agents and apps are not org_members rows, so
 * they never count; this reads only org_members and org_invitations. It takes an executor so
 * seat admission reads it inside its locked transaction.
 */
export async function countOrgSeatParts(
  orgId: string,
  executor: Pick<typeof db, 'select'> = db,
): Promise<{ members: number; pendingInvites: number }> {
  const [members] = await executor.select({ n: count() }).from(orgMembers).where(eq(orgMembers.orgId, orgId));
  const [invites] = await executor
    .select({ n: count() })
    .from(orgInvitations)
    .where(
      and(
        eq(orgInvitations.orgId, orgId),
        isNull(orgInvitations.acceptedAt),
        sql`${orgInvitations.expiresAt} > (now() at time zone 'utc')`,
      ),
    );
  return { members: Number(members?.n ?? 0), pendingInvites: Number(invites?.n ?? 0) };
}

/** Seats held by the org: members plus live pending invites (see countOrgSeatParts). */
export async function countOrgSeats(orgId: string): Promise<number> {
  const { members, pendingInvites } = await countOrgSeatParts(orgId);
  return members + pendingInvites;
}

export type CreateOrganizationResult =
  | { ok: true; organization: OrgRecord }
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
        .returning(ORG_RECORD);
      await tx.insert(orgMembers).values({ orgId: org.id, userId: input.ownerId, role: 'OWNER' });
      return { ok: true, organization: org };
    });
    if (result.ok) {
      await recordOrgAuditEventAfterCommit({
        orgId: result.organization.id,
        eventType: 'org.created',
        actorId: input.ownerId,
        resourceType: 'organization',
        resourceId: result.organization.id,
        details: { slug: result.organization.slug },
      });
    }
    return result;
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, reason: 'slug_taken' };
    throw error;
  }
}

export type UpdateOrganizationResult =
  | { ok: true; organization: OrgRecord }
  | { ok: false; reason: 'not_found' | 'slug_taken' };

export async function updateOrganization(
  orgId: string,
  patch: { name?: string; slug?: string; avatarUrl?: string | null },
  actorId?: string,
): Promise<UpdateOrganizationResult> {
  try {
    const [organization] = await db.update(organizations).set(patch).where(eq(organizations.id, orgId)).returning(ORG_RECORD);
    if (!organization) return { ok: false, reason: 'not_found' };
    await recordOrgAuditEventAfterCommit({
      orgId,
      eventType: 'org.updated',
      actorId,
      resourceType: 'organization',
      resourceId: orgId,
      details: { fields: Object.keys(patch).sort() },
    });
    return { ok: true, organization };
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, reason: 'slug_taken' };
    throw error;
  }
}

/**
 * Org names by id, for labels (wallet lists, spend choices, cap alerts — UI-8, UI-10, WAL-7): the
 * name column only, never the row (POL-1: policies are read through policy-reader alone).
 */
export async function findOrganizationNames(orgIds: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(orgIds)];
  if (unique.length === 0) return new Map();
  const rows = await db.select({ id: organizations.id, name: organizations.name }).from(organizations).where(inArray(organizations.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

