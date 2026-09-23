import type { OrgDriveVisibility } from '@pagespace/db/schema/core';
import type { DriveMemberSource } from '@pagespace/db/schema/members';
import type { DriveJoinRequestStatus } from '@pagespace/db/schema/drive-join-requests';
import type { OrgRole } from '@pagespace/db/schema/organizations';
import type { DriveMemberRole } from './org-access';
import { decideDriveLeadAuthority, isDriveLead } from './drive-relationship';
import { validOrgDriveRow } from './org-drive-resolution';

/**
 * Restricted org drives (Spec DRV-6, D-OW-22): who may ask to join one, who may answer, and what
 * the org Drives directory shows each member. Pure decisions over facts the services fetch.
 *
 * A request grants NOTHING. It lives in drive_join_requests, never as a drive_members row, and
 * only an approval by the drive lead or an org Owner/Admin creates membership, through the org
 * membership sync. Every fact that can change between request and approval is re-checked at
 * approval: the drive is still Restricted, the requester is still in the org, and they did not
 * gain a pending invitation (which is theirs to accept, never ours).
 */

export interface JoinDrive {
  ownerId: string;
  orgId: string | null;
  orgVisibility: OrgDriveVisibility;
  isTrashed: boolean;
}

/** A person's drive_members row on the drive, accepted or still a pending invitation. */
export interface RequesterRow {
  /**
   * The membership the row carries (driveMembershipRole), or null for a row that is no drive
   * membership at all: a D-OW-24 GUEST row from a redeemed page share link. Such a row is neither
   * a membership nor an invitation, so its holder may request and be admitted like anyone else.
   */
  role: DriveMemberRole | null;
  source: DriveMemberSource;
  /** acceptedAt IS NOT NULL. */
  accepted: boolean;
}

export type JoinRequestRefusalCode =
  | 'DRIVE_NOT_FOUND'
  | 'REQUEST_NOT_FOUND'
  | 'ALREADY_MEMBER'
  | 'PENDING_INVITE'
  | 'NOT_APPROVER'
  | 'SELF_DECISION'
  | 'NOT_PENDING'
  | 'NOT_RESTRICTED'
  | 'REQUESTER_NOT_ORG_MEMBER';

export interface JoinRequestRefusal {
  ok: false;
  code: JoinRequestRefusalCode;
  status: 403 | 404 | 409;
  message: string;
}

const refuse = (code: JoinRequestRefusalCode, status: JoinRequestRefusal['status'], message: string): JoinRequestRefusal =>
  ({ ok: false, code, status, message });

const driveNotFound = () => refuse('DRIVE_NOT_FOUND', 404, 'Drive not found');
const requestNotFound = () => refuse('REQUEST_NOT_FOUND', 404, 'Join request not found');

/** An org drive a member of its org can see at all (not trashed). */
function isLiveOrgDrive(drive: JoinDrive | null): drive is JoinDrive & { orgId: string } {
  return drive !== null && drive.orgId !== null && !drive.isTrashed;
}

/**
 * Whether the person is already on the drive: its lead, or an accepted row that still means
 * something there (validOrgDriveRow drops a stale org row and a former lead's OWNER row). Implicit
 * Open membership is the caller's to add: it needs no row.
 */
function holdsMembership(userId: string, drive: JoinDrive, orgRole: OrgRole | null, row: RequesterRow | null): boolean {
  if (isDriveLead(userId, drive)) return true;
  if (!row?.accepted) return false;
  if (row.role === null) return false;
  return validOrgDriveRow({ role: row.role, customRoleId: null, source: row.source }, drive, orgRole) !== null;
}

/** A pending invitation to a membership; a non-membership row (GUEST) invites to nothing. */
const isPendingInvite = (row: RequesterRow | null): boolean => row !== null && !row.accepted && row.role !== null;

export interface JoinRequestInput {
  drive: JoinDrive | null;
  requesterId: string;
  /** The requester's role in drive.orgId; null when not a member. */
  requesterOrgRole: OrgRole | null;
  requesterRow: RequesterRow | null;
  /** The requester already has a PENDING request on this drive. */
  hasPendingRequest: boolean;
}

export type JoinRequestDecision = { ok: true; action: 'create' | 'existing' } | JoinRequestRefusal;

