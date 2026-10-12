/**
 * automation-attribution — which automation a call's spend is listed under (Spec SPEND-10).
 *
 * PURE. A run no person is present for (a cron, a trigger, a scheduled workflow) spends the drive
 * wallet on behalf of its creator ([D-OW-34]), so its usage is recorded as that person; the
 * workflow id recorded beside it lets the drive lead see that spend as the automation rather than
 * merged into the creator. A person's action — a manual Run, a channel mention — and a person's own
 * call are theirs (SPEND-6) and name no automation.
 */

import type { SpendTarget } from './spend-target';

export function automationWorkflowIdFor(target: SpendTarget, workflowId: string | null | undefined): string | undefined {
  if (target.kind !== 'automation' || target.personPresent === true) return undefined;
  return typeof workflowId === 'string' && workflowId.length > 0 ? workflowId : undefined;
}
