/**
 * Join requests for Restricted org drives (Spec DRV-6, D-OW-22): request, approve, deny, withdraw,
 * and the approver's list of pending requests.
 *
 * The decisions are pure (permissions/drive-join-requests.ts); this module is the IO edge. Each
 * mutation runs in one transaction that share-locks the org row and locks the drive row (the order
 * every org-drive path locks in), then reads the actor's and the requester's org roles, the
 * requester's drive_members row and the request under those locks, so a concurrent visibility
 * change, leave or second answer is seen before anything is written.
 *
 * A request grants nothing. Approval is the ONLY path from a request to membership, and it goes
 * through the org membership sync (admitDriveJoiner), never by hand.
 */

import { db } from '@pagespace/db/db';
import { and, asc, eq, sql } from '@pagespace/db/operators';
import { drives, type OrgDriveVisibility } from '@pagespace/db/schema/core';
import { users } from '@pagespace/db/schema/auth';
import { driveJoinRequests, type DriveJoinRequest } from '@pagespace/db/schema/drive-join-requests';
import { organizations, orgMembers, type OrgRole } from '@pagespace/db/schema/organizations';
import { requireOrgRole } from '../organizations/authorize';
import { retryOnDeadlock } from '../organizations/repository';
import { decryptUserRows } from '../auth/user-repository';
import {
  decideJoinRequest,
  decideJoinRequestApprover,
  decideJoinRequestDecision,
  decideJoinRequestWithdrawal,
  type JoinDrive,
  type JoinRequestRefusal,
} from '../permissions/drive-join-requests';
import { loadDriveMemberRowState } from '../permissions/org-drive-membership';
import { admitDriveJoiner, publishOrgMembershipSyncEvents, type OrgMembershipSyncResult } from './org-membership-sync';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type LockedDrive = JoinDrive & { id: string; name: string };

/** Longest note a requester may attach, in characters. */
export const JOIN_REQUEST_MESSAGE_MAX = 500;

/**
 * Share-lock the drive's org, then lock the drive (org before drive, as moves, joins and org
 * deletion lock). Null when the drive is missing, or changed org between the read and the lock.
 */
async function lockOrgDrive(tx: Tx, driveId: string): Promise<LockedDrive | null> {
  const [current] = await tx.select({ orgId: drives.orgId }).from(drives).where(eq(drives.id, driveId));
  if (!current) return null;
  if (current.orgId !== null) {
    await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, current.orgId)).for('share');
  }
  const [drive] = await tx
    .select({ id: drives.id, name: drives.name, ownerId: drives.ownerId, orgId: drives.orgId, orgVisibility: drives.orgVisibility, isTrashed: drives.isTrashed })
    .from(drives)
    .where(eq(drives.id, driveId))
    .for('update');
  if (!drive || drive.orgId !== current.orgId) return null;
  return drive;
}

/**
 * A person's role in the org through the ONE org authorization function (ORG-5), with the
 * org_members row share-locked so a concurrent leave waits for this transaction.
 */
async function orgRoleOf(tx: Tx, orgId: string | null, userId: string): Promise<OrgRole | null> {
  if (orgId === null) return null;
  const authorization = await requireOrgRole(userId, orgId, 'MEMBER', {
    findMembershipRole: async (memberOrgId, memberUserId) => {
      const [row] = await tx
        .select({ role: orgMembers.role })
        .from(orgMembers)
        .where(and(eq(orgMembers.orgId, memberOrgId), eq(orgMembers.userId, memberUserId)))
        .for('share');
      return row?.role ?? null;
    },
  });
  return authorization.ok ? authorization.role : null;
}

async function lockRequest(tx: Tx, driveId: string, requestId: string): Promise<DriveJoinRequest | null> {
  const [request] = await tx
    .select()
    .from(driveJoinRequests)
    .where(and(eq(driveJoinRequests.id, requestId), eq(driveJoinRequests.driveId, driveId)))
    .for('update');
  return request ?? null;
}

const requestNotFound = (): JoinRequestRefusal => ({
  ok: false,
  code: 'REQUEST_NOT_FOUND',
  status: 404,
  message: 'Join request not found',
});

