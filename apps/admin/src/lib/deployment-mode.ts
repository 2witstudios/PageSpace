// Client-safe deployment-mode check (server code imports @pagespace/lib/deployment-mode).
export function isOnPrem(): boolean {
  return process.env.NEXT_PUBLIC_DEPLOYMENT_MODE === 'onprem';
}

// Client-safe mirror of lib's isBillingEnabled(): billing exists only in cloud (not onprem, not tenant).
export function isBillingEnabled(): boolean {
  const mode = process.env.NEXT_PUBLIC_DEPLOYMENT_MODE;
  return mode !== 'onprem' && mode !== 'tenant';
}
