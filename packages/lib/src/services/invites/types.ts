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
  inviteId: string;
  inviteEmail: string;
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
}

export type MagicLinkErrorCode =
  | 'NO_ACCOUNT_FOUND'
  | 'ACCOUNT_SUSPENDED'
  | 'VALIDATION_FAILED';

export type RequestMagicLinkResult =
  | { ok: true }
  | { ok: false; error: MagicLinkErrorCode };

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
