export type Role = 'OWNER' | 'ADMIN' | 'MEMBER';

export type Result<T, E> =
  | { ok: true; data: T }
  | { ok: false; error: E };

export interface Invite {
  id: string;
  email: string;
  driveId: string;
  driveName: string;
  role: Role;
  invitedBy: string;
  expiresAt: Date | null;
  consumedAt: Date | null;
}

export interface AcceptedInviteData {
  // inviteId/inviteEmail are present on invite-driven acceptances (the two
  // pipes set them) and absent on direct-grant flows where an OWNER/ADMIN
  // adds an existing user without going through an invite token.
  inviteId?: string;
  inviteEmail?: string;
  memberId: string;
  driveId: string;
  driveName: string;
  role: Role;
  invitedUserId: string;
  inviterUserId: string;
}

export interface AcceptInviteInput {
  token: string;
  userId: string;
  userEmail: string;
  suspendedAt: Date | null;
  now: Date;
}

export type InviteAcceptanceErrorCode =
  | 'TOKEN_NOT_FOUND'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_CONSUMED'
  | 'EMAIL_MISMATCH'
  | 'ALREADY_MEMBER'
  | 'ACCOUNT_SUSPENDED';

export type AcceptInviteResult = Result<AcceptedInviteData, InviteAcceptanceErrorCode>;

export interface RevokePendingInviteInput {
  inviteId: string;
  driveId: string;
  actorId: string;
}

export interface RevokedInviteData {
  inviteId: string;
  driveId: string;
  email: string;
  role: Role;
}

export type RevokeErrorCode = 'NOT_FOUND' | 'FORBIDDEN';

export type RevokePendingInviteResult = Result<RevokedInviteData, RevokeErrorCode>;

export interface RequestMagicLinkInput {
  email: string;
  now: Date;
  expiryMinutes?: number;
  platform?: 'web' | 'desktop' | 'ios';
  deviceId?: string;
  deviceName?: string;
  // Same-origin redirect target embedded in the verify URL. The caller must
  // have already validated against an allowlist; the pipe forwards verbatim
  // to the email-send port and never inspects it. Mutually exclusive with
  // inviteToken — when an invite is bound, the verify route computes the
  // redirect from invite data and never honours next.
  next?: string;
  // Invite token to bind to this magic-link. The caller MUST have already
  // verified the invite exists, is unconsumed, unexpired, and that its email
  // matches `email`. The pipe forwards verbatim into the verification-token
  // metadata so the verify route can consume the invite atomically with
  // authentication, eliminating the URL-fragility of next=/invite/<t>/accept.
  inviteToken?: string;
  // Affirmative ToS acceptance from the inline form. Required to auto-create
  // the user when no account exists for `email`. Must be true for unknown
  // emails or the pipe returns TOS_REQUIRED. Existing users are unaffected.
  tosAccepted: boolean;
}

export type MagicLinkErrorCode =
  | 'TOS_REQUIRED'
  | 'ACCOUNT_SUSPENDED'
  | 'VALIDATION_FAILED';

export type RequestMagicLinkResult = Result<void, MagicLinkErrorCode>;

export interface PendingInviteSummary {
  id: string;
  email: string;
  role: Role;
  driveId: string;
  invitedByName: string;
  createdAt: Date;
  expiresAt: Date | null;
}

export interface UserAccount {
  id: string;
  suspendedAt: Date | null;
}

// --- Page-share-by-email ---------------------------------------------------

// Permissions that may be granted to a user invited by email. DELETE is
// intentionally absent: handing destructive authority to an unverified email
// is account-takeover bait. Both the schema (jsonb $type) and the route-layer
// zod gate enforce this.
export type PendingPagePermission = 'VIEW' | 'EDIT' | 'SHARE';

export interface PageInvite {
  id: string;
  email: string;
  pageId: string;
  pageTitle: string;
  driveId: string;
  driveName: string;
  permissions: PendingPagePermission[];
  invitedBy: string;
  expiresAt: Date | null;
  consumedAt: Date | null;
}

export interface AcceptedPageInviteData {
  inviteId: string;
  inviteEmail: string;
  pageId: string;
  pageTitle: string;
  driveId: string;
  driveName: string;
  permissions: PendingPagePermission[];
  // memberId is set when the acceptance also created a fresh drive_members
  // row (the typical new-grant path). null when the user already had a
  // drive_members row (so the page-grant write proceeded without needing a
  // membership write — see PageAcceptancePorts.consumeInviteAndGrantPage).
  memberId: string | null;
  invitedUserId: string;
  inviterUserId: string;
}

export type AcceptPageInviteResult = Result<
  AcceptedPageInviteData,
  InviteAcceptanceErrorCode | 'ALREADY_HAS_PERMISSION'
>;

// --- Connection-by-email ---------------------------------------------------

export interface ConnectionInvite {
  id: string;
  email: string;
  invitedBy: string;
  inviterName: string;
  requestMessage: string | null;
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface AcceptedConnectionData {
  inviteId: string;
  inviteEmail: string;
  connectionId: string;
  // The connection is created in PENDING state (the design choice — see
  // every-invite-flow plan); the inviter still has to be confirmed by the
  // invited user from the connections UI.
  status: 'PENDING' | 'ACCEPTED';
  invitedUserId: string;
  inviterUserId: string;
}

export type AcceptConnectionInviteResult = Result<
  AcceptedConnectionData,
  InviteAcceptanceErrorCode | 'ALREADY_CONNECTED'
>;

