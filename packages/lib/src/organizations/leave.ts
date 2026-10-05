/**
 * Leaving an organization, and the cascade account deletion runs through (Spec O-7, O-8, ORG-6).
 *
 * A person who leaves an org takes with them everything their org membership let them hand out
 * inside org drives: the org-sourced drive_members rows, agent memberships they granted, share
 * links they created, and the drive rows of their own MCP tokens. Drives they lead are not
 * theirs to take: each is reassigned to the org Owner with an audit event, because
 * drives.ownerId is ON DELETE CASCADE and a lead's account deletion would otherwise hard-delete
 * the org drive.
 *
 * Nothing outside the org's drives is touched: a person's rows in personal drives, or in other
 * orgs' drives, survive leaving this one.
 *
 * Account deletion calls leaveAllOrganizations inside its own transaction BEFORE the users row
 * is deleted (account-repository.deleteUser).
 */

import { db } from '@pagespace/db/db';
import { and, asc, eq, inArray, isNotNull, isNull, ne, not, or, sql } from '@pagespace/db/operators';
import { drives, pages } from '@pagespace/db/schema/core';
import { driveAgentMembers, driveMembers, mcpTokenDrives } from '@pagespace/db/schema/members';
import { mcpTokens } from '@pagespace/db/schema/auth';
import { oauthAccessTokens, oauthRefreshTokens } from '@pagespace/db/schema/oauth';
import { driveShareLinks, pageShareLinks } from '@pagespace/db/schema/share-links';
import { orgMemberDepartures, orgMembers, organizations, type OrgDepartureReason, type OrgRole } from '@pagespace/db/schema/organizations';
import { driveEnvs } from '@pagespace/db/schema/drive-envs';
import { publishedApps } from '@pagespace/db/schema/published-apps';
import { walletConsumerCaps, wallets } from '@pagespace/db/schema/wallets';
import { userConsumerKey } from '../billing/wallet-core';
import { holdOrgGuestsUnderPolicy } from '../permissions/guest-holds';
import { recordOrgAuditEvent } from '../audit/org-audit';
import { getActorInfo, logActivityWithTx } from '../monitoring/activity-logger';
import { parseScopeList } from '../auth/oauth/scopes';
import { closeStaleDriveJoinRequests } from '../permissions/drive-join-request-closure';
import { recordLeaveEvents } from './org-events';
import { recordDepartureSuppression } from './departure-suppression';
import { disableDepartedCreatorAutomations, recordOwnerLeftAutomations, type OwnerLeftAutomation } from './automation-ownership';

/** A Drizzle transaction handle. */
export type LeaveTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// ── Pure decisions ────────────────────────────────────────────────────────────

export type LeaveRefusal = 'NOT_A_MEMBER' | 'OWNER_MUST_TRANSFER';

export type LeaveDecision = { ok: true } | { ok: false; reason: LeaveRefusal };

/**
 * Whether a membership may leave. The Owner cannot: an org always has one human Owner (ORG-1),
 * and the Owner is where every departing lead's drives land (O-7). Ownership transfers first.
 */
export function decideLeave(membership: { role: OrgRole } | null): LeaveDecision {
  if (!membership) return { ok: false, reason: 'NOT_A_MEMBER' };
  if (membership.role === 'OWNER') return { ok: false, reason: 'OWNER_MUST_TRANSFER' };
  return { ok: true };
}

export interface LedOrgDrive {
  driveId: string;
  orgId: string;
  orgOwnerId: string;
}

export interface LeadReassignment {
  driveId: string;
  orgId: string;
  fromUserId: string;
  toUserId: string;
}

/** Each org drive the departing user leads goes to its org's Owner (O-7). */
export function planLeadReassignments(userId: string, ledDrives: LedOrgDrive[]): LeadReassignment[] {
  return ledDrives
    .filter((d) => d.orgOwnerId !== userId)
    .map((d) => ({ driveId: d.driveId, orgId: d.orgId, fromUserId: userId, toUserId: d.orgOwnerId }));
}

// ── IO ────────────────────────────────────────────────────────────────────────

export type LeadReassignmentReason = 'left_org' | 'account_deleted';

export interface LeaveActor {
  actorEmail: string;
  actorDisplayName?: string;
}

export interface ReassignLedOrgDrivesOptions {
  /** Limit to one org's drives (leaving one org). Omitted: every org drive the user leads. */
  orgId?: string;
  reason?: LeadReassignmentReason;
  /** Actor snapshot for the audit event; resolved from the user when omitted. */
  actor?: LeaveActor;
}

