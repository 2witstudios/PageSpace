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
  expiresAt: Date;
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
  // to the email-send port and never inspects it.
  next?: string;
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
  expiresAt: Date;
}

export interface UserAccount {
  id: string;
  suspendedAt: Date | null;
}
