/**
 * invite-choice — the guest-or-seat choice when someone is invited to an org drive (Spec UI-5,
 * DRV-8, POL-2, SEAT-3; canvas v9 InviteToDrive). A person already in the org is a plain invite;
 * an outsider joins either as a GUEST of this drive (no seat, gated by the org's Guests policy)
 * or as a MEMBER of the org (an org invitation, which holds a seat).
 *
 * PURE and client-safe.
 */
import type { GuestPolicy } from './policies-core';

export type InviteeStanding = 'in_org' | 'outsider';

/** Whether the invitee is already an accepted member of the drive's org, by account or by email. */
export function inviteeStanding(invitee: { userId?: string | null; email?: string | null }, members: readonly { userId: string; email: string }[]): InviteeStanding {
  const email = invitee.email?.trim().toLowerCase() ?? null;
  const inOrg = members.some((m) => (invitee.userId && m.userId === invitee.userId) || (email !== null && m.email.trim().toLowerCase() === email));
  return inOrg ? 'in_org' : 'outsider';
}

/** The guest choice under the org's Guests policy; `null` when the inviter cannot read the policy. */
export function guestChoice(input: { driveName: string; orgName: string; guestPolicy: GuestPolicy | null }): { enabled: boolean; needsApproval: boolean; hint: string } {
  const base = `No seat. Only sees ${input.driveName}.`;
  switch (input.guestPolicy) {
    case 'off':
      return { enabled: false, needsApproval: false, hint: `Guests are turned off for ${input.orgName}.` };
    case 'approve':
      return { enabled: true, needsApproval: true, hint: `${base} Needs approval from a ${input.orgName} admin under the Guests policy.` };
    case 'on':
      return { enabled: true, needsApproval: false, hint: base };
    default:
      return { enabled: true, needsApproval: false, hint: `${base} May need approval from a ${input.orgName} admin.` };
  }
}

/** The member choice: an org invitation by email, which holds a seat (SEAT-3). */
export function seatChoice(input: { orgName: string; hasEmail: boolean }): { enabled: boolean; hint: string } {
  if (!input.hasEmail) return { enabled: false, hint: `Invite them by email to give them a seat in ${input.orgName}.` };
  return { enabled: true, hint: `Uses a seat in ${input.orgName}. Can open every Open drive and be added to any other.` };
}
