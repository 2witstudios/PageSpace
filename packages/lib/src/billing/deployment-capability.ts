import { getDeploymentMode, type DeploymentMode } from '../deployment-mode';
import { toPersonalSubscriptionTier, type SubscriptionTier } from './subscription-tiers';

/** Capability only: never persist this as a personal subscription or use it to mint credit. */
export const DEPLOYMENT_CAPABILITY_TIER: SubscriptionTier = 'business';

/** Billing-disabled installations retain finite feature limits without synthetic subscriptions. */
export function deploymentCapabilityTier(tier: SubscriptionTier, mode: DeploymentMode): SubscriptionTier {
  return mode === 'cloud' ? tier : DEPLOYMENT_CAPABILITY_TIER;
}

/** Normalize a personal billing record before resolving the running deployment's feature capability. */
export function resolvePersonalCapabilityTier(tier: string | null | undefined): SubscriptionTier {
  return deploymentCapabilityTier(toPersonalSubscriptionTier(tier), getDeploymentMode());
}