/**
 * Reassign every org drive `userId` leads (trashed ones included) to that org's Owner, writing
 * an `ownership_transfer` activity event per drive in the same transaction, and removing the
 * former lead's OWNER self-heal row on each (it was never an invitation). Rows are locked
 * FOR UPDATE, drive and org together, so a concurrent ownership transfer cannot leave a drive
 * with the previous Owner as its lead.
 */
export async function reassignLedOrgDrives(
  userId: string,
  tx: LeaveTx,
  options: ReassignLedOrgDrivesOptions = {},
): Promise<LeadReassignment[]> {
  // Org rows before drive rows, the order joins, moves and org deletion lock in (a joined
  // FOR UPDATE takes them in whatever order the plan reads them). The org rows are share-locked,
  // which still keeps their Owner fixed while drives are reassigned to them.
  const ledOrgs = await tx
    .selectDistinct({ orgId: drives.orgId })
    .from(drives)
    .where(and(
      eq(drives.ownerId, userId),
      isNotNull(drives.orgId),
      options.orgId ? eq(drives.orgId, options.orgId) : undefined,
    ));
  const orgIds = ledOrgs.flatMap((row) => (row.orgId === null ? [] : [row.orgId]));
  if (orgIds.length === 0) return [];
  await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(inArray(organizations.id, orgIds))
    .orderBy(asc(organizations.id))
    .for('share');

  const led = await tx
    .select({ driveId: drives.id, orgId: organizations.id, orgOwnerId: organizations.ownerId })
    .from(drives)
    .innerJoin(organizations, eq(drives.orgId, organizations.id))
    .where(and(eq(drives.ownerId, userId), inArray(drives.orgId, orgIds)))
    .orderBy(asc(drives.id))
    .for('update', { of: drives });

  const plan = planLeadReassignments(userId, led);
  if (plan.length === 0) return [];

  const actor = options.actor ?? (await getActorInfo(userId));
  const reason = options.reason ?? 'left_org';

  for (const r of plan) {
    await tx.update(drives).set({ ownerId: r.toUserId }).where(eq(drives.id, r.driveId));
    await tx.delete(driveMembers).where(and(
      eq(driveMembers.driveId, r.driveId),
      eq(driveMembers.userId, r.fromUserId),
      eq(driveMembers.role, 'OWNER'),
    ));
    await logActivityWithTx(
      {
        userId,
        actorEmail: actor.actorEmail,
        actorDisplayName: actor.actorDisplayName,
        operation: 'ownership_transfer',
        resourceType: 'drive',
        resourceId: r.driveId,
        driveId: r.driveId,
        previousValues: { ownerId: r.fromUserId },
        newValues: { ownerId: r.toUserId },
        metadata: { orgId: r.orgId, reason },
      },
      tx as unknown as typeof db,
    );
  }

  return plan;
}

/** What a person's org membership let them hand out in some org drives, revoked. */
export interface OrgDriveGrantCounts {
  agentMemberships: number;
  driveShareLinks: number;
  pageShareLinks: number;
  mcpTokenDriveRows: number;
  /** OAuth token families (every access and refresh token in each) whose scopes name one of the drives. */
  oauthTokenFamilies: number;
}

/**
 * Revoke, inside `tx`, everything `userId` handed out in `driveIds`: agent memberships they granted,
 * drive and page share links they created, their MCP keys' drive rows, and every OAuth grant of
 * theirs that names one of the drives. An OAuth drive scope has no row to delete (it lives in the
 * token's scope list, and an explicit role in it is never re-checked), so its whole token family is
 * revoked: the client re-authorizes for what the person can still grant. Shared by leave, removal
 * (which is a leave) and demotion.
 */
export function revokeOrgDriveGrants(tx: LeaveTx, userId: string, driveIds: string[]): Promise<OrgDriveGrantCounts> {
  return revokeOrgDriveGrantsForMembers(tx, { userIds: [userId], driveIds, keep: [] });
}

/** A (person, drive) pair whose grants stay, e.g. the person who ends up owning the drive. */
export interface KeptDriveGrant {
  userId: string;
  driveId: string;
}

type KeyColumn = Parameters<typeof eq>[0];

