import {
  db,
  eq,
  and,
  orgMembers,
  orgInvitations,
  users,
} from '@pagespace/db';
import { createId } from '@paralleldrive/cuid2';

// ============================================================================
// Types
// ============================================================================

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

// ============================================================================
// Invitation Flow
// ============================================================================

export async function createInvitation(
  orgId: string,
  invitedBy: string,
  input: InviteInput
): Promise<InvitationResult> {
  // Check if user is already a member
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

  // Check for existing invitation
  const now = new Date();
  const existingInvitation = await db.query.orgInvitations.findFirst({
    where: and(
      eq(orgInvitations.orgId, orgId),
      eq(orgInvitations.email, input.email),
    ),
  });

  // Block only active pending invitations (not expired, not accepted)
  if (existingInvitation && !existingInvitation.acceptedAt && existingInvitation.expiresAt > now) {
    throw new Error('An invitation has already been sent to this email');
  }

  // 7-day expiry
  const expiresAt = new Date(now);
  expiresAt.setDate(expiresAt.getDate() + 7);

  const token = createId();

  // Update existing row (expired or accepted) instead of inserting a duplicate
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

    return {
      id: invitation.id,
      orgId: invitation.orgId,
      email: invitation.email,
      role: invitation.role,
      token: invitation.token,
      expiresAt: invitation.expiresAt,
    };
  }

  const [invitation] = await db.insert(orgInvitations).values({
    orgId,
    email: input.email,
    role: input.role ?? 'MEMBER',
    token,
    invitedBy,
    expiresAt,
  }).returning();

  return {
    id: invitation.id,
    orgId: invitation.orgId,
    email: invitation.email,
    role: invitation.role,
    token: invitation.token,
    expiresAt: invitation.expiresAt,
  };
}

export async function acceptInvitation(token: string, userId: string) {
  const invitation = await db.query.orgInvitations.findFirst({
    where: eq(orgInvitations.token, token),
  });

  if (!invitation) {
    throw new Error('Invitation not found');
  }

  if (invitation.acceptedAt) {
    throw new Error('Invitation has already been accepted');
  }

  if (invitation.expiresAt < new Date()) {
    throw new Error('Invitation has expired');
  }

  // Verify user email matches invitation
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { email: true },
  });

  if (!user || user.email !== invitation.email) {
    throw new Error('This invitation was sent to a different email address');
  }

  // Check not already a member
  const existingMember = await db.query.orgMembers.findFirst({
    where: and(eq(orgMembers.orgId, invitation.orgId), eq(orgMembers.userId, userId)),
    columns: { id: true },
  });

  if (existingMember) {
    throw new Error('You are already a member of this organization');
  }

  // Add member and mark invitation accepted atomically
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
  const invitations = await db.query.orgInvitations.findMany({
    where: and(
      eq(orgInvitations.orgId, orgId),
    ),
  });

  return invitations.filter(inv => !inv.acceptedAt && inv.expiresAt > new Date());
}

export async function revokeInvitation(invitationId: string) {
  await db.delete(orgInvitations).where(eq(orgInvitations.id, invitationId));
}
