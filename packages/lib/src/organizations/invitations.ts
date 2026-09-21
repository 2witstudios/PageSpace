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
import { organizations, orgInvitations, orgMembers, type OrgInvitation, type OrgRole } from '@pagespace/db/schema/organizations';
import { generateToken, hashToken } from '../auth/token-utils';
import { decryptUserRow } from '../auth/user-repository';
import { normalizeEmail } from '../encryption/blind-index';
import { isEmailAMember, isUniqueViolation, retryOnDeadlock } from './repository';
import {
  publishOrgMembershipSyncEvents,
  syncOrgMemberAccess,
  type OrgMembershipSyncResult,
} from '../services/org-membership-sync';

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

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Sends the invitation email. Called after the invite commits; a throw is compensated. */
export type InviteDelivery = (invitation: PublicOrgInvitation, token: string) => Promise<void>;

export type DeliveryFailed = { ok: false; status: 502; reason: 'delivery_failed'; cause: unknown };

/**
 * Serializes everything that decides whether (org, address) gets an invite or a
 * membership: creation takes it before its member/open-invite checks, acceptance
 * takes it before joining. Without it an acceptance can commit between creation's
 * "is a member?" check and its insert, leaving a member with a fresh invite and a
 * second seat. Always taken BEFORE any invitation row lock, so the order is fixed.
 */
