/**
 * Org invitations by email: create, resend, revoke, accept (Spec ORG-3).
 *
 * Only the SHA3 hash of the invite token is stored; the raw token travels in the
 * email link. There is at most one OPEN invite per (org, lower(email)) — the B1
 * partial unique index — so an expired open invite is ROTATED in place (new
 * tokenHash, new expiresAt, same row) rather than blocking the address forever.
 * Revoke deletes the open row. Acceptance works for any signed-in account whose
 * email is the invited address, which covers a brand-new account (sign up, then
 * accept) and an existing one alike.
 */
import { db } from '@pagespace/db/db';
import { and, asc, eq, isNull, sql } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { orgInvitations, orgMembers, type OrgInvitation, type OrgRole } from '@pagespace/db/schema/organizations';
import { generateToken, hashToken } from '../auth/token-utils';
import { decryptUserRow } from '../auth/user-repository';
import { normalizeEmail } from '../encryption/blind-index';
import { isEmailAMember, isUniqueViolation } from './repository';

export const INVITE_EXPIRY_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const ORG_INVITE_TOKEN_PREFIX = 'ps_orginv';

export type InvitableRole = Exclude<OrgRole, 'OWNER'>;

export const inviteExpiryFrom = (now: Date): Date => new Date(now.getTime() + INVITE_EXPIRY_DAYS * DAY_MS);

/** A live invite holds a seat and can be accepted: not accepted, not yet expired. */
export const isLiveInvite = (invite: { acceptedAt: Date | null; expiresAt: Date }, now: Date): boolean =>
  invite.acceptedAt === null && invite.expiresAt.getTime() > now.getTime();

export type InviteCreationDecision =
  | { action: 'insert' }
  | { action: 'rotate'; invitationId: string }
  | { action: 'refuse'; reason: 'already_member' | 'already_invited' };

export const decideInviteCreation = ({
  isExistingMember,
  openInvite,
  now,
}: {
  isExistingMember: boolean;
  openInvite: { id: string; acceptedAt: Date | null; expiresAt: Date } | null;
  now: Date;
}): InviteCreationDecision => {
  if (isExistingMember) return { action: 'refuse', reason: 'already_member' };
  if (openInvite === null) return { action: 'insert' };
  if (isLiveInvite(openInvite, now)) return { action: 'refuse', reason: 'already_invited' };
  return { action: 'rotate', invitationId: openInvite.id };
};

export type InviteAcceptanceDecision =
  | { ok: true; action: 'join' | 'consume_only' }
  | { ok: false; status: 404; reason: 'not_found' }
  | { ok: false; status: 410; reason: 'expired' | 'already_accepted' }
  | { ok: false; status: 403; reason: 'email_mismatch' };

export const decideInviteAcceptance = ({
  invite,
  userEmail,
  isExistingMember,
  now,
}: {
  invite: { email: string; acceptedAt: Date | null; expiresAt: Date } | null;
  userEmail: string;
  isExistingMember: boolean;
  now: Date;
}): InviteAcceptanceDecision => {
  if (invite === null) return { ok: false, status: 404, reason: 'not_found' };
  if (invite.acceptedAt !== null) return { ok: false, status: 410, reason: 'already_accepted' };
  if (!isLiveInvite(invite, now)) return { ok: false, status: 410, reason: 'expired' };
  if (normalizeEmail(invite.email) !== normalizeEmail(userEmail)) {
    return { ok: false, status: 403, reason: 'email_mismatch' };
  }
  return { ok: true, action: isExistingMember ? 'consume_only' : 'join' };
};

export type PublicOrgInvitation = Omit<OrgInvitation, 'tokenHash'>;

const toPublic = ({ tokenHash: _tokenHash, ...rest }: OrgInvitation): PublicOrgInvitation => rest;

export type IssueInvitationResult =
  | { ok: true; invitation: PublicOrgInvitation; token: string; rotated: boolean }
  | { ok: false; status: 409; reason: 'already_member' | 'already_invited' };

