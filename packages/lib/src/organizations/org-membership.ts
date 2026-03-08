import {
  db,
  eq,
  and,
  isNull,
  gt,
  orgMembers,
  orgInvitations,
  users,
} from '@pagespace/db';
import { createId } from '@paralleldrive/cuid2';

export interface InviteInput {
  email: string;
  role?: 'ADMIN' | 'MEMBER';
}

export interface InvitationResult {
  id: string;
  orgId: string;
  email: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  token: string;
  expiresAt: Date;
}

const toInvitationResult = (inv: typeof orgInvitations.$inferSelect): InvitationResult => ({
  id: inv.id,
  orgId: inv.orgId,
  email: inv.email,
  role: inv.role,
  token: inv.token,
  expiresAt: inv.expiresAt,
});

export async function createInvitation(
  orgId: string,
  invitedBy: string,
  input: InviteInput
): Promise<InvitationResult> {
  const existingUser = await db.query.users.findFirst({
    where: eq(users.email, input.email),
    columns: { id: true },
  });

  if (existingUser) {
    const existingMember = await db.query.orgMembers.findFirst({
      where: and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, existingUser.id)),
      columns: { id: true },
    });
    if (existingMember) {
      throw new Error('User is already a member of this organization');
    }
  }

  const now = new Date();
  const existingInvitation = await db.query.orgInvitations.findFirst({
    where: and(
      eq(orgInvitations.orgId, orgId),
      eq(orgInvitations.email, input.email),
    ),
  });

  if (existingInvitation && !existingInvitation.acceptedAt && existingInvitation.expiresAt > now) {
    throw new Error('An invitation has already been sent to this email');
  }

  const expiresAt = new Date(now);
  expiresAt.setDate(expiresAt.getDate() + 7);

  const token = createId();

  if (existingInvitation) {
    const [invitation] = await db.update(orgInvitations)
      .set({
        role: input.role ?? 'MEMBER',
        token,
        invitedBy,
        expiresAt,
        acceptedAt: null,
      })
      .where(eq(orgInvitations.id, existingInvitation.id))
      .returning();

    return toInvitationResult(invitation);
  }

  const [invitation] = await db.insert(orgInvitations).values({
    orgId,
    email: input.email,
    role: input.role ?? 'MEMBER',
    token,
    invitedBy,
    expiresAt,
  }).returning();

  return toInvitationResult(invitation);
}

export async function acceptInvitation(token: string, userId: string, expectedOrgId?: string) {
  const invitation = await db.query.orgInvitations.findFirst({
    where: eq(orgInvitations.token, token),
  });

  if (!invitation) {
    throw new Error('Invitation not found');
  }

  if (expectedOrgId && invitation.orgId !== expectedOrgId) {
    throw new Error('Invitation not found');
  }

  if (invitation.acceptedAt) {
    throw new Error('Invitation has already been accepted');
  }

  if (invitation.expiresAt < new Date()) {
    throw new Error('Invitation has expired');
  }

  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { email: true },
  });

  if (!user || user.email !== invitation.email) {
    throw new Error('This invitation was sent to a different email address');
  }

  const existingMember = await db.query.orgMembers.findFirst({
    where: and(eq(orgMembers.orgId, invitation.orgId), eq(orgMembers.userId, userId)),
    columns: { id: true },
  });

  if (existingMember) {
    throw new Error('You are already a member of this organization');
  }

  await db.transaction(async (tx) => {
    await tx.insert(orgMembers).values({
      orgId: invitation.orgId,
      userId,
      role: invitation.role === 'OWNER' ? 'MEMBER' : invitation.role,
      invitedBy: invitation.invitedBy,
    });

    await tx.update(orgInvitations)
      .set({ acceptedAt: new Date() })
      .where(eq(orgInvitations.id, invitation.id));
  });

  return { orgId: invitation.orgId };
}

export async function listPendingInvitations(orgId: string) {
  return db.query.orgInvitations.findMany({
    where: and(
      eq(orgInvitations.orgId, orgId),
      isNull(orgInvitations.acceptedAt),
      gt(orgInvitations.expiresAt, new Date()),
    ),
  });
}

export async function revokeInvitation(invitationId: string) {
  await db.delete(orgInvitations).where(eq(orgInvitations.id, invitationId));
}