/**
 * Whether a person may ask to join a drive. Only an org member, only a Restricted drive of their
 * org. Someone outside the org, and a plain member asking about a Private drive, learn nothing:
 * the drive is not found. An open request is returned as is (idempotent).
 */
export function decideJoinRequest({
  drive,
  requesterId,
  requesterOrgRole,
  requesterRow,
  hasPendingRequest,
}: JoinRequestInput): JoinRequestDecision {
  if (!isLiveOrgDrive(drive) || requesterOrgRole === null) return driveNotFound();

  const member = holdsMembership(requesterId, drive, requesterOrgRole, requesterRow);
  if (member || drive.orgVisibility === 'OPEN') {
    return refuse('ALREADY_MEMBER', 409, 'You are already a member of this drive.');
  }
  if (drive.orgVisibility !== 'RESTRICTED') return driveNotFound();
  if (isPendingInvite(requesterRow)) {
    return refuse('PENDING_INVITE', 409, 'You have a pending invitation to this drive. Accept it instead.');
  }
  return { ok: true, action: hasPendingRequest ? 'existing' : 'create' };
}

export interface JoinRequestRef {
  userId: string;
  status: DriveJoinRequestStatus;
}

export interface JoinRequestDecisionInput {
  decision: 'approve' | 'deny';
  actorId: string;
  /** The actor's role in drive.orgId; null when not a member. */
  actorOrgRole: OrgRole | null;
  drive: JoinDrive | null;
  request: JoinRequestRef;
  /** The requester's role in drive.orgId now; null once they left. */
  requesterOrgRole: OrgRole | null;
  /** The requester's drive_members row now, accepted or pending. */
  requesterRow: RequesterRow | null;
}

export type JoinRequestAnswer =
  | { ok: true; action: 'approve'; admit: boolean }
  | { ok: true; action: 'deny' }
  | JoinRequestRefusal;

/**
 * Approve or deny a pending request. The drive lead or an org Owner/Admin answers (DRV-6), and
 * never their own request. Approval admits the requester only while the drive is still Restricted,
 * they are still in the org and hold no pending invitation; `admit: false` closes a request whose
 * requester already holds a membership, without a second row. Denial needs only the authority, so
 * a stale request can always be closed.
 */
export function decideJoinRequestDecision({
  decision,
  actorId,
  actorOrgRole,
  drive,
  request,
  requesterOrgRole,
  requesterRow,
}: JoinRequestDecisionInput): JoinRequestAnswer {
  const approver = decideJoinRequestApprover({ actorId, actorOrgRole, drive });
  if (!approver.ok) return approver;
  const orgDrive = approver.drive;
  if (request.userId === actorId) {
    return refuse('SELF_DECISION', 403, 'You cannot answer your own join request.');
  }
  if (request.status !== 'pending') {
    return refuse('NOT_PENDING', 409, 'This join request has already been answered or withdrawn.');
  }
  if (decision === 'deny') return { ok: true, action: 'deny' };

  if (orgDrive.orgVisibility !== 'RESTRICTED') {
    return refuse('NOT_RESTRICTED', 409, 'This drive is no longer Restricted. Invite the person instead.');
  }
  if (requesterOrgRole === null) {
    return refuse('REQUESTER_NOT_ORG_MEMBER', 409, 'The requester is no longer a member of the organization.');
  }
  if (holdsMembership(request.userId, orgDrive, requesterOrgRole, requesterRow)) {
    return { ok: true, action: 'approve', admit: false };
  }
  if (isPendingInvite(requesterRow)) {
    return refuse('PENDING_INVITE', 409, 'The requester has a pending invitation to this drive; it is theirs to accept.');
  }
  return { ok: true, action: 'approve', admit: true };
}

/**
 * Who may answer (and list) a drive's join requests: its lead while in the org (D-OW-7 keeps them
 * there), or an org Owner or Admin. Someone outside the org learns nothing, and neither does an org
 * member refused on a PRIVATE drive: they get the same not-found as a missing drive, so holding its
 * id confirms nothing. A Restricted or Open drive is listed to every org member in the directory
 * anyway, so there the refusal says why.
 */