export async function createOrRotateInvitation(input: {
  orgId: string;
  email: string;
  role: InvitableRole;
  invitedBy: string;
  now: Date;
}): Promise<IssueInvitationResult> {
  const isExistingMember = await isEmailAMember(input.orgId, input.email);
  const [openInvite] = await db
    .select()
    .from(orgInvitations)
    .where(
      and(
        eq(orgInvitations.orgId, input.orgId),
        isNull(orgInvitations.acceptedAt),
        // Case-insensitive, matching the lower(email) open-invite unique index.
        sql`lower(${orgInvitations.email}) = lower(${input.email})`,
      ),
    )
    .limit(1);
  const decision = decideInviteCreation({ isExistingMember, openInvite: openInvite ?? null, now: input.now });
  if (decision.action === 'refuse') return { ok: false, status: 409, reason: decision.reason };

  const { token, hash } = generateToken(ORG_INVITE_TOKEN_PREFIX);
  const expiresAt = inviteExpiryFrom(input.now);

  if (decision.action === 'rotate') {
    const [invitation] = await db
      .update(orgInvitations)
      .set({ tokenHash: hash, expiresAt, role: input.role, invitedBy: input.invitedBy })
      .where(and(eq(orgInvitations.id, decision.invitationId), isNull(orgInvitations.acceptedAt)))
      .returning();
    if (!invitation) return { ok: false, status: 409, reason: 'already_invited' };
    return { ok: true, invitation: toPublic(invitation), token, rotated: true };
  }

  try {
    const [invitation] = await db
      .insert(orgInvitations)
      .values({
        orgId: input.orgId,
        email: input.email,
        role: input.role,
        tokenHash: hash,
        invitedBy: input.invitedBy,
        expiresAt,
      })
      .returning();
    return { ok: true, invitation: toPublic(invitation), token, rotated: false };
  } catch (error) {
    // A concurrent invite for the same address won the open-invite unique index.
    if (isUniqueViolation(error)) return { ok: false, status: 409, reason: 'already_invited' };
    throw error;
  }
}

export async function listOpenInvitations(orgId: string): Promise<PublicOrgInvitation[]> {
  const rows = await db
    .select()
    .from(orgInvitations)
    .where(and(eq(orgInvitations.orgId, orgId), isNull(orgInvitations.acceptedAt)))
    .orderBy(asc(orgInvitations.createdAt))
    .limit(5000);
  return rows.map(toPublic);
}

export type ResendInvitationResult =
  | { ok: true; invitation: PublicOrgInvitation; token: string }
  | { ok: false; status: 404; reason: 'not_found' };

/** Resend rotates the token and restarts the expiry window; the old link stops working. */
export async function resendInvitation(input: {
  orgId: string;
  invitationId: string;
  now: Date;
}): Promise<ResendInvitationResult> {
  const { token, hash } = generateToken(ORG_INVITE_TOKEN_PREFIX);
  const [invitation] = await db
    .update(orgInvitations)
    .set({ tokenHash: hash, expiresAt: inviteExpiryFrom(input.now) })
    .where(
      and(
        eq(orgInvitations.id, input.invitationId),
        eq(orgInvitations.orgId, input.orgId),
        isNull(orgInvitations.acceptedAt),
      ),
    )
    .returning();
  if (!invitation) return { ok: false, status: 404, reason: 'not_found' };
  return { ok: true, invitation: toPublic(invitation), token };
}

export async function revokeInvitation(input: { orgId: string; invitationId: string }): Promise<boolean> {
  const deleted = await db
    .delete(orgInvitations)
    .where(
      and(
        eq(orgInvitations.id, input.invitationId),
        eq(orgInvitations.orgId, input.orgId),
        isNull(orgInvitations.acceptedAt),
      ),
    )
    .returning({ id: orgInvitations.id });
  return deleted.length > 0;
}

export type AcceptInvitationResult =
  | { ok: true; orgId: string; role: OrgRole; joined: boolean }
  | Extract<InviteAcceptanceDecision, { ok: false }>;

/**
 * Accept by raw token. The invite row is locked so two tabs accepting the same
 * link serialize; the membership insert and acceptedAt are one transaction, so a
 * consumed invite always has its member row and a member never keeps a live
 * invite (and a second seat).
 */
export async function acceptInvitation(input: {
  token: string;
  userId: string;
  now: Date;
}): Promise<AcceptInvitationResult> {
  const tokenHash = hashToken(input.token);
  return db.transaction(async (tx) => {
    const [invite] = await tx
      .select()
      .from(orgInvitations)
      .where(eq(orgInvitations.tokenHash, tokenHash))
      .for('update');
    const [userRow] = await tx
      .select({ email: users.email, name: users.name })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1);
    if (!userRow) return { ok: false, status: 404, reason: 'not_found' } as const;
    const { email: userEmail } = await decryptUserRow(userRow);

    const [membership] = invite
      ? await tx
          .select({ role: orgMembers.role })
          .from(orgMembers)
          .where(and(eq(orgMembers.orgId, invite.orgId), eq(orgMembers.userId, input.userId)))
          .limit(1)
      : [];

    const decision = decideInviteAcceptance({
      invite: invite ?? null,
      userEmail,
      isExistingMember: membership !== undefined,
      now: input.now,
    });
    if (!decision.ok) return decision;
    // decideInviteAcceptance refuses a null invite, so it is present from here on.
    if (!invite) return { ok: false, status: 404, reason: 'not_found' } as const;

    if (decision.action === 'join') {
      await tx.insert(orgMembers).values({
        orgId: invite.orgId,
        userId: input.userId,
        role: invite.role,
        invitedBy: invite.invitedBy,
      });
    }
    await tx.update(orgInvitations).set({ acceptedAt: input.now }).where(eq(orgInvitations.id, invite.id));
    return {
      ok: true,
      orgId: invite.orgId,
      role: membership?.role ?? invite.role,
      joined: decision.action === 'join',
    };
  });
}
