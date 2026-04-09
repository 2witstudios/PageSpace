/**
 * Deployment mode detection utilities (server-side).
 *
 * When DEPLOYMENT_MODE=onprem, the application disables cloud-only features
 * (Stripe billing, OAuth, self-registration) and surfaces password auth,
 * local AI providers, and admin-managed user accounts.
 *
 * When DEPLOYMENT_MODE=tenant, the application runs as a managed instance
 * where billing is handled by the control plane. All users get business-tier
 * features. Cloud-only routes (Stripe, OAuth) are blocked like on-prem.
 *
 * All changes are inert unless the env var is explicitly set.
 */

export function isOnPrem(): boolean {
  return process.env.DEPLOYMENT_MODE === 'onprem';
}

export function isTenantMode(): boolean {
  return process.env.DEPLOYMENT_MODE === 'tenant';
}

export function isCloud(): boolean {
  return !isOnPrem() && !isTenantMode();
}

export function isBillingEnabled(): boolean {
  return isCloud();
}