/** Ids per statement: two id lists plus the kept pairs stay far under Postgres's 65,535 bind parameters. */
const GRANT_CHUNK = 500;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * revokeOrgDriveGrants for many people at once (org deletion is every member leaving): what each of
 * `userIds` handed out in each of `driveIds`, except the `keep` pairs. Set-based, one statement per
 * artifact kind per chunk, so the cost does not grow with members × drives in round trips.
 */
export async function revokeOrgDriveGrantsForMembers(
  tx: LeaveTx,
  { userIds, driveIds, keep }: { userIds: readonly string[]; driveIds: readonly string[]; keep: readonly KeptDriveGrant[] },
): Promise<OrgDriveGrantCounts> {
  const counts: OrgDriveGrantCounts = { agentMemberships: 0, driveShareLinks: 0, pageShareLinks: 0, mcpTokenDriveRows: 0, oauthTokenFamilies: 0 };
  if (userIds.length === 0 || driveIds.length === 0) return counts;

  for (const driveChunk of chunks(driveIds, GRANT_CHUNK)) {
    const inChunk = new Set(driveChunk);
    const kept = keep.filter((k) => inChunk.has(k.driveId));
    for (const userChunk of chunks(userIds, GRANT_CHUNK)) {
      /** Not one of the kept (drive, person) pairs; undefined when nothing is kept. */
      const notKept = (driveCol: KeyColumn, userCol: KeyColumn) =>
        kept.length === 0 ? undefined : not(or(...kept.map((k) => and(eq(driveCol, k.driveId), eq(userCol, k.userId))))!);

      // An agent whose home is the drive itself is not a grant on it (revokeAgentMembershipsGrantedBy).
      counts.agentMemberships += (await tx
        .delete(driveAgentMembers)
        .where(inArray(driveAgentMembers.id, tx
          .select({ id: driveAgentMembers.id })
          .from(driveAgentMembers)
          .innerJoin(pages, eq(driveAgentMembers.agentPageId, pages.id))
          .where(and(
            inArray(driveAgentMembers.driveId, driveChunk),
            inArray(driveAgentMembers.addedBy, userChunk),
            ne(pages.driveId, driveAgentMembers.driveId),
            notKept(driveAgentMembers.driveId, driveAgentMembers.addedBy),
          ))))
        .returning({ id: driveAgentMembers.id })).length;

      counts.driveShareLinks += (await tx
        .delete(driveShareLinks)
        .where(and(
          inArray(driveShareLinks.driveId, driveChunk),
          inArray(driveShareLinks.createdBy, userChunk),
          notKept(driveShareLinks.driveId, driveShareLinks.createdBy),
        ))
        .returning({ id: driveShareLinks.id })).length;

      counts.pageShareLinks += (await tx
        .delete(pageShareLinks)
        .where(inArray(pageShareLinks.id, tx
          .select({ id: pageShareLinks.id })
          .from(pageShareLinks)
          .innerJoin(pages, eq(pageShareLinks.pageId, pages.id))
          .where(and(
            inArray(pages.driveId, driveChunk),
            inArray(pageShareLinks.createdBy, userChunk),
            notKept(pages.driveId, pageShareLinks.createdBy),
          ))))
        .returning({ id: pageShareLinks.id })).length;

      counts.mcpTokenDriveRows += (await tx
        .delete(mcpTokenDrives)
        .where(inArray(mcpTokenDrives.id, tx
          .select({ id: mcpTokenDrives.id })
          .from(mcpTokenDrives)
          .innerJoin(mcpTokens, eq(mcpTokenDrives.tokenId, mcpTokens.id))
          .where(and(
            inArray(mcpTokenDrives.driveId, driveChunk),
            inArray(mcpTokens.userId, userChunk),
            notKept(mcpTokenDrives.driveId, mcpTokens.userId),
          ))))
        .returning({ id: mcpTokenDrives.id })).length;
    }
  }

  counts.oauthTokenFamilies = await revokeOAuthFamiliesNamingDrives(tx, userIds, driveIds, keep);
  return counts;
}

