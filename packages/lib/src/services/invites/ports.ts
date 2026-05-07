import type {
  AcceptedInviteData,
  Invite,
  InviteAcceptanceErrorCode,
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

// Side-effect ports (broadcastMemberAdded, notifyMemberAdded, trackInviteMember,
// auditPermissionGranted, auditPermissionRevoked) MUST NOT throw. Adapters
// own try/catch + logging at the IO boundary so a flaky websocket fan-out or
// audit-DB blip cannot reverse a successful membership write. Pipes wrap each
// call in defense-in-depth try/catch but never log.
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
  trackInviteMember: (input: AcceptedInviteData & { permissionsGranted: number }) => void;
  auditPermissionGranted: (input: AcceptedInviteData) => void;
}

export interface MagicLinkPorts {
  loadUserByEmail: (input: { email: string }) => Promise<UserAccount | null>;
  createTokenAndPersist: (input: {
    userId: string;
    expiresAt: Date;
    now: Date;
    platform?: 'web' | 'desktop' | 'ios';
    deviceId?: string;
    deviceName?: string;
  }) => Promise<{ token: string }>;
  sendMagicLinkEmail: (input: { email: string; token: string }) => Promise<void>;
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
