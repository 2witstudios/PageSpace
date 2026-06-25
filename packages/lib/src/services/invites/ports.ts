import type {
  AcceptedConnectionData,
  AcceptedInviteData,
  AcceptedPageInviteData,
  ConnectionInvite,
  Invite,
  InviteAcceptanceErrorCode,
  PageInvite,
  PendingPagePermission,
  Role,
  UserAccount,
} from './types';

export type ConsumeMembershipReason = Extract<
  InviteAcceptanceErrorCode,
  'TOKEN_CONSUMED' | 'ALREADY_MEMBER'
>;

export type ConsumeMembershipResult =
  | { ok: true; memberId: string }
  | { ok: false; reason: ConsumeMembershipReason };

// Acceptance-side-effect ports — broadcastMemberAdded, notifyMemberAdded,
// trackInviteMember, auditPermissionGranted, auditPermissionRevoked — MUST
// NOT throw. They fire AFTER the membership write commits, and an exception
// there cannot reverse the commit. Adapters own try/catch + logging at the
// IO boundary; pipes wrap each call in defense-in-depth swallow() but never
// log themselves.
//
// Pre-commit ports (loadInvite, findExistingMembership,
// consumeInviteAndCreateMember, loadUserByEmail, createTokenAndPersist,
// sendMagicLinkEmail, loadPendingInviteForDrive, findActorMembership,
// deletePendingInviteForDrive) MAY throw — the pipe needs the route to
// surface a 5xx so the user can retry. Routes that wrap pipes are expected
// to catch.
export interface AcceptancePorts {
  loadInvite: (input: { token: string }) => Promise<Invite | null>;
  findExistingMembership: (input: {
    driveId: string;
    userId: string;
  }) => Promise<{ acceptedAt: Date | null } | null>;
  consumeInviteAndCreateMember: (input: {
    invite: Invite;
    userId: string;
    now: Date;
  }) => Promise<ConsumeMembershipResult>;
  broadcastMemberAdded: (input: AcceptedInviteData) => Promise<void>;
  notifyMemberAdded: (input: AcceptedInviteData) => Promise<void>;
  trackInviteMember: (
    input: AcceptedInviteData & { permissionsGranted: number },
  ) => Promise<void>;
  auditPermissionGranted: (input: AcceptedInviteData) => void;
}

export interface MagicLinkPorts {
  loadUserByEmail: (input: { email: string }) => Promise<UserAccount | null>;
  // Creates a new user row when the typed email has no account. Adapter must
  // handle unique-constraint races (two concurrent magic-link requests for
  // the same email) by re-loading and returning the surviving id. Stores
  // tosAcceptedAt to record affirmative consent at form-submit time.
  createUserAccount: (input: {
    email: string;
    tosAcceptedAt: Date;
  }) => Promise<{ id: string }>;
  createTokenAndPersist: (input: {
    userId: string;
    expiresAt: Date;
    platform?: 'web' | 'desktop' | 'ios';
    deviceId?: string;
    deviceName?: string;
    // Invite token bound to this magic-link at mint time. Persisted in the
    // verification-token metadata so the verify route can consume the invite
    // server-side without trusting URL query params. The pipe forwards
    // verbatim from a pre-validated input — adapters must NOT re-validate.
    inviteToken?: string;
  }) => Promise<{ token: string }>;
  sendMagicLinkEmail: (input: {
    email: string;
    token: string;
    next?: string;
  }) => Promise<void>;
}

export interface RevokePorts {
  loadPendingInviteForDrive: (input: {
    inviteId: string;
    driveId: string;
  }) => Promise<{ id: string; email: string; role: Role; driveId: string } | null>;
  findActorMembership: (input: {
    driveId: string;
    actorId: string;
  }) => Promise<{ role: Role; acceptedAt: Date | null } | null>;
  deletePendingInviteForDrive: (input: {
    inviteId: string;
    driveId: string;
  }) => Promise<{ rowsDeleted: number }>;
  auditPermissionRevoked: (input: {
    inviteId: string;
    driveId: string;
    actorId: string;
    targetEmail: string;
    role: Role;
  }) => void;
}

// --- Page-share-by-email --------------------------------------------------

export type ConsumePagePermissionReason = Extract<
  InviteAcceptanceErrorCode,
  'TOKEN_CONSUMED'
> | 'ALREADY_HAS_PERMISSION';

export type ConsumePagePermissionResult =
  | { ok: true; memberId: string | null }
  | { ok: false; reason: ConsumePagePermissionReason };

export interface PageAcceptancePorts {
  loadInvite: (input: { token: string }) => Promise<PageInvite | null>;
  // Existing-permission lookup is the "ALREADY_HAS_PERMISSION" gate; absence
  // means the user has no permissions row on the page (and may or may not be
  // a drive member — the consumeInviteAndGrantPage write handles the
  // membership-coupled write atomically).
  findExistingPagePermission: (input: {
    pageId: string;
    userId: string;
  }) => Promise<{ id: string } | null>;
  // Atomically: mark invite consumed, ensure drive_members row exists
  // (creating one as MEMBER if missing), and create the page_permissions row
  // with the requested permissions. Returning `memberId` lets the route emit
  // a member_added side-effect when one was created.
  consumeInviteAndGrantPage: (input: {
    invite: PageInvite;
    userId: string;
    now: Date;
  }) => Promise<ConsumePagePermissionResult>;
  // Side-effect ports (post-commit; must not throw).
  broadcastPagePermissionGranted: (input: AcceptedPageInviteData) => Promise<void>;
  notifyPagePermissionGranted: (input: AcceptedPageInviteData) => Promise<void>;
  auditPagePermissionGranted: (input: AcceptedPageInviteData) => void;
}

// --- Connection-by-email --------------------------------------------------

export type ConsumeConnectionReason = Extract<
  InviteAcceptanceErrorCode,
  'TOKEN_CONSUMED'
> | 'ALREADY_CONNECTED';

export type ConsumeConnectionResult =
  | { ok: true; connectionId: string; status: 'PENDING' | 'ACCEPTED' }
  | { ok: false; reason: ConsumeConnectionReason };

export interface ConnectionAcceptancePorts {
  loadInvite: (input: { token: string }) => Promise<ConnectionInvite | null>;
  // Looks up an existing connection between (inviterId, userId) regardless
  // of which user is user1Id vs user2Id (the schema uses sorted ordering).
  findExistingConnection: (input: {
    userId: string;
    inviterId: string;
  }) => Promise<{ id: string; status: 'PENDING' | 'ACCEPTED' | 'BLOCKED' } | null>;
  // Atomically: mark invite consumed and insert a connections row in PENDING
  // state with [userId, inviterId].sort() as (user1Id, user2Id) so the
  // connections_user_pair_key unique constraint is satisfied regardless of
  // which side initiated.
  consumeInviteAndCreateConnection: (input: {
    invite: ConnectionInvite;
    userId: string;
    now: Date;
  }) => Promise<ConsumeConnectionResult>;
  // Side-effect ports (post-commit; must not throw).
  broadcastConnectionRequested: (input: AcceptedConnectionData) => Promise<void>;
  notifyConnectionRequested: (input: AcceptedConnectionData) => Promise<void>;
  auditConnectionRequested: (input: AcceptedConnectionData) => void;
}

// Re-export for symmetry with PendingPagePermission usage in callers.
export type { PendingPagePermission };
