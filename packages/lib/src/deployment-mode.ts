/**
 * Deployment mode detection utilities (server-side).
 *
 * When DEPLOYMENT_MODE=onprem, the application disables cloud-only features
 * (Stripe billing, OAuth, self-registration) and surfaces password auth,
 * local AI providers, and admin-managed user accounts.
 *
 * All changes are inert unless the env var is explicitly set.
 */

export function isOnPrem(): boolean {
  return process.env.DEPLOYMENT_MODE === 'onprem';
}

export function isCloud(): boolean {
  return !isOnPrem();
}
