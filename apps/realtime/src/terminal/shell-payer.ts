/**
 * Who a terminal's compute is charged to (WAL-2, review #2760 P1; pinned by review 5407898542 P2-1).
 *
 * The session's DRIVE's payer through the one seam (WAL-9: the org pool for an org drive), recorded
 * under and capped against THE ACTOR connecting — never the session owner, since a drive session is
 * shared. A global-assistant session (or a vanished drive) attributes to the session owner instead.
 */
import { lookupDriveBillingFacts, resolveSessionPayer } from '@pagespace/lib/billing/sandbox-payer';
import { computeChargeFor } from '@pagespace/lib/billing/compute-charge';
import type { ShellCheckAuthDeps } from './shell-access';

export interface ShellPayerDeps {
  lookupDriveBillingFacts: typeof lookupDriveBillingFacts;
}

export function makeResolveShellPayer(deps: ShellPayerDeps = { lookupDriveBillingFacts }): ShellCheckAuthDeps['resolvePayer'] {
  return async (session, actorId) => {
    const facts = session.driveId === null ? null : await deps.lookupDriveBillingFacts(session.driveId);
    const payer = await resolveSessionPayer({
      driveId: session.driveId,
      ownerId: session.ownerId,
      lookupDriveBillingFacts: async () => facts,
    });
    return { charge: computeChargeFor(payer, actorId), driveId: facts ? session.driveId : null };
  };
}