/** The OAuth token families of `userIds` with a live token whose scopes name one of their revoked drives. */
async function revokeOAuthFamiliesNamingDrives(
  tx: LeaveTx,
  userIds: readonly string[],
  driveIds: readonly string[],
  keep: readonly KeptDriveGrant[],
): Promise<number> {
  const keptFor = new Map<string, Set<string>>();
  for (const k of keep) keptFor.set(k.userId, (keptFor.get(k.userId) ?? new Set()).add(k.driveId));
  const revokedFor = (userId: string): ReadonlySet<string> => {
    const kept = keptFor.get(userId);
    return new Set(kept ? driveIds.filter((id) => !kept.has(id)) : driveIds);
  };

  const families = new Set<string>();
  for (const userChunk of chunks(userIds, GRANT_CHUNK)) {
    // One connection holds a transaction: read sequentially.
    const accessTokens = await tx.select({ userId: oauthAccessTokens.userId, familyId: oauthAccessTokens.familyId, scopes: oauthAccessTokens.scopes })
      .from(oauthAccessTokens)
      .where(and(inArray(oauthAccessTokens.userId, userChunk), isNull(oauthAccessTokens.revokedAt)));
    const refreshTokens = await tx.select({ userId: oauthRefreshTokens.userId, familyId: oauthRefreshTokens.familyId, scopes: oauthRefreshTokens.scopes })
      .from(oauthRefreshTokens)
      .where(and(inArray(oauthRefreshTokens.userId, userChunk), isNull(oauthRefreshTokens.revokedAt)));
    for (const t of [...accessTokens, ...refreshTokens]) {
      if (scopesNameDrive(t.scopes, revokedFor(t.userId))) families.add(t.familyId);
    }
  }
  if (families.size === 0) return 0;

  const now = new Date();
  for (const familyIds of chunks([...families], GRANT_CHUNK)) {
    await tx.update(oauthRefreshTokens)
      .set({ revokedAt: now, revokedReason: ORG_ACCESS_REVOKED })
      .where(and(inArray(oauthRefreshTokens.familyId, familyIds), isNull(oauthRefreshTokens.revokedAt)));
    await tx.update(oauthAccessTokens)
      .set({ revokedAt: now, revokedReason: ORG_ACCESS_REVOKED })
      .where(and(inArray(oauthAccessTokens.familyId, familyIds), isNull(oauthAccessTokens.revokedAt)));
  }
  return families.size;
}

const ORG_ACCESS_REVOKED = 'org_access_revoked';

/** Whether a stored scope list grants a drive scope on one of `driveIds`. Unparseable lists never resolve, so they name nothing. */
export function scopesNameDrive(scopes: string[], driveIds: ReadonlySet<string>): boolean {
  const parsed = parseScopeList(scopes.join(' '));
  return parsed.ok && [...parsed.scopes.drives.keys()].some((id) => driveIds.has(id));
}

export interface LeaveCascadeCounts extends OrgDriveGrantCounts {
  orgMembershipRows: number;
  /** OWNER self-heal rows on the org's drives, left by drives the leaver leads or once led. */
  formerLeadOwnerRows: number;
}

export type LeaveOrganizationResult =
  | {
    ok: true;
    revoked: LeaveCascadeCounts;
    reassigned: LeadReassignment[];
    computeReattributed: ComputeReattribution[];
    /** [D-OW-36] Their automations in the org's drives, disabled and flagged for an Owner or Admin. */
    automationsOwnerLeft: OwnerLeftAutomation[];
    /** Drives where the person's remaining access was parked or queued as a guest's (POL-2). */
    heldAsGuest: number;
  }
  | { ok: false; reason: LeaveRefusal };

/**
 * [D-OW-28] An environment or published app in one of the org's drives whose compute counted
 * against the leaver's per-member cap, now handed to the drive's LEAD (its `costOwnerId` cleared):
 * the lead is accountable for the drive, and the resource keeps running for everyone else in it.
 */
export interface ComputeReattribution {
  orgId: string;
  kind: 'drive_env' | 'published_app';
  id: string;
  driveId: string;
  /** Who it was attributed to: the member who left. */
  formerCostOwnerId: string;
  /** Why, when it is not a departure from the org: removed from the drive (review #2760 P3-4). */
  reason?: 'removed_from_drive';
}

/**
 * [D-OW-28] Record each re-attribution as an `org.compute.reattributed` event. Called AFTER the
 * leave's transaction commits (the audit chain is written outside it), so a rolled-back leave
 * never leaves an event behind. Ids only, never names.
 */
export async function recordComputeReattributions(items: readonly ComputeReattribution[], actorId?: string): Promise<void> {
  for (const item of items) {
    await recordOrgAuditEvent({
      orgId: item.orgId,
      eventType: 'org.compute.reattributed',
      ...(actorId ? { actorId } : {}),
      resourceType: item.kind,
      resourceId: item.id,
      driveId: item.driveId,
      details: { formerCostOwnerId: item.formerCostOwnerId, costOwner: 'drive_lead', ...(item.reason ? { reason: item.reason } : {}) },
    });
  }
}

