/**
 * Runs a create-organization setup plan once the org is paid: move the chosen drives in, turn on automatic
 * seats when the invitations pass the included seats, then invite (planOrgSetup decides the order). Shared
 * by the create dialog and the hub's "Finish setup", so both do exactly the same thing. Returns the failures
 * as copy, never as server text.
 */
import { orgPlanQuote } from '@pagespace/lib/billing/org-plan-quote';
import { inviteToOrg, moveDriveIntoOrg, setOrgSeatAutoAdd } from './org-api';
import { orgErrorMessage } from './org-error-copy';
import { planOrgSetup, type OrgSetupTask } from './create-org-flow';
import type { PendingOrgSetup } from './pending-setup';

export async function runOrgSetup(orgId: string, plan: PendingOrgSetup, isCancelled: () => boolean = () => false): Promise<string[]> {
  const tasks = planOrgSetup({ driveIds: plan.driveIds, invites: plan.invites, selfEmail: plan.selfEmail, includedSeats: orgPlanQuote(0).includedSeats });
  const failures: string[] = [];
  const label = (task: OrgSetupTask) =>
    task.kind === 'move_drive' ? `Moving ${plan.driveNames[task.driveId] ?? 'a drive'}` : task.kind === 'invite' ? `Inviting ${task.email}` : 'Turning on automatic seats';
  for (const task of tasks) {
    if (isCancelled()) break;
    try {
      if (task.kind === 'move_drive') await moveDriveIntoOrg(task.driveId, orgId);
      else if (task.kind === 'enable_auto_seats') await setOrgSeatAutoAdd(orgId, true);
      else await inviteToOrg(orgId, { email: task.email });
    } catch (err) {
      failures.push(`${label(task)}: ${orgErrorMessage(err, 'it did not go through.')}`);
    }
  }
  return failures;
}
