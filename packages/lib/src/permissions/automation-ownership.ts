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
import type { OrgApiErrorCode } from '../organizations/api-error-codes';

/**
 * The machine code of an owner-left refusal, as the routes answer it (UI-7). Each is a registered
 * OrgApiErrorCode: RegisteredCode's constraint makes tsc reject an unregistered literal.
 */
type RegisteredCode<C extends OrgApiErrorCode> = C;

/** The body code of the 409 on re-enabling an owner-left automation, and the run-skip reason. */
export const AUTOMATION_OWNER_LEFT_CODE: RegisteredCode<'owner_left'> = 'owner_left';

/** The run error, task-trigger lastFireError and webhook lastFireError an owner-left automation records. */
export const AUTOMATION_OWNER_LEFT_ERROR =
  'Automation skipped: owner_left (its creator left the organization or deleted their account; an Owner or Admin must reassign or delete it)';

export interface AutomationOwnership {
  createdBy: string | null;
  ownerLeftAt: Date | null;
}

export type AutomationRunOwner =
  | { runs: true; ownerId: string }
  | { runs: false; reason: typeof AUTOMATION_OWNER_LEFT_CODE; error: string };

/** The person an automation runs as, or why it must not run. A cleared creator is a missing person. */
export function automationRunOwner(automation: AutomationOwnership): AutomationRunOwner {
  if (automation.ownerLeftAt !== null || automation.createdBy === null) {
    return { runs: false, reason: AUTOMATION_OWNER_LEFT_CODE, error: AUTOMATION_OWNER_LEFT_ERROR };
  }
  return { runs: true, ownerId: automation.createdBy };
}

/** The run error when an automation was reassigned between its scheduling and its claim. */
export const AUTOMATION_OWNER_CHANGED_ERROR =
  'Automation skipped: owner_changed (it was reassigned after this run was scheduled; its next run is the new owner\'s)';

export type ClaimedRunOwner = AutomationRunOwner | { runs: false; reason: 'owner_changed'; error: string };

/**
 * The owner a CLAIMED run may proceed as (review #2831 P2-2): the workflow's owner read fresh at claim time
 * must be the person the run was scheduled and gated as (`scheduledAs`). A run composed from a poller's
 * stale row whose workflow has since been reassigned is skipped, never run as the old creator; the next run
 * is the new owner's. `scheduledAs` null skips the comparison, for a source that runs as someone other than
 * the workflow's creator by design (a calendar trigger runs as its scheduler).
 */
export function claimedRunOwner(automation: AutomationOwnership, scheduledAs: string | null): ClaimedRunOwner {
  const owner = automationRunOwner(automation);
  if (!owner.runs || scheduledAs === null || owner.ownerId === scheduledAs) return owner;
  return { runs: false, reason: 'owner_changed', error: AUTOMATION_OWNER_CHANGED_ERROR };
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

/** Every refusal the owner-left admin path answers; each must be a registered OrgApiErrorCode (UI-7). */
export const OWNER_LEFT_AUTOMATION_REFUSALS = [
  'not_member',
  'not_found',
  'insufficient_role',
  'owner_present',
  'new_owner_not_member',
  'new_owner_no_drive_access',
] as const satisfies readonly OrgApiErrorCode[];

type Refusal<C extends (typeof OWNER_LEFT_AUTOMATION_REFUSALS)[number]> = RegisteredCode<C>;

export type OwnerLeftAutomationDecision =
  | { ok: true }
  | { ok: false; status: 404; reason: Refusal<'not_member' | 'not_found'> }
  | { ok: false; status: 403; reason: Refusal<'insufficient_role'> }
  | { ok: false; status: 409; reason: Refusal<'owner_present'> }
  | { ok: false; status: 400; reason: Refusal<'new_owner_not_member' | 'new_owner_no_drive_access'> };

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
