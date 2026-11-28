import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { users } from '@pagespace/db/schema/auth';
import { computeTierForDrive } from '@pagespace/lib/billing/sandbox-eligibility';
import { isOrgLapsedForDrive } from '@pagespace/lib/organizations/status';
import { toPersonalSubscriptionTier } from '@pagespace/lib/billing/subscription-tiers';
import { checkAgentSessionConcurrency, type CheckAgentSessionConcurrencyInput } from '@pagespace/lib/services/sandbox/quota';

/** Resolve entitlement from the session resource while counting the session owner's allocation. */
export async function checkSessionConcurrency(input: Omit<CheckAgentSessionConcurrencyInput, 'tier'> & {
  session: { driveId: string | null; ownerId: string };
}) {
  const drive = input.session.driveId
    ? await db.query.drives.findFirst({ where: eq(drives.id, input.session.driveId), columns: { ownerId: true, orgId: true } })
    : undefined;
  if (input.session.driveId && !drive) return { allowed: false as const, reason: 'tier_ineligible' as const };
  const payer = await db.query.users.findFirst({ where: eq(users.id, drive?.ownerId ?? input.session.ownerId), columns: { subscriptionTier: true } });
  return checkAgentSessionConcurrency({ ...input, tier: computeTierForDrive(drive, toPersonalSubscriptionTier(payer?.subscriptionTier), await isOrgLapsedForDrive(drive)) });
}