export type RequestToJoinResult =
  | { ok: true; created: boolean; request: DriveJoinRequest; drive: { id: string; name: string; orgId: string } }
  | JoinRequestRefusal;

/** Ask to join a Restricted drive. Idempotent: an open request is returned, never duplicated. */
export async function requestToJoinDrive(
  actorId: string,
  driveId: string,
  input: { message?: string | null } = {},
): Promise<RequestToJoinResult> {
  return retryOnDeadlock(() => db.transaction(async (tx): Promise<RequestToJoinResult> => {
    const drive = await lockOrgDrive(tx, driveId);
    const requesterOrgRole = drive ? await orgRoleOf(tx, drive.orgId, actorId) : null;
    const requesterRow = drive ? await loadDriveMemberRowState(tx, driveId, actorId) : null;
    const [open] = await tx
      .select()
      .from(driveJoinRequests)
      .where(and(eq(driveJoinRequests.driveId, driveId), eq(driveJoinRequests.userId, actorId), eq(driveJoinRequests.status, 'pending')))
      .limit(1);

    const verdict = decideJoinRequest({ drive, requesterId: actorId, requesterOrgRole, requesterRow, hasPendingRequest: open !== undefined });
    if (!verdict.ok) return verdict;
    if (!drive || drive.orgId === null) throw new Error('Unreachable: a join request was admitted for a drive outside any org');
    const target = { id: drive.id, name: drive.name, orgId: drive.orgId };
    if (verdict.action === 'existing') return { ok: true, created: false, request: open, drive: target };

    const message = input.message?.trim().slice(0, JOIN_REQUEST_MESSAGE_MAX) || null;
    const [created] = await tx
      .insert(driveJoinRequests)
      .values({ driveId, userId: actorId, message })
      .returning();
    return { ok: true, created: true, request: created, drive: target };
  }));
}

/** The drive a request was answered on, as the ORG-4 org-power audit needs it. */
export interface AnsweredDrive {
  id: string;
  name: string;
  ownerId: string;
  orgId: string;
  orgVisibility: OrgDriveVisibility;
}

export type JoinRequestAnswerResult =
  | {
      ok: true;
      action: 'approve' | 'deny';
      /** A drive_members row was written for the requester (approval of a non-member). */
      admitted: boolean;
      request: DriveJoinRequest;
      drive: AnsweredDrive;
    }
  | JoinRequestRefusal;

/**
 * Approve or deny a pending request. Approval admits the requester through the org membership
 * sync inside this transaction, and marks the request approved; the membership events are
 * published after commit.
 */
export async function answerDriveJoinRequest(
  actorId: string,
  driveId: string,
  requestId: string,
  decision: 'approve' | 'deny',
): Promise<JoinRequestAnswerResult> {
  const outcome = await retryOnDeadlock(() => db.transaction(async (tx) => {
    const drive = await lockOrgDrive(tx, driveId);
    const request = drive ? await lockRequest(tx, driveId, requestId) : null;
    if (!drive || !request) return { result: requestNotFound(), sync: null };

    const actorOrgRole = await orgRoleOf(tx, drive.orgId, actorId);
    const requesterOrgRole = await orgRoleOf(tx, drive.orgId, request.userId);
    const requesterRow = await loadDriveMemberRowState(tx, driveId, request.userId);
    const verdict = decideJoinRequestDecision({
      decision,
      actorId,
      actorOrgRole,
      drive,
      request: { userId: request.userId, status: request.status },
      requesterOrgRole,
      requesterRow,
    });
    if (!verdict.ok) return { result: verdict, sync: null };
    if (drive.orgId === null) throw new Error('Unreachable: a join request was answered on a drive outside any org');

    let sync: OrgMembershipSyncResult | null = null;
    let admitted = false;
    if (verdict.action === 'approve' && verdict.admit) {
      const admission = await admitDriveJoiner(driveId, request.userId, { tx, admittedBy: actorId });
      // The decision and the sync read the same facts under the same locks; disagreement is a bug,
      // and rolling back leaves the request pending rather than approved without a membership.
      if (!admission.admitted) throw new Error('Join request approval did not admit the requester');
      sync = admission;
      admitted = true;
    }

    const [answered] = await tx
      .update(driveJoinRequests)
      .set({
        status: verdict.action === 'approve' ? 'approved' : 'denied',
        decidedBy: actorId,
        decidedAt: sql`(now() at time zone 'utc')`,
      })
      .where(and(eq(driveJoinRequests.id, requestId), eq(driveJoinRequests.status, 'pending')))
      .returning();

    const result: JoinRequestAnswerResult = {
      ok: true,
      action: verdict.action,
      admitted,
      request: answered,
      drive: { id: drive.id, name: drive.name, ownerId: drive.ownerId, orgId: drive.orgId, orgVisibility: drive.orgVisibility },
    };
    return { result, sync };
  }));

  if (outcome.sync) await publishOrgMembershipSyncEvents(outcome.sync);
  return outcome.result;
}