export interface LeaveOrganizationOptions {
  reason?: LeadReassignmentReason;
  actor?: LeaveActor;
  /** Collects every [D-OW-28] re-attribution a caller holding the transaction must audit after commit. */
  collectReattributed?: ComputeReattribution[];
  /** Collects every [D-OW-36] owner-left automation a caller holding the transaction must audit after commit. */
  collectOwnerLeft?: OwnerLeftAutomation[];
  /** How the membership ended, as org_member_departures records it; default 'left' ('account_deleted' with that reason). */
  departure?: OrgDepartureReason;
}

/**
 * Remove `userId` from `orgId` and revoke what the membership let them hand out in the org's
 * drives (O-8), reassigning drives they lead (O-7). Runs in `tx` when given, else in its own
 * transaction. Refusals change nothing.
 */
export async function leaveOrganization(
  userId: string,
  orgId: string,
  tx?: LeaveTx,
  options: LeaveOrganizationOptions = {},
): Promise<LeaveOrganizationResult> {
  if (!tx) {
    const result = await db.transaction((own) => leaveOrganization(userId, orgId, own, options));
    // Inside a caller's transaction (removal, account deletion) the caller records the event, and the
    // [D-OW-28] re-attributions, once ITS transaction commits.
    if (result.ok) {
      await recordLeaveEvents({ orgId, userId, actorId: userId, eventType: 'org.member.left', reason: options.reason, reassigned: result.reassigned });
      await recordComputeReattributions(result.computeReattributed);
      await recordOwnerLeftAutomations(result.automationsOwnerLeft, userId);
    }
    return result;
  }

  const [membership] = await tx
    .select({ id: orgMembers.id, role: orgMembers.role })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
    .for('update');

  const decision = decideLeave(membership ?? null);
  if (!decision.ok) return decision;

  const orgDriveIds = tx.select({ id: drives.id }).from(drives).where(eq(drives.orgId, orgId));

  const memberRows = await tx
    .delete(driveMembers)
    .where(and(
      eq(driveMembers.userId, userId),
      eq(driveMembers.source, 'org'),
      inArray(driveMembers.driveId, orgDriveIds),
    ))
    .returning({ id: driveMembers.id });

  const driveRows = await tx.select({ id: drives.id }).from(drives).where(eq(drives.orgId, orgId));
  const grants = await revokeOrgDriveGrants(tx, userId, driveRows.map((d) => d.id));

  // A lead's OWNER self-heal row is not a membership: on an org drive it outlives the lead, so
  // it goes with them, whether they lead the drive now (reassigned below) or led it once.
  const ownerRows = await tx
    .delete(driveMembers)
    .where(and(
      eq(driveMembers.userId, userId),
      eq(driveMembers.role, 'OWNER'),
      inArray(driveMembers.driveId, orgDriveIds),
    ))
    .returning({ id: driveMembers.id });

  const reassigned = await reassignLedOrgDrives(userId, tx, {
    orgId,
    reason: options.reason,
    actor: options.actor,
  });

  // [D-OW-28] Their environments and apps in the org's drives keep running — deleting or pausing
  // them would break the drive for everyone else — but their costs go to the drive's lead (a
  // cleared costOwnerId), counted against the lead's cap from now on.
  const envRows = await tx
    .update(driveEnvs)
    .set({ costOwnerId: null })
    .where(and(eq(driveEnvs.costOwnerId, userId), inArray(driveEnvs.driveId, orgDriveIds)))
    .returning({ id: driveEnvs.id, driveId: driveEnvs.driveId });
  const appRows = await tx
    .update(publishedApps)
    .set({ costOwnerId: null })
    .where(and(eq(publishedApps.costOwnerId, userId), inArray(publishedApps.driveId, orgDriveIds)))
    .returning({ id: publishedApps.id, driveId: publishedApps.driveId });
  const computeReattributed: ComputeReattribution[] = [
    ...envRows.map((r) => ({ orgId, kind: 'drive_env' as const, id: r.id, driveId: r.driveId, formerCostOwnerId: userId })),
    ...appRows.map((r) => ({ orgId, kind: 'published_app' as const, id: r.id, driveId: r.driveId, formerCostOwnerId: userId })),
  ];
  options.collectReattributed?.push(...computeReattributed);

  // [D-OW-36] Their workflows, triggers and page webhooks in the org's drives are not theirs to take:
  // the rest of the drive relies on them. Each is disabled and flagged owner-left, never deleted, and
  // nothing runs under them until an Owner or Admin reassigns or deletes it.
  const automationsOwnerLeft = await disableDepartedCreatorAutomations(tx, {
    userId,
    orgId,
    reason: options.reason === 'account_deleted' ? 'account_deleted' : 'left_org',
  });
  options.collectOwnerLeft?.push(...automationsOwnerLeft);

  await tx.delete(orgMembers).where(eq(orgMembers.id, membership.id));
  // POL-2 (Review #2762 P2-8): with the membership gone the person is an OUTSIDER of the org's drives, and the
  // invited (`source: 'invite'`) rows and page grants they kept are guest access like any other. The org's guests
  // policy decides them now, in this transaction: off parks them, approve queues them, on leaves them.
  const heldAsGuest = await holdOrgGuestsUnderPolicy(tx, { orgId, userId });
  // SEC-1: the org remembers that this person left, however they had joined, in the same transaction
  // as the delete. This is the ONE place a membership ends (a seam test keeps it that way), so a
  // verified domain can never auto-join someone back who left or was removed.
  const departure: OrgDepartureReason = options.departure ?? (options.reason === 'account_deleted' ? 'account_deleted' : 'left');
  await tx
    .insert(orgMemberDepartures)
    .values({ orgId, userId, reason: departure })
    .onConflictDoUpdate({
      target: [orgMemberDepartures.orgId, orgMemberDepartures.userId],
      set: { reason: departure, departedAt: sql`(now() at time zone 'utc')` },
    });
  // [D-OW-27] and the mailbox, keyed and hashed, in the same transaction: a second account on it (or a
  // +subaddress of it) is not auto-joined back either. Removed and voluntary leavers alike.
  await recordDepartureSuppression(tx, orgId, userId);
  // DRV-6: the leaver's pending join requests on the org's drives ask for nothing now (nor does one
  // by a reassigned drive's new lead); approvers stop seeing them.
  await closeStaleDriveJoinRequests(tx, driveRows.map((d) => d.id));
  // WAL-7: the leaver's per-consumer caps on the org's legs (the pool's seat leg and its drive
  // wallets) go with the membership, so a later re-join starts from the org's defaults.
  await tx.delete(walletConsumerCaps).where(and(
    eq(walletConsumerCaps.consumerKey, userConsumerKey(userId)),
    inArray(walletConsumerCaps.walletId, tx.select({ id: wallets.id }).from(wallets).where(eq(wallets.orgId, orgId))),
  ));

  return {
    ok: true,
    revoked: {
      orgMembershipRows: memberRows.length,
      ...grants,
      formerLeadOwnerRows: ownerRows.length,
    },
    reassigned,
    computeReattributed,
    automationsOwnerLeft,
    heldAsGuest: heldAsGuest.length,
  };
}