export async function lockOrgInviteAddress(tx: Tx, orgId: string, email: string): Promise<void> {
  const key = `org_invite:${orgId}:${normalizeEmail(email)}`;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

export type IssueInvitationResult =
  | { ok: true; invitation: PublicOrgInvitation; token: string; rotated: boolean }
  | { ok: false; status: 409; reason: 'already_member' | 'already_invited' }
  | DeliveryFailed;

type Issued =
  | { ok: true; invitation: OrgInvitation; token: string; previous: OrgInvitation | null }
  | { ok: false; status: 409; reason: 'already_member' | 'already_invited' };

/**
 * Invite an address, rotating an expired open invite in place. If delivery fails the
 * invite is put back exactly as it was: a new row is deleted (it never reached anyone
 * and must not hold a seat), a rotated row gets its previous token and expiry back.
 */
export async function createOrRotateInvitation(input: {
  orgId: string;
  email: string;
  role: InvitableRole;
  invitedBy: string;
  now: Date;
  deliver: InviteDelivery;
}): Promise<IssueInvitationResult> {
  let issued: Issued;
  try {
    issued = await db.transaction(async (tx): Promise<Issued> => {
      await lockOrgInviteAddress(tx, input.orgId, input.email);
      const isExistingMember = await isEmailAMember(input.orgId, input.email, tx);
      const [openInvite] = await tx
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
        .limit(1)
        .for('update');
      const decision = decideInviteCreation({ isExistingMember, openInvite: openInvite ?? null, now: input.now });
      if (decision.action === 'refuse') return { ok: false, status: 409, reason: decision.reason };

      const { token, hash } = generateToken(ORG_INVITE_TOKEN_PREFIX);
      const expiresAt = inviteExpiryFrom(input.now);
      if (decision.action === 'rotate' && openInvite) {
        const [invitation] = await tx
          .update(orgInvitations)
          .set({ tokenHash: hash, expiresAt, role: input.role, invitedBy: input.invitedBy })
          .where(eq(orgInvitations.id, decision.invitationId))
          .returning();
        return { ok: true, invitation, token, previous: openInvite };
      }
      const [invitation] = await tx
        .insert(orgInvitations)
        .values({ orgId: input.orgId, email: input.email, role: input.role, tokenHash: hash, invitedBy: input.invitedBy, expiresAt })
        .returning();
      return { ok: true, invitation, token, previous: null };
    });
  } catch (error) {
    // Defence in depth: the open-invite unique index still refuses a duplicate.
    if (isUniqueViolation(error)) return { ok: false, status: 409, reason: 'already_invited' };
    throw error;
  }
  if (!issued.ok) return issued;

  const { invitation, token, previous } = issued;
  try {
    await input.deliver(toPublic(invitation), token);
  } catch (cause) {
    // Only undo our own write: skip if it was accepted or rotated again meanwhile.
    const stillOurs = and(
      eq(orgInvitations.id, invitation.id),
      eq(orgInvitations.tokenHash, invitation.tokenHash),
      isNull(orgInvitations.acceptedAt),
    );
    if (previous) {
      await db
        .update(orgInvitations)
        .set({ tokenHash: previous.tokenHash, expiresAt: previous.expiresAt, role: previous.role, invitedBy: previous.invitedBy })
        .where(stillOurs);
    } else {
      await db.delete(orgInvitations).where(stillOurs);
    }
    return { ok: false, status: 502, reason: 'delivery_failed', cause };
  }
  return { ok: true, invitation: toPublic(invitation), token, rotated: previous !== null };
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
  | { ok: false; status: 404; reason: 'not_found' }
  | DeliveryFailed;

/**
 * Resend issues a new link with a fresh expiry, and the old link stops working, but
 * only once the new one has been delivered: if delivery fails the previous token and
 * expiry are restored, so the link the person already has keeps working.
 */
export async function resendInvitation(input: {
  orgId: string;
  invitationId: string;
  now: Date;
  deliver: InviteDelivery;
}): Promise<ResendInvitationResult> {
  const { token, hash } = generateToken(ORG_INVITE_TOKEN_PREFIX);
  const rotated = await db.transaction(async (tx) => {
    const [previous] = await tx
      .select()
      .from(orgInvitations)
      .where(
        and(
          eq(orgInvitations.id, input.invitationId),
          eq(orgInvitations.orgId, input.orgId),
          isNull(orgInvitations.acceptedAt),
        ),
      )
      .for('update');
    if (!previous) return null;
    const [invitation] = await tx
      .update(orgInvitations)
      .set({ tokenHash: hash, expiresAt: inviteExpiryFrom(input.now) })
      .where(eq(orgInvitations.id, previous.id))
      .returning();
    return { previous, invitation };
  });
  if (!rotated) return { ok: false, status: 404, reason: 'not_found' };

  try {
    await input.deliver(toPublic(rotated.invitation), token);
  } catch (cause) {
    await db
      .update(orgInvitations)
      .set({ tokenHash: rotated.previous.tokenHash, expiresAt: rotated.previous.expiresAt })
      .where(
        and(
          eq(orgInvitations.id, rotated.previous.id),
          eq(orgInvitations.tokenHash, hash),
          isNull(orgInvitations.acceptedAt),
        ),
      );
    return { ok: false, status: 502, reason: 'delivery_failed', cause };
  }
  return { ok: true, invitation: toPublic(rotated.invitation), token };
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

export interface AcceptInvitationDeps {
  /** Materializes the joiner on the org's Open drives inside the acceptance transaction (D-OW-6). */
  syncMemberAccess: typeof syncOrgMemberAccess;
  /** Runs only after the acceptance has committed. */
  publishSyncEvents: (result: OrgMembershipSyncResult) => Promise<void>;
}

const acceptInvitationDeps: AcceptInvitationDeps = {
  syncMemberAccess: syncOrgMemberAccess,
  publishSyncEvents: (result) => publishOrgMembershipSyncEvents(result),
};

/**
 * Accept by raw token. The invite row is locked so two tabs accepting the same
 * link serialize; the membership insert and acceptedAt are one transaction, so a
 * consumed invite always has its member row and a member never keeps a live
 * invite (and a second seat).
 *
 * A join also materializes the new member on every Open drive of the org in the
 * same transaction (DRV-5, D-OW-6), so row enumerators (drive recipients,
 * notifications) see them; the realtime events go out only after commit.
 */
export async function acceptInvitation(
  input: {
    token: string;
    userId: string;
    now: Date;
  },
  deps: AcceptInvitationDeps = acceptInvitationDeps,
): Promise<AcceptInvitationResult> {
  const tokenHash = hashToken(input.token);
  // A join locks the org row then its drives; a leave that reassigns a led drive locks drive and
  // org rows in one statement, so the two can still deadlock. The acceptance rolls back whole.
  const outcome = await retryOnDeadlock(() => db.transaction(async (tx): Promise<{ result: AcceptInvitationResult; sync: OrgMembershipSyncResult | null }> => {
    // Take the address lock (shared with invite creation) before the row lock.
    const [peek] = await tx
      .select({ orgId: orgInvitations.orgId, email: orgInvitations.email })
      .from(orgInvitations)
      .where(eq(orgInvitations.tokenHash, tokenHash))
      .limit(1);
    if (peek) {
      await lockOrgInviteAddress(tx, peek.orgId, peek.email);
      // The org row, before the invite row: org drive creation and moves share-lock it, so a join
      // and a new drive serialize and the later one materializes the joiner there (D-OW-6); and
      // deleting the org, which locks it first too, can no longer deadlock on the invite row.
      await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, peek.orgId)).for('update');
    }
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
    if (!userRow) return { result: { ok: false, status: 404, reason: 'not_found' }, sync: null };
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
    if (!decision.ok) return { result: decision, sync: null };
    // decideInviteAcceptance refuses a null invite, so it is present from here on.
    if (!invite) return { result: { ok: false, status: 404, reason: 'not_found' }, sync: null };

    let sync: OrgMembershipSyncResult | null = null;
    if (decision.action === 'join') {
      await tx.insert(orgMembers).values({
        orgId: invite.orgId,
        userId: input.userId,
        role: invite.role,
        invitedBy: invite.invitedBy,
      });
      sync = await deps.syncMemberAccess(invite.orgId, input.userId, { tx });
    }
    await tx.update(orgInvitations).set({ acceptedAt: input.now }).where(eq(orgInvitations.id, invite.id));
    return {
      result: {
        ok: true,
        orgId: invite.orgId,
        role: membership?.role ?? invite.role,
        joined: decision.action === 'join',
      },
      sync,
    };
  }));
  if (outcome.sync) await deps.publishSyncEvents(outcome.sync);
  return outcome.result;
}
