/**
 * Provider/model ENTITLEMENT, as one pure decision (issue #2204 follow-up, F4).
 *
 * Two independent gates, and they are not interchangeable:
 *
 *  • ADMIN-ONLY PROVIDERS — a block on ROLE. No upgrade helps, so the denial
 *    must never be phrased as one.
 *  • PAID-TIER MODELS — a block on TIER, which an upgrade does lift.
 *
 * Both used to live inline in `chat/route.ts` (and again in the /v1 route, and
 * again at the settings PATCH boundary), which is precisely why the headless
 * dispatch path shipped without either: a free, non-admin collaborator could
 * invoke a machine page configured with a paid or admin-only provider through
 * `send_session` and be billed at that rate. Entitlement is a property of
 * (provider, model, who is asking), not of which transport asked, so it is
 * decided HERE and the transports only translate the answer into their own
 * response shape.
 */

import { ADMIN_ONLY_PROVIDERS } from './ai-providers-config';

export type GenerationAdmissionDenial =
  /** The provider is administrator-only. Role, not tier — do not offer an upgrade. */
  | 'provider_admin_only'
  /** The model is outside the actor's subscription tier. An upgrade lifts this. */
  | 'subscription_required';

export type GenerationAdmission =
  | { allowed: true }
  | { allowed: false; reason: GenerationAdmissionDenial };

/**
 * May this actor run this (provider, model)?
 *
 * `requiresProSubscription` is injected rather than imported because it reads
 * deployment mode (`isBillingEnabled`) — an effect. Callers pass the real one;
 * tests pass a function.
 */
export function resolveGenerationAdmission(input: {
  provider: string;
  model: string | undefined;
  subscriptionTier: string | undefined;
  isAdmin: boolean;
  requiresProSubscription: (
    provider: string,
    model: string | undefined,
    subscriptionTier: string | undefined,
    isAdmin: boolean,
  ) => boolean;
}): GenerationAdmission {
  const { provider, model, subscriptionTier, isAdmin } = input;

  // Role first: an admin-only provider is refused for a non-admin whatever
  // their tier, and reporting it as a subscription problem would send a paying
  // user to a checkout page that cannot fix it.
  if (ADMIN_ONLY_PROVIDERS.has(provider) && !isAdmin) {
    return { allowed: false, reason: 'provider_admin_only' };
  }

  if (input.requiresProSubscription(provider, model, subscriptionTier, isAdmin)) {
    return { allowed: false, reason: 'subscription_required' };
  }

  return { allowed: true };
}
