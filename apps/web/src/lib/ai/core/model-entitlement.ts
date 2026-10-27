/**
 * The shared pro-model gate for a call that builds its model without a request in hand (workflows, mention replies,
 * agent-to-agent consults): the same entitlement decision a chat turn applies (generation-admission.ts), for the tier
 * of whoever FUNDS the call (WAL-8, POL-8), as the spend resolution names it for `spend`. Read-only: it reserves
 * nothing, so the caller's own credit gate still decides whether the call may spend.
 */
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { resolveEntitlementTier } from '@pagespace/lib/billing/credit-gate';
import type { SpendTarget } from '@pagespace/lib/billing/spend-target';
import { toPersonalSubscriptionTier } from '@pagespace/lib/billing/subscription-tiers';
import { requiresProSubscription } from '@/lib/subscription/rate-limit-middleware';
import { resolveGenerationAdmission, type GenerationAdmission } from './generation-admission';

export const MODEL_ENTITLEMENT_MESSAGES = {
  provider_admin_only: 'This AI provider is restricted to administrators.',
  subscription_required: 'This model is available on paid plans, and whoever pays for this run is not on one.',
} as const;

/** May `userId` run this (provider, model), paid for as `spend` names? */
export async function modelEntitlement(input: {
  userId: string;
  provider: string;
  model: string;
  spend: SpendTarget;
}): Promise<GenerationAdmission> {
  const [user] = await db
    .select({ subscriptionTier: users.subscriptionTier, role: users.role })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1);
  return resolveGenerationAdmission({
    provider: input.provider,
    model: input.model,
    subscriptionTier: await resolveEntitlementTier(input.userId, toPersonalSubscriptionTier(user?.subscriptionTier), input.spend),
    isAdmin: user?.role === 'admin',
    requiresProSubscription,
  });
}