export function decideJoinRequestApprover({
  actorId,
  actorOrgRole,
  drive,
}: {
  actorId: string;
  actorOrgRole: OrgRole | null;
  drive: JoinDrive | null;
}): { ok: true; drive: JoinDrive & { orgId: string } } | JoinRequestRefusal {
  if (!isLiveOrgDrive(drive) || actorOrgRole === null) return requestNotFound();
  const authority = decideDriveLeadAuthority({ orgsEnabled: true, userId: actorId, drive, orgRole: actorOrgRole });
  if (!authority.allowed) {
    if (drive.orgVisibility === 'PRIVATE') return requestNotFound();
    return refuse('NOT_APPROVER', 403, 'Only the drive lead or an organization Owner or Admin can answer join requests.');
  }
  return { ok: true, drive };
}

/**
 * Whether a pending request still asks for something (DRV-6): the drive is still a Restricted
 * drive of an org, the requester is still in that org, and they do not lead it. Anything else
 * closes it (the services mark it withdrawn), so an approver's list never keeps the name and
 * email of someone who left, and a request never revives when a drive returns to Restricted.
 */
export function decideJoinRequestStaysOpen({
  drive,
  requesterId,
  requesterOrgRole,
}: {
  drive: Pick<JoinDrive, 'ownerId' | 'orgId' | 'orgVisibility'>;
  requesterId: string;
  /** The requester's role in drive.orgId now; null once they left or the drive has no org. */
  requesterOrgRole: OrgRole | null;
}): boolean {
  if (drive.orgId === null) return false;
  if (drive.orgVisibility !== 'RESTRICTED') return false;
  if (requesterOrgRole === null) return false;
  return !isDriveLead(requesterId, drive);
}

/** The requester, and only they, may withdraw a pending request. */
export function decideJoinRequestWithdrawal({
  actorId,
  request,
}: {
  actorId: string;
  request: JoinRequestRef;
}): { ok: true } | JoinRequestRefusal {
  if (request.userId !== actorId) return requestNotFound();
  if (request.status !== 'pending') return refuse('NOT_PENDING', 409, 'This join request has already been answered or withdrawn.');
  return { ok: true };
}

export interface DirectoryEntryInput {
  viewerId: string;
  /** The viewer's role in drive.orgId; null when not a member. */
  viewerOrgRole: OrgRole | null;
  drive: JoinDrive;
  viewerRow: RequesterRow | null;
  hasPendingRequest: boolean;
}

export interface DirectoryEntry {
  /** On the drive: its lead, a valid accepted row, or (Open) every org member. */
  joined: boolean;
  joinRequest: 'pending' | null;
  /** The directory may offer "Request to join". */
  canRequest: boolean;
}

/**
 * One drive's line in the org Drives directory for one viewer, or null when the viewer may not see
 * it there (DRV-6, DRV-7). Open and Restricted drives are listed for every org member. A Private
 * drive is listed only to people who can already open it (D-OW-25): the org Owner and Admins, its
 * lead, and its accepted members. Never to a pending invitee, a stale org row or a GUEST row, so
 * the directory never reveals a drive its viewer cannot reach.
 */
export function decideDriveDirectoryEntry({
  viewerId,
  viewerOrgRole,
  drive,
  viewerRow,
  hasPendingRequest,
}: DirectoryEntryInput): DirectoryEntry | null {
  if (!isLiveOrgDrive(drive) || viewerOrgRole === null) return null;

  const member = holdsMembership(viewerId, drive, viewerOrgRole, viewerRow);
  switch (drive.orgVisibility) {
    case 'OPEN':
      return { joined: true, joinRequest: null, canRequest: false };
    case 'RESTRICTED': {
      if (member) return { joined: true, joinRequest: null, canRequest: false };
      if (hasPendingRequest) return { joined: false, joinRequest: 'pending', canRequest: false };
      return { joined: false, joinRequest: null, canRequest: !isPendingInvite(viewerRow) };
    }
    case 'PRIVATE': {
      const orgAdmin = viewerOrgRole === 'OWNER' || viewerOrgRole === 'ADMIN';
      if (!member && !orgAdmin) return null;
      return { joined: member, joinRequest: null, canRequest: false };
    }
  }
}
