/**
 * Deployment mode detection utilities (client-side).
 *
 * Uses NEXT_PUBLIC_DEPLOYMENT_MODE which is inlined at build time by Next.js.
 * For server-side code, import from '@pagespace/lib' instead.
 */

export function isOnPrem(): boolean {
  return process.env.NEXT_PUBLIC_DEPLOYMENT_MODE === 'onprem';
}

export function isTenantMode(): boolean {
  return process.env.NEXT_PUBLIC_DEPLOYMENT_MODE === 'tenant';
}

export function isCloud(): boolean {
  return !isOnPrem() && !isTenantMode();
}

export function isBillingEnabled(): boolean {
  return isCloud();
}