export type WithdrawResult = { ok: true; request: DriveJoinRequest } | JoinRequestRefusal;

/** The requester takes back their own pending request; they may ask again later. */
export async function withdrawDriveJoinRequest(actorId: string, driveId: string, requestId: string): Promise<WithdrawResult> {
  return retryOnDeadlock(() => db.transaction(async (tx): Promise<WithdrawResult> => {
    const drive = await lockOrgDrive(tx, driveId);
    const request = drive ? await lockRequest(tx, driveId, requestId) : null;
    if (!request) return requestNotFound();

    const verdict = decideJoinRequestWithdrawal({ actorId, request: { userId: request.userId, status: request.status } });
    if (!verdict.ok) return verdict;

    const [withdrawn] = await tx
      .update(driveJoinRequests)
      .set({ status: 'withdrawn', decidedAt: sql`(now() at time zone 'utc')` })
      .where(and(eq(driveJoinRequests.id, requestId), eq(driveJoinRequests.status, 'pending')))
      .returning();
    return { ok: true, request: withdrawn };
  }));
}

export interface PendingJoinRequest {
  id: string;
  userId: string;
  name: string | null;
  email: string;
  image: string | null;
  message: string | null;
  requestedAt: Date;
}

/** Most pending requests an approver's list returns for one drive. */
const PENDING_LIST_LIMIT = 500;

/**
 * The pending requests on a drive, for someone who may answer them (its lead or an org Owner or
 * Admin). Anyone else gets the refusal the approval itself would give.
 */
export async function listPendingDriveJoinRequests(
  actorId: string,
  driveId: string,
): Promise<{ ok: true; requests: PendingJoinRequest[] } | JoinRequestRefusal> {
  const [drive] = await db
    .select({ ownerId: drives.ownerId, orgId: drives.orgId, orgVisibility: drives.orgVisibility, isTrashed: drives.isTrashed })
    .from(drives)
    .where(eq(drives.id, driveId))
    .limit(1);
  const actorOrgRole = drive?.orgId
    ? await (async () => {
        const decision = await requireOrgRole(actorId, drive.orgId as string, 'MEMBER');
        return decision.ok ? decision.role : null;
      })()
    : null;

  const authority = decideJoinRequestApprover({ actorId, actorOrgRole, drive: drive ?? null });
  if (!authority.ok) return authority;

  const rows = await db
    .select({
      id: driveJoinRequests.id,
      userId: driveJoinRequests.userId,
      message: driveJoinRequests.message,
      requestedAt: driveJoinRequests.requestedAt,
      name: users.name,
      email: users.email,
      image: users.image,
    })
    .from(driveJoinRequests)
    .innerJoin(users, eq(users.id, driveJoinRequests.userId))
    .where(and(eq(driveJoinRequests.driveId, driveId), eq(driveJoinRequests.status, 'pending')))
    .orderBy(asc(driveJoinRequests.requestedAt))
    .limit(PENDING_LIST_LIMIT);
  return { ok: true, requests: await decryptUserRows(rows) };
}
