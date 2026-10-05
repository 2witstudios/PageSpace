/**
 * Who an automation runs as, and who may act on one whose owner left ([D-OW-36], SPEND-6).
 *
 * An automation (a workflow with its schedule, task triggers, calendar triggers and webhook wiring,
 * or a page webhook) runs on behalf of its CREATOR ([D-OW-34]). When that person leaves the org or
 * deletes their account, an org drive's automations are not deleted: they are disabled and flagged
 * `ownerLeftAt`, and the creator column is cleared when the account goes (ON DELETE SET NULL). Nothing
 * runs under a missing person, so every executor asks automationRunOwner first, before any hold.
 *
 * An org Owner or Admin reassigns a flagged automation to an accepted member who can reach its drive
 * (whose caps then bind it, [D-OW-34]) or deletes it. Pure: the role, membership and drive facts come
 * from the caller (organizations/automation-ownership.ts).
 */
import type { OrgRole } from '@pagespace/db/schema/organizations';
import { decideOrgRole } from '../organizations/authorize';

/** The run error, task-trigger lastFireError and webhook lastFireError an owner-left automation records. */
export const AUTOMATION_OWNER_LEFT_ERROR =
  'Automation skipped: owner_left (its creator left the organization or deleted their account; an Owner or Admin must reassign or delete it)';

export interface AutomationOwnership {
  createdBy: string | null;
  ownerLeftAt: Date | null;
}

export type AutomationRunOwner =
  | { runs: true; ownerId: string }
  | { runs: false; reason: 'owner_left'; error: string };

/** The person an automation runs as, or why it must not run. A cleared creator is a missing person. */
export function automationRunOwner(automation: AutomationOwnership): AutomationRunOwner {
  if (automation.ownerLeftAt !== null || automation.createdBy === null) {
    return { runs: false, reason: 'owner_left', error: AUTOMATION_OWNER_LEFT_ERROR };
  }
  return { runs: true, ownerId: automation.createdBy };
}

export type CreatorDepartureReason = 'left_org' | 'account_deleted';

/**
 * What happens to a departing creator's automation in a drive. An org drive's is disabled and flagged
 * for an admin. A personal drive's keeps the behaviour it had before [D-OW-36]: it goes with the
 * account (the creator column cascaded), and leaving an org never reaches it.
 */
export function departedCreatorDisposition(
  drive: { orgId: string | null },
  reason: CreatorDepartureReason,
): 'disable' | 'delete' | 'keep' {
  if (drive.orgId !== null) return 'disable';
  return reason === 'account_deleted' ? 'delete' : 'keep';
}

export type OwnerLeftAutomationAction =
  | { kind: 'delete' }
  /** The proposed new owner's standing in the automation's org and drive; null when they are no user at all. */
  | { kind: 'reassign'; newOwner: { isOrgMember: boolean; isDriveMember: boolean } | null };

export type OwnerLeftAutomationDecision =
  | { ok: true }
  | { ok: false; status: 404; reason: 'not_member' | 'not_found' }
  | { ok: false; status: 403; reason: 'insufficient_role' }
  | { ok: false; status: 409; reason: 'owner_present' }
  | { ok: false; status: 400; reason: 'new_owner_not_member' | 'new_owner_no_drive_access' };

/**
 * May `actorRole` (their accepted role in `orgId`, null for none) reassign or delete this automation?
 * Admin+ only, decided before anything about the automation is revealed. The automation must be in one
 * of this org's drives and flagged owner-left: a live owner's automation is theirs, not this path's.
 * A new owner must be an accepted org member (a guest or a pending invitee holds no seat) and an
 * effective member of the drive, since the automation will read and spend there as them.
 */
export function decideOwnerLeftAutomationAction(input: {
  actorRole: OrgRole | null;
  orgId: string;
  automation: { orgId: string | null; ownerLeftAt: Date | null } | null;
  action: OwnerLeftAutomationAction;
}): OwnerLeftAutomationDecision {
  const role = decideOrgRole({ membershipRole: input.actorRole, minRole: 'ADMIN' });
  if (!role.ok) return role;
  if (input.automation === null || input.automation.orgId !== input.orgId) return { ok: false, status: 404, reason: 'not_found' };
  if (input.automation.ownerLeftAt === null) return { ok: false, status: 409, reason: 'owner_present' };
  if (input.action.kind === 'reassign') {
    const { newOwner } = input.action;
    if (newOwner === null || !newOwner.isOrgMember) return { ok: false, status: 400, reason: 'new_owner_not_member' };
    if (!newOwner.isDriveMember) return { ok: false, status: 400, reason: 'new_owner_no_drive_access' };
  }
  return { ok: true };
}
