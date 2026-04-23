/**
 * Deployment mode detection utilities (server-side).
 *
 * Three modes via DEPLOYMENT_MODE env var:
 *
 *   cloud  (default) — SaaS at pagespace.ai. Full feature set.
 *   tenant           — Dedicated-image cloud deployment (own postgres/realtime/processor
 *                      per tenant). Identical feature set to cloud; differs only in
 *                      infrastructure topology and billing path (control plane, not Stripe).
 *   onprem           — Self-hosted. Restricts cloud integrations: no Google Calendar,
 *                      no external AI providers (only ollama/lmstudio/azure_openai),
 *                      no OAuth login, no Stripe, no self-registration. Password auth only.
 *
 * Guard selection:
 *   isOnPrem()        — gate cloud integrations (Calendar, AI providers). Tenant keeps them.
 *   isBillingEnabled() — gate subscription/billing UI. False for both onprem and tenant.
 *   Never use !isCloud() to gate integrations — it incorrectly restricts tenant.
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