export class LeaveOrganizationRefusedError extends Error {
  constructor(readonly orgId: string, readonly reason: LeaveRefusal) {
    super(`Cannot leave organization ${orgId}: ${reason}`);
    this.name = 'LeaveOrganizationRefusedError';
  }
}

/**
 * Leave every org `userId` belongs to, inside `tx`. Throws LeaveOrganizationRefusedError on the
 * first refusal (an Owner), so the caller's transaction rolls back: account deletion must not
 * proceed half-cascaded.
 */
export interface LeftOrganization {
  orgId: string;
  reassigned: LeadReassignment[];
}

export async function leaveAllOrganizations(
  userId: string,
  tx: LeaveTx,
  options: LeaveOrganizationOptions = {},
): Promise<LeftOrganization[]> {
  const memberships = await tx
    .select({ orgId: orgMembers.orgId })
    .from(orgMembers)
    .where(eq(orgMembers.userId, userId))
    // Deterministic order, so a refusal part-way through is reproducible (the caller's
    // transaction rolls back whatever earlier orgs already applied).
    .orderBy(orgMembers.joinedAt, orgMembers.id);

  const left: LeftOrganization[] = [];
  for (const { orgId } of memberships) {
    const result = await leaveOrganization(userId, orgId, tx, options);
    if (!result.ok) throw new LeaveOrganizationRefusedError(orgId, result.reason);
    left.push({ orgId, reassigned: result.reassigned });
  }
  return left;
}
